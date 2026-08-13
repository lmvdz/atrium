import type { Database } from '@atrium/db';
import { coreEvents, sessions, users } from '@atrium/db/schema';
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
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
 * ## "Open at startup" is NOT enough — the lease is (#120 round-5 F4)
 *
 * Round 4 keyed this on a single boot flag: reconcile every `open` session iff
 * `EXECUTION_PROVIDER` is set this boot. That flag is a process-global proxy for a
 * PER-SESSION question — does a LIVE local execution own THIS session? — and the
 * gauntlet broke it two ways the flag cannot see:
 *
 *   * **disabled→enabled.** A session opened while execution was DISABLED (the
 *     documented external-settle mode) is a LIVE session waiting on an outside
 *     settler. Reboot with a provider set and the flag reads "reconcile every open
 *     session", force-failing that live external settle and fabricating a receipt.
 *   * **two concurrent instances.** Each boot's flag is true, so each force-fails
 *     the OTHER instance's still-running sessions.
 *
 * So this no longer asks the flag. It asks the LEASE (`sessions.execution_owner` /
 * `execution_heartbeat_at`, set by the coordinator when it claims a session):
 *
 *   * A session with NO owner (`execution_owner IS NULL`) is an external-settle
 *     session no local execution ever ran. It is NEVER reconciled — no flag, no
 *     boot, no exception. This closes disabled→enabled.
 *   * A session whose owner's heartbeat is FRESH is a live run — this process's or
 *     a concurrent peer's — and is left alone. This closes the two-instance
 *     overlap: a peer that is up and heartbeating keeps its own leases warm.
 *   * A session whose owner's heartbeat has gone STALE is a dead owner's wedge. It,
 *     and only it, gets the exit receipt it is owed (`session_failed`, artifact
 *     `null`, an exit summary that says what happened) rather than a fabricated
 *     clean one.
 *
 * ## The residual, stated honestly
 *
 * Staleness needs a heartbeat to lapse, so a crash-and-restart FASTER than
 * `staleAfterMs` leaves the dead owner's lease looking momentarily live; that
 * wedge is recovered on the next reconcile pass once the lease ages out (the
 * server runs reconciliation on a timer, not only at boot). The alternative —
 * reconciling a young lease immediately — cannot distinguish a fast-restarted
 * dead owner from a live peer, and killing a live peer's session is the worse
 * error. So the lease is honored until it is provably stale.
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
   * A lease whose heartbeat is older than this (ms) belongs to a DEAD owner and
   * is reconciled; a fresher lease is a live owner (this process or a peer) and is
   * left running (#120 round-5 F4). Must be comfortably larger than the heartbeat
   * interval so a live owner's lease never reads as stale between beats.
   */
  staleAfterMs: number;
  /** Overridable clock, so a test can age a lease without waiting on wall time. */
  now?: Date;
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
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - options.staleAfterMs);

  // Every open session with a STALE lease, plus the actor that opened it and that
  // actor's principal kind. The lease predicate is the whole of round-5 F4:
  //
  //   * `execution_owner IS NOT NULL` — a LOCAL execution owns it. An unleased
  //     session is external-settle and is never a wedge this process may fail.
  //   * `execution_heartbeat_at < staleBefore` — the owner has gone silent. A
  //     fresh heartbeat is a live owner (this process or a concurrent peer), whose
  //     session is left running.
  //
  // `openedByEventId` is NOT NULL in practice (the projection sets it) but is
  // nullable in the schema, so the join is a left join and a row that cannot name
  // its opener is reported rather than silently skipped.
  const wedged = await db
    .select({
      sessionId: sessions.id,
      roomId: sessions.roomId,
      openerId: coreEvents.actorId,
      principalKind: users.principalKind,
      // The capability token minted at grant (#120 round-6). A leased (provider)
      // session's terminal requires it; the reconciler is a trusted in-process
      // holder — it reads the token off the row and presents it, exactly as the
      // coordinator presents the token it got from `claim`. A room member never
      // sees this value, so this is not a bypass of the capability, it is a holder
      // of it settling a wedge the owner died before settling.
      authority: sessions.executionAuthority,
    })
    .from(sessions)
    .leftJoin(coreEvents, eq(coreEvents.id, sessions.openedByEventId))
    // `users.id` is `uuid` and `core_events.actor_id` is `text` — the column is
    // deliberately wider than a user id, because it also holds a MODEL id and is
    // NULL for the system actor (see the `core_events` table doc). So the join is
    // cast on the `uuid` side, not the text one: casting `actor_id` to uuid would
    // throw on the very rows this is supposed to skip.
    .leftJoin(users, sql`${users.id}::text = ${coreEvents.actorId}`)
    .where(
      and(
        eq(sessions.status, 'open'),
        isNotNull(sessions.openedByEventId),
        isNotNull(sessions.executionOwner),
        lt(sessions.executionHeartbeatAt, staleBefore),
      ),
    );

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
        // The provider session's capability token, read off the row (#120 r6). A
        // leased session is provider-mode, so its terminal is gated on this; the
        // reconciler holds it legitimately (a wire client never sees it).
        authority: row.authority,
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
