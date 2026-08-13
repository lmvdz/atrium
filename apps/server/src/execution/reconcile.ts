import type { Database } from '@atrium/db';
import { coreEvents, sessions, users } from '@atrium/db/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { CommandService } from '../commands.js';
import type { Logger } from '../logger.js';
import type { Session } from '../session.js';

/**
 * STARTUP RECONCILIATION FOR WEDGED SESSIONS (#120 round-3 F5).
 *
 * ## The state this exists to end
 *
 * `open_session` increments `plans.authorized_draws` in the same transaction it
 * writes the session row. That increment is the SPEND: it is the count the budget
 * gate checks a plan's human-set slice against, and it never decrements. The
 * matching receipt is the session's exit event.
 *
 * Between those two facts sits a process. Round 2's gauntlet found there was
 * nothing at either end of its life that guaranteed the second one happened:
 *
 *  - Executions were detached and untracked. `SIGTERM` mid-harness closed the
 *    database and deleted the scratch repo out from under a run that was still
 *    going. No settle was ever attempted.
 *  - Startup did nothing about what the last process left behind. An `open`
 *    session with no live execution simply stayed `open`, forever, holding a draw
 *    the plan can never get back and showing a room a session that is still
 *    working when nothing is.
 *
 * A crash, an OOM kill, or a `docker compose down` is not an exotic case; it is
 * Tuesday. So a granted draw gets its receipt on the way out (`drainExecutions`
 * in `configure.ts`, awaited by the shutdown path) and, failing that, on the way
 * back in — here.
 *
 * ## Why "open at startup" is a safe predicate — ONLY when this process owns execution
 *
 * An execution lives in the process that started it. Nothing survives a restart:
 * there is no execution to wait for, no handle to re-attach to, and the scratch
 * worktree the harness was running in was on a path the last process controlled.
 * So — WHEN THIS DEPLOYMENT RUNS EXECUTION — an `open` session at startup is by
 * definition one with no live execution. It gets the exit receipt it is owed
 * (`session_failed`, artifact `null`, an exit summary that says what happened)
 * rather than a fabricated clean one, because a run that was killed did not settle
 * and this seam does not pretend otherwise.
 *
 * ## When execution is DISABLED, "open at startup" means nothing of the sort (#120 round-4 F3)
 *
 * `EXECUTION_PROVIDER` unset is a supported, documented mode: a session opens and
 * settles when something EXTERNAL settles it (`configure.ts`). In that mode this
 * process never started an execution and holds no evidence about any `open`
 * session — an `open` row is a LIVE session waiting on an outside settler, not a
 * dead one. Force-failing it would destroy a live external settle and fabricate a
 * `session_failed` for a run that is still going. So reconciliation only fires
 * when this process OWNS execution; with execution disabled it does nothing and
 * leaves every `open` session alone. The cross-boot wedge this leaves — a session
 * opened by an execution-enabled boot, then rebooted with execution disabled —
 * stays open until an execution-enabled boot reconciles it, which is the honest
 * cost of not being able to tell it apart from a live external session.
 *
 * ## It settles AS THE OPENER, through the ordinary command path
 *
 * F3 made a session's exit its opener's to write. This does not carve an
 * exception out of that: it reconstructs the opener's `Session` from the durable
 * record (`sessions.opened_by_event_id` → `core_events.actor_id`, and that user's
 * `principal_kind`) and appends through the same `CommandService` a live settle
 * uses. One path, one set of gates, one refusal shape — a reconciliation that
 * bypassed the owner check would be exactly the adjacent-path bypass F3 closes.
 *
 * The honest cost of that choice: if the opener has since lost membership in the
 * room, the append is refused and the session stays open. That is logged loudly,
 * per session, and left — inventing a system actor with authority to write any
 * room's receipts would be a larger hole than the one it patched.
 */

/** What one pass did. Returned so a test — and the boot log — can assert on it. */
export interface ReconciliationResult {
  /** Sessions found `open` with no live execution. */
  readonly found: number;
  /** Of those, the ones driven to `session_failed`. */
  readonly failed: number;
  /** Of those, the ones that could not be settled (logged individually). */
  readonly unreconciled: number;
}

export interface ReconcileOptions {
  db: Database;
  commands: CommandService;
  logger: Logger;
  /**
   * Does THIS process own execution (#120 round-4 F3)? True only when an
   * execution provider is configured this boot. When false, reconciliation is a
   * no-op: an `open` session belongs to an external settler, not to a dead
   * execution this process could speak for, and force-failing it would destroy a
   * live settle. `index.ts` passes `executionRuntime !== null`.
   */
  executionEnabled: boolean;
  /** Overridable so a test can assert the prose without pinning a date. */
  reason?: string;
}

const DEFAULT_REASON =
  'execution did not survive the previous process — the session was left open with its draw ' +
  'already authorized, and is failed here so the plan holds a receipt rather than a wedge';

/**
 * Drive every `open` session with a spent draw to a terminal state. Call ONCE,
 * at startup, before the server begins accepting traffic.
 */
export async function reconcileWedgedSessions(
  options: ReconcileOptions,
): Promise<ReconciliationResult> {
  const { db, commands, logger } = options;
  const reason = options.reason ?? DEFAULT_REASON;

  // Execution disabled ⇒ this process owns no execution and cannot honestly
  // declare any `open` session dead (#120 round-4 F3). Do nothing — an external
  // settler still owns those rows.
  if (!options.executionEnabled) {
    logger.info('skipping session reconciliation — execution is disabled this boot', {});
    return { found: 0, failed: 0, unreconciled: 0 };
  }

  // Every open session, with the actor that opened it and that actor's principal
  // kind. `openedByEventId` is NOT NULL in practice (the projection sets it) but
  // is nullable in the schema, so the join is a left join and a row that cannot
  // name its opener is reported rather than silently skipped.
  const wedged = await db
    .select({
      sessionId: sessions.id,
      roomId: sessions.roomId,
      openerId: coreEvents.actorId,
      principalKind: users.principalKind,
    })
    .from(sessions)
    .leftJoin(coreEvents, eq(coreEvents.id, sessions.openedByEventId))
    // `users.id` is `uuid` and `core_events.actor_id` is `text` — the column is
    // deliberately wider than a user id, because it also holds a MODEL id and is
    // NULL for the system actor (see the `core_events` table doc). So the join is
    // cast on the `uuid` side, not the text one: casting `actor_id` to uuid would
    // throw on the very rows this is supposed to skip.
    .leftJoin(users, sql`${users.id}::text = ${coreEvents.actorId}`)
    .where(and(eq(sessions.status, 'open'), isNotNull(sessions.openedByEventId)));

  if (wedged.length === 0) return { found: 0, failed: 0, unreconciled: 0 };

  logger.warn('reconciling sessions left open by a previous process', { count: wedged.length });

  let failed = 0;
  let unreconciled = 0;
  for (const row of wedged) {
    if (row.openerId === null || row.principalKind === null) {
      unreconciled++;
      logger.error('cannot reconcile a session whose opener is unresolvable', {
        sessionId: row.sessionId,
        roomId: row.roomId,
      });
      continue;
    }
    const opener: Session = { userId: row.openerId, principalKind: row.principalKind };
    try {
      const settled = await commands.execute(opener, {
        name: 'settle_session',
        roomId: row.roomId,
        sessionId: row.sessionId,
        outcome: 'failed',
        exitSummary: reason,
        spendMicros: null,
        contextPct: null,
        // NEVER an artifact. Whatever the killed run left behind was never
        // pushed, verified, or pinned, so there is nothing this may honestly
        // index — and a reconciler is the last place that should be minting a
        // claim about work nobody observed finish.
        artifact: null,
      });
      if (settled.kind !== 'appended') throw new Error(`settle returned ${settled.kind}`);
      failed++;
    } catch (error) {
      unreconciled++;
      logger.error('failed to reconcile a wedged session — it stays open', {
        sessionId: row.sessionId,
        roomId: row.roomId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('session reconciliation complete', { found: wedged.length, failed, unreconciled });
  return { found: wedged.length, failed, unreconciled };
}
