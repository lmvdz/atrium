import { describeUnknown, guardedErrorLog } from '@atrium/auth';
import { interpretations, messages } from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { fromDrizzle, PgBoss } from 'pg-boss';
import {
  type InterpretDeps,
  type InterpretRoomJob,
  type InterpretRunResult,
  markRoomFailed,
  runInterpretation,
} from './jobs/interpret.js';
import type { Tx } from './ledger.js';
import type { Logger } from './logger.js';

/**
 * The pg-boss queue (#16) and the interpretation worker's collar (#8).
 *
 * Three properties this file exists to hold, each of which was a defect first:
 *
 * **1. The enqueue shares the message insert's transaction.** `pg-boss`'s
 * `fromDrizzle` adapter turns a Drizzle transaction into the executor `send`
 * writes its job row through, so `INSERT INTO messages` and `INSERT INTO
 * pgboss.job` either both commit or neither does. Without it there is a window
 * — process dies between the two — in which a message exists that nothing will
 * ever read, silently and forever. #19's gauntlet routed this as
 * "`enqueueInterpretation` has no call site"; the call site is
 * `projections.ts`, inside the append transaction, and the transaction is what
 * makes it worth having.
 *
 * **2. `batchSize` is not concurrency.** The stub passed the concurrency knob
 * to `batchSize`, which is how many jobs one *fetch* returns — a batch is
 * handed to one handler invocation, processed serially, and settled
 * all-or-nothing, so one poison job failed every sibling that happened to be
 * fetched with it. `localConcurrency` is the knob that spawns N independent
 * workers; `batchSize: 1` is what makes each job settle on its own. Also routed
 * out of #19's gauntlet.
 *
 * **3. One provider call per burst.** `singletonKey = roomId` with an explicit
 * `singletonSeconds` window collapses a burst into one job; `startAfter` equal
 * to the same window is the debounce that makes the job run at the *end* of the
 * burst rather than the start of it. pg-boss's dedup silently does nothing
 * without an explicit window (#16's documented footgun), and its uniqueness
 * index covers every non-cancelled state — so a send inside a slot whose job
 * has already finished is *dropped*, not queued. That is why the worker
 * re-counts unread messages before it returns and schedules a follow-up into
 * the **next** slot: coalescing that can silently lose the twelfth message is
 * not coalescing.
 *
 * `groupConcurrency: 1` on the room keeps two passes over one room from
 * overlapping across the whole deployment, so "one call per burst" survives a
 * slow pass as well as a fast one.
 */

export const INTERPRET_QUEUE = 'interpret-room';
export const INTERPRET_DLQ = 'interpret-room-dlq';

/** Payload of an `interpret-room` job. Per room, per #8's coalescing decision. */
export type { InterpretRoomJob } from './jobs/interpret.js';

/**
 * The coalescing window, in seconds — #8's "~10s".
 *
 * It is three things at once and they must be the same number: the singleton
 * slot width, the debounce delay, and the offset a follow-up is pushed by. Two
 * of them drifting apart is a burst that costs two calls.
 */
export const DEFAULT_COALESCE_SECONDS = 10;

export interface QueueOptions {
  databaseUrl: string;
  /**
   * How many jobs this node runs at once — `localConcurrency`, not `batchSize`.
   * Rooms are independent; one room is not, which is what `groupConcurrency`
   * below is for.
   */
  concurrency: number;
  coalesceSeconds?: number;
  retryLimit?: number;
  logger: Logger;
  /**
   * Everything the job needs to actually interpret. Omit it and the queue still
   * starts, registers, and dead-letters — which is what `startQueue` did before
   * #23 — but it will refuse work rather than silently acknowledge it.
   */
  interpretation?: Omit<InterpretDeps, 'enqueueFollowUp' | 'logger'>;
}

export interface QueueHandle {
  boss: PgBoss;
  /**
   * Enqueue a coalesced interpretation pass for a room, **in the caller's
   * transaction**. Pass the transaction that is inserting the message.
   */
  enqueueInterpretation: (tx: Tx, roomId: string) => Promise<string | null>;
  /**
   * Stage a re-interpretation of one message at the next version, in the
   * caller's transaction. The new `interpretations` row is the durable intent;
   * the job is only the wake-up.
   */
  scheduleReinterpretation: (
    tx: Tx,
    input: { roomId: string; messageId: string },
  ) => Promise<{ interpretationId: string; interpretationVersion: number }>;
  /** The last run this process performed, for tests and for `/health` later. */
  lastRun: () => InterpretRunResult | null;
  stop: () => Promise<void>;
}

export async function startQueue({
  databaseUrl,
  concurrency,
  coalesceSeconds = DEFAULT_COALESCE_SECONDS,
  retryLimit = 5,
  logger,
  interpretation,
}: QueueOptions): Promise<QueueHandle> {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    // pg-boss owns its own `pgboss` schema; drizzle owns `public`.
    schema: 'pgboss',
  });

  boss.on('error', (error: unknown) => {
    // An EventEmitter `error` listener that throws is an uncaught exception, and
    // the value here comes from pg-boss and the driver beneath it. Both halves
    // guarded; see `@atrium/auth`'s `errors.ts`.
    guardedErrorLog(logger)('pg-boss error', () => ({ error: describeUnknown(error) }));
  });

  await boss.start();
  await boss.createQueue(INTERPRET_DLQ);
  await boss.createQueue(INTERPRET_QUEUE, {
    retryLimit,
    retryBackoff: true,
    deadLetter: INTERPRET_DLQ,
  });

  let lastRun: InterpretRunResult | null = null;

  const enqueueFollowUp = async (roomId: string): Promise<void> => {
    // `singletonNextSlot`, and only here. On the message-insert path it would
    // turn the second message of a burst into a second job — the exact thing
    // the singleton key exists to prevent. Here the current slot is *known* to
    // be spent (this run is the job that occupied it), so the next slot is the
    // only place a follow-up can go.
    await boss.send(
      INTERPRET_QUEUE,
      { roomId },
      {
        singletonKey: roomId,
        singletonSeconds: coalesceSeconds,
        singletonNextSlot: true,
        group: { id: roomId },
      },
    );
  };

  await boss.work<InterpretRoomJob>(
    INTERPRET_QUEUE,
    {
      // ONE job per handler invocation. A batch is settled as a unit, so a
      // batch of twelve rooms fails twelve rooms when one of them throws.
      batchSize: 1,
      // This is the concurrency knob. `batchSize` never was.
      localConcurrency: concurrency,
      // At most one pass per room, deployment-wide. Two overlapping passes over
      // one room would each drain a share of its unread messages and each spend
      // a provider call on it.
      groupConcurrency: 1,
    },
    async (jobs) => {
      for (const job of jobs) {
        const roomId = job.data?.roomId;
        if (typeof roomId !== 'string' || roomId.length === 0) {
          throw new Error(`interpret-room job ${job.id} carries no roomId`);
        }
        if (!interpretation) {
          throw new Error(
            'interpret-room job received with no interpretation dependencies wired — refusing rather than acknowledging work nobody did',
          );
        }
        lastRun = await runInterpretation(
          { ...interpretation, logger, enqueueFollowUp },
          { roomId },
        );
      }
    },
  );

  await boss.work<InterpretRoomJob>(INTERPRET_DLQ, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const roomId = job.data?.roomId;
      if (typeof roomId !== 'string' || roomId.length === 0) {
        logger.error('dead-lettered interpretation job carries no roomId', { jobId: job.id });
        continue;
      }
      // The retries are over. Only now do the claims become `failed`: while a
      // retry could still run, `pending` is how it finds its own work, and
      // flipping earlier would make the retry claim a *new* interpretation id
      // and propose everything twice.
      const failed = interpretation
        ? await markRoomFailed(
            interpretation.db,
            roomId,
            `interpretation dead-lettered after ${retryLimit} attempts (job ${job.id})`,
          )
        : 0;
      logger.error('interpretation dead-lettered', { jobId: job.id, roomId, marked: failed });
    }
  });

  logger.info('queue worker registered', {
    queue: INTERPRET_QUEUE,
    localConcurrency: concurrency,
    coalesceSeconds,
    retryLimit,
    interpreting: Boolean(interpretation),
  });

  return {
    boss,
    enqueueInterpretation: (tx, roomId) => enqueueInterpretation(boss, tx, roomId, coalesceSeconds),
    scheduleReinterpretation: async (tx, { roomId, messageId }) => {
      const staged = await stageReinterpretation(tx, messageId);
      await enqueueInterpretation(boss, tx, roomId, coalesceSeconds);
      return staged;
    },
    lastRun: () => lastRun,
    stop: async () => {
      await boss.stop({ graceful: true, timeout: 10_000 });
      logger.info('queue stopped');
    },
  };
}

/**
 * The transactional enqueue.
 *
 * `fromDrizzle(tx, sql)` is pg-boss's own adapter: the job row is written by the
 * caller's transaction, so it commits with the message or not at all. A crash
 * between the two is not a state this can reach — there is no "between".
 */
export function enqueueInterpretation(
  boss: PgBoss,
  tx: Tx,
  roomId: string,
  coalesceSeconds: number = DEFAULT_COALESCE_SECONDS,
): Promise<string | null> {
  return boss.send(
    INTERPRET_QUEUE,
    { roomId },
    {
      // One job per room per slot — the coalescing key.
      singletonKey: roomId,
      // Explicit, because pg-boss's dedup silently no-ops without it (#16).
      singletonSeconds: coalesceSeconds,
      // And the debounce: run at the end of the burst, not at the start.
      startAfter: coalesceSeconds,
      group: { id: roomId },
      db: fromDrizzle(tx, sql),
    },
  );
}

/**
 * Stage the next interpretation version of a message.
 *
 * The row is the intent, and the `(message_id, interpretation_version)` unique
 * index is what makes staging it twice a no-op rather than a second pass. The
 * worker treats "newest version is pending" as unread, so this is all it takes
 * to have a message re-read — and because the row carries the version, the
 * proposals the new run mints are addressed to a different interpretation id
 * from the old ones, which is what lets them supersede rather than collide.
 */
export async function stageReinterpretation(
  tx: Tx,
  messageId: string,
): Promise<{ interpretationId: string; interpretationVersion: number }> {
  const rows = (await tx.execute(sql`
    INSERT INTO interpretations (message_id, interpretation_version)
    SELECT ${messageId}::uuid,
           COALESCE(MAX(interpretation_version), 0) + 1
      FROM interpretations
     WHERE message_id = ${messageId}::uuid
    RETURNING id, interpretation_version
  `)) as unknown as Array<{ id: string; interpretation_version: number }>;
  const row = rows[0];
  if (!row) {
    throw new Error(`could not stage a re-interpretation of message "${messageId}"`);
  }
  return { interpretationId: row.id, interpretationVersion: Number(row.interpretation_version) };
}

/**
 * Whether a message has been read at its current version. Exported for tests
 * and for the smoke runner; the worker's own predicate is in `interpret.ts`.
 */
export async function interpretationStatusOf(
  db: InterpretDeps['db'],
  messageId: string,
): Promise<{ version: number; status: string } | null> {
  const rows = await db
    .select({
      version: interpretations.interpretationVersion,
      status: interpretations.status,
    })
    .from(interpretations)
    .where(eq(interpretations.messageId, messageId))
    .orderBy(sql`${interpretations.interpretationVersion} DESC`)
    .limit(1);
  const row = rows[0];
  return row ? { version: row.version, status: row.status } : null;
}

/** Every message of a room, oldest first. Used by the smoke runner. */
export async function roomMessageIds(db: InterpretDeps['db'], roomId: string): Promise<string[]> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.roomId, roomId)))
    .orderBy(messages.seq);
  return rows.map((row) => row.id);
}
