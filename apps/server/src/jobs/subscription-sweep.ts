import type { Database } from '@atrium/db';
import { coreEvents, sessionSubscriptions, sessions, users } from '@atrium/db/schema';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { CommandService } from '../commands.js';
import type { Logger } from '../logger.js';
import type { Session } from '../session.js';

/**
 * THE SUBSCRIPTION EXPIRY SWEEP (#127 fix D).
 *
 * ## The state this exists to end
 *
 * `session_subscribed` mints a durable wait with a MANDATORY `expires_at` — a
 * horizon, so a wait cannot be the forever-open session that blocks #119's
 * plan-settle. But nothing in production ever CROSSED that horizon: `expire_
 * subscription` was a command with no caller, so a wait past its `expires_at`
 * stayed `pending` forever, exactly the wedge the horizon exists to prevent.
 *
 * This is that caller. It mirrors the execution reconcile sweep
 * (`execution/reconcile.ts`): a periodic pass that finds the overdue rows and
 * drives each to its terminal through the ordinary command path — here,
 * `expire_subscription`, which disposes the wait `pending → expired` and raises
 * the agent's owner the honest attention an expired wait is owed (#127 fix B).
 *
 * ## What it sweeps, and as whom
 *
 * Every `pending` subscription whose `expires_at` is in the past. `expire_
 * subscription` re-checks both facts under the append lock, so a wait a `resume`
 * matched between this read and the command is a clean nack, not a double-dispose
 * — the sweep is best-effort and idempotent by construction, the same shape the
 * reconcile sweep has.
 *
 * The command is membership-gated, so it runs AS the session's opener
 * (reconstructed from `sessions.opened_by_event_id → core_events.actor_id` and
 * that user's `principal_kind`), exactly as the reconciler settles as the opener.
 * A row whose opener is unresolvable (no actor to attribute to) is logged and
 * skipped rather than swept — the same honest residual the reconciler states.
 */

/** What one pass did — returned so a test and the boot log can assert on it. */
export interface SubscriptionSweepResult {
  /** Pending subscriptions found past their horizon. */
  readonly found: number;
  /** Of those, the ones driven to `expired`. */
  readonly expired: number;
  /** Of those, the ones that could not be swept (logged individually). */
  readonly unswept: number;
}

export interface SubscriptionSweepOptions {
  db: Database;
  commands: CommandService;
  logger: Logger;
  /** Overridable clock, so a test can sweep without waiting on wall time. */
  now?: Date;
}

/**
 * Drive every pending, past-horizon subscription to `expired`. Best-effort: a
 * per-row failure is logged and the row is left for the next pass, never taking
 * the process down.
 */
export async function sweepExpiredSubscriptions(
  options: SubscriptionSweepOptions,
): Promise<SubscriptionSweepResult> {
  const { db, commands, logger } = options;
  const now = options.now ?? new Date();

  // Every pending subscription past its horizon, plus the actor that opened its
  // session and that actor's principal kind. The join to the opener mirrors the
  // reconcile sweep: `core_events.actor_id` is a text column wider than a user id
  // (it also holds a model id and is NULL for the system actor), so the users
  // join casts on the uuid side, and a row whose opener cannot be resolved is
  // reported rather than silently skipped.
  const overdue = await db
    .select({
      subscriptionId: sessionSubscriptions.id,
      roomId: sessionSubscriptions.roomId,
      openerId: coreEvents.actorId,
      principalKind: users.principalKind,
    })
    .from(sessionSubscriptions)
    .innerJoin(
      sessions,
      and(
        eq(sessions.id, sessionSubscriptions.sessionId),
        eq(sessions.roomId, sessionSubscriptions.roomId),
      ),
    )
    .leftJoin(coreEvents, eq(coreEvents.id, sessions.openedByEventId))
    .leftJoin(users, sql`${users.id}::text = ${coreEvents.actorId}`)
    .where(
      and(eq(sessionSubscriptions.status, 'pending'), lt(sessionSubscriptions.expiresAt, now)),
    );

  if (overdue.length === 0) return { found: 0, expired: 0, unswept: 0 };

  logger.warn('sweeping subscriptions past their horizon', { count: overdue.length });

  let expired = 0;
  let unswept = 0;
  for (const row of overdue) {
    if (row.openerId === null || row.principalKind === null) {
      unswept++;
      logger.error('cannot sweep a subscription whose session opener is unresolvable', {
        subscriptionId: row.subscriptionId,
        roomId: row.roomId,
      });
      continue;
    }
    const opener: Session = { userId: row.openerId, principalKind: row.principalKind };
    try {
      const escalated = await commands.execute(opener, {
        name: 'expire_subscription',
        roomId: row.roomId,
        subscriptionId: row.subscriptionId,
      });
      if (escalated.kind !== 'appended') throw new Error(`expire returned ${escalated.kind}`);
      expired++;
    } catch (error) {
      // A wait a `resume` matched between the read and here is an expected nack,
      // not a failure to shout about — but the sweep cannot tell that apart from a
      // real error cheaply, so it logs at info and lets the count carry it.
      unswept++;
      logger.info('a subscription was not swept — it may have matched or already disposed', {
        subscriptionId: row.subscriptionId,
        roomId: row.roomId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('subscription sweep complete', { found: overdue.length, expired, unswept });
  return { found: overdue.length, expired, unswept };
}
