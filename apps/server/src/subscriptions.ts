import type { Database } from '@atrium/db';
import { agents, plans, sessionSubscriptions, sessions } from '@atrium/db/schema';
import { and, eq, lte } from 'drizzle-orm';
import { CommandError, type Ledger } from './ledger.js';
import type { Logger } from './logger.js';
import { type ProjectionHooks, projectRoomEvent } from './projections.js';
import type { RoomEvent } from './room-events.js';

/**
 * THE EXPIRY SWEEP — a wait that ran out becomes owed ATTENTION (#127, from
 * #123's resolution point 6).
 *
 * ## The state this exists to end
 *
 * A `session_subscribed` holds a session open while it waits. Both blind critics
 * of #123's draft found the same hole in it: the draft gave a subscription no
 * DISPOSITION at all. An unmatched subscribe therefore held its session `open`
 * indefinitely, which meant its plan could never settle (#119 refuses a
 * `settle_plan` while any child session is open) — and nobody was ever told. A
 * campaign quietly stops, and the reason is a row nobody is looking at.
 *
 * So `expiresAt` is mandatory in the event and NOT NULL in the table, and this is
 * the other half: when the horizon passes with nothing matched, the wait is
 * marked `expired` and ESCALATED to the human who owns the agent
 * (`plans.agent_user_id` → `agents.owner_user_id`), as an ordinary
 * `signal_raised` — the escalation-UP verb, unchanged (#123 resolution 7). The
 * wait stops being a silent block and becomes somebody's Needs-you item.
 *
 * ## Why the escalation is a `system` append
 *
 * Nobody asked for it. The sweep is a timer, not a member, and attributing this
 * append to the session's opener would put a room participant's name on a
 * decision no participant made. `system` is the anonymous actor the DB's
 * actor-authorization trigger exempts from the membership rule, and the append is
 * covenant-safe by construction: `signal_raised` writes one `attention_items`
 * row, flips no `~` to a `✓`, and touches no plan's purse.
 *
 * ## Atomicity, and why the claim is inside `authorize`
 *
 * The claim — `UPDATE … SET status='expired' WHERE status='waiting'` — runs in
 * the ledger's `authorize` hook, which is inside the append transaction and under
 * the global advisory lock. So the row is claimed and the escalation is appended
 * in one commit, and two instances sweeping the same subscription cannot both
 * escalate it: the loser's UPDATE matches zero rows and its append is aborted
 * before anything is durable. A subscription that was matched or disposed between
 * the scan and the claim is likewise skipped, not escalated after the fact.
 *
 * Best-effort, one row at a time: a failure on one subscription is logged and the
 * next is still swept, exactly as the execution sweep beside it behaves.
 */
export interface SubscriptionSweepInput {
  readonly db: Database;
  readonly ledger: Ledger;
  readonly logger: Logger;
  readonly projectionHooks?: ProjectionHooks;
  /** The instant to judge `expires_at` against. Injected so a test owns the clock. */
  readonly now?: Date;
}

export interface SubscriptionSweepResult {
  /** Waits found past their horizon and still `waiting`. */
  readonly found: number;
  /** Waits marked `expired` with an escalation appended. */
  readonly escalated: number;
  /** Waits a concurrent writer disposed of first, or whose append failed. */
  readonly skipped: number;
}

export async function sweepExpiredSubscriptions({
  db,
  ledger,
  logger,
  projectionHooks = {},
  now = new Date(),
}: SubscriptionSweepInput): Promise<SubscriptionSweepResult> {
  // The scan is a plain read: nothing is decided here. Every row it returns is
  // re-checked under the lock by the claim below, so a stale scan costs a skipped
  // row and never a wrong escalation.
  const due = await db
    .select({
      id: sessionSubscriptions.id,
      roomId: sessionSubscriptions.roomId,
      sessionId: sessionSubscriptions.sessionId,
      source: sessionSubscriptions.source,
      matcher: sessionSubscriptions.matcher,
      expiresAt: sessionSubscriptions.expiresAt,
      ownerUserId: agents.ownerUserId,
    })
    .from(sessionSubscriptions)
    .innerJoin(
      sessions,
      and(
        eq(sessions.id, sessionSubscriptions.sessionId),
        eq(sessions.roomId, sessionSubscriptions.roomId),
      ),
    )
    .innerJoin(plans, and(eq(plans.id, sessions.planId), eq(plans.roomId, sessions.roomId)))
    .innerJoin(agents, eq(agents.userId, plans.agentUserId))
    .where(
      and(
        eq(sessionSubscriptions.status, 'waiting'),
        lte(sessionSubscriptions.expiresAt, now),
        // A wait whose session already exited was DISPOSED by the exit, not
        // expired, and owes nobody attention — the process it was waiting for has
        // published its receipt. Belt and braces: `projectSessionExit` disposes
        // them in the exit's own transaction, so this predicate should never
        // exclude anything. It is here because "should never" is not a guarantee.
        eq(sessions.status, 'open'),
      ),
    );

  let escalated = 0;
  let skipped = 0;
  for (const subscription of due) {
    try {
      await ledger.append({
        roomId: subscription.roomId,
        // Nobody asked for this. See the header.
        actor: { kind: 'system' },
        authorize: async (tx) => {
          const claimed = await tx
            .update(sessionSubscriptions)
            .set({ status: 'expired', escalatedAt: now, updatedAt: now })
            .where(
              and(
                eq(sessionSubscriptions.id, subscription.id),
                eq(sessionSubscriptions.roomId, subscription.roomId),
                eq(sessionSubscriptions.status, 'waiting'),
              ),
            )
            .returning({ id: sessionSubscriptions.id });
          if (claimed.length === 0) {
            // Somebody else got there first — a resume matched it, an exit
            // disposed it, or a peer instance swept it. Aborting the transaction
            // here is what makes "at most one escalation per wait" true.
            throw new CommandError(
              'conflict',
              `subscription "${subscription.id}" is no longer waiting; nothing to escalate`,
            );
          }
        },
        build: ({ id, at }): RoomEvent => ({
          id,
          at,
          type: 'signal_raised',
          roomId: subscription.roomId,
          // The AGENT'S OWNER — the human accountable for the machine whose wait
          // ran out. Not the agent: escalation is UP, into a person's attention.
          targetUserId: subscription.ownerUserId,
          // The fourth attention subject (#127). The item is about the SESSION
          // that is still open and now waiting on nothing; pointing it at a
          // message standing in for one would misname what is owed.
          subjectKind: 'session',
          subjectId: subscription.sessionId,
          class: 'blocking_question',
          reason: {
            kind: 'subscription_expired',
            source: subscription.source,
            matcher: subscription.matcher,
            expiresAt: subscription.expiresAt.toISOString(),
          },
        }),
        project: (context) => projectRoomEvent(context, projectionHooks),
      });
      escalated += 1;
    } catch (error) {
      skipped += 1;
      logger.warn('an expired subscription was not escalated', {
        subscriptionId: subscription.id,
        roomId: subscription.roomId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { found: due.length, escalated, skipped };
}
