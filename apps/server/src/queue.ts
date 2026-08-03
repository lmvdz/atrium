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
 * **3. One provider call per burst.** The queue's policy is `stately` and every
 * job's `singletonKey` is the room, which pg-boss enforces as *one queued and
 * one active job per room*. A burst's first message creates the job; the other
 * eleven sends conflict on that index and are dropped, so the burst is one job
 * however long it runs. `startAfter` equal to the coalescing window is the
 * debounce that makes the job run at the END of the burst rather than at the
 * start of it.
 *
 * The policy is doing work a `singletonSeconds` window cannot, and the
 * difference is the reason for the choice. A time-slot window dedups on
 * `(name, singleton_key, singleton_on)` where `singleton_on` is an
 * EPOCH-ALIGNED bucket — so a burst that happens to straddle a bucket boundary
 * lands in two buckets and costs two calls, and the odds of that are simply the
 * burst's duration over the window. Worse, that index covers every
 * non-cancelled state, so a message committing inside a bucket whose job has
 * already finished has its send silently dropped and nothing ever wakes up for
 * it. `stately` has no clock in it: dedup is against what is *queued*, so a
 * burst is one job wherever the second boundaries fall, and a message arriving
 * while a pass is active creates the next job instead of vanishing.
 *
 * The worker still re-counts unread messages before it returns and schedules a
 * follow-up when it finds any — that closes the millisecond between the drain's
 * snapshot and the pass's own completion, which no queue policy can.
 *
 * `stately` also gives per-room serialization for free (one *active* job per
 * key, deployment-wide), so there is no `groupConcurrency` here; it would be a
 * second mechanism answering a question the policy already answers, with its
 * own round trips.
 */

export const INTERPRET_QUEUE = 'interpret-room';
export const INTERPRET_DLQ = 'interpret-room-dlq';

/** Payload of an `interpret-room` job. Per room, per #8's coalescing decision. */
export type { InterpretRoomJob } from './jobs/interpret.js';

/**
 * The coalescing window, in seconds — #8's "~10s".
 *
 * With a `stately` queue this is purely the debounce: how long a job waits
 * after the first unread message before it runs, and therefore how much of a
 * burst it gets to see. It is not a dedup bucket, so it has no boundary a burst
 * can fall across.
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
  /**
   * Seconds before a failed pass is retried. Exposed only so a test can make
   * the retry ladder finish inside a test's patience; production keeps
   * pg-boss's own default and the exponential backoff on top of it.
   */
  retryDelaySeconds?: number;
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
  /**
   * Schedule a follow-up pass into the **next** coalescing slot.
   *
   * This is what the worker itself calls when it finishes and finds messages
   * that arrived while it was running. Exposed on the handle so the behaviour
   * can be driven from a test against the production function rather than a
   * re-implementation of it — the failure it guards against (a send dropped
   * inside a spent singleton slot, and nothing ever waking up for it) is
   * invisible unless something exercises this exact call.
   */
  enqueueFollowUp: (roomId: string) => Promise<void>;
  /** The last run this process performed, for tests and for `/health` later. */
  lastRun: () => InterpretRunResult | null;
  stop: () => Promise<void>;
}

export async function startQueue({
  databaseUrl,
  concurrency,
  coalesceSeconds = DEFAULT_COALESCE_SECONDS,
  retryLimit = 5,
  retryDelaySeconds,
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
  const policy = 'stately';
  await boss.createQueue(INTERPRET_QUEUE, {
    // One queued and one active job per `singletonKey` — see the header.
    policy,
    retryLimit,
    retryBackoff: true,
    ...(retryDelaySeconds === undefined ? {} : { retryDelay: retryDelaySeconds }),
    deadLetter: INTERPRET_DLQ,
  });

  /**
   * The policy is fixed at creation, and neither call above will say so:
   * `createQueue` on an existing queue is a no-op, and `updateQueue` throws
   * "queue policy cannot be changed after creation". So a deployment whose
   * `interpret-room` queue predates this policy would quietly keep the old one,
   * every message in a burst would become its own job and its own provider
   * call, and nothing would be red. Read it back and refuse to serve instead —
   * an operator can drop the queue, and a silent regression in "one call per
   * burst" is the kind nobody notices until a bill arrives.
   */
  const registered = await boss.getQueue(INTERPRET_QUEUE);
  if (registered && registered.policy !== policy) {
    await boss.stop({ graceful: false });
    throw new Error(
      `queue "${INTERPRET_QUEUE}" already exists with policy "${registered.policy}", and pg-boss cannot change a queue's policy after creation. ` +
        `Coalescing depends on "${policy}" — one queued and one active job per room; under "${registered.policy}" every message in a burst becomes its own job and its own provider call. ` +
        'Drop the queue and let this process recreate it.',
    );
  }

  let lastRun: InterpretRunResult | null = null;

  const enqueueFollowUp = async (roomId: string): Promise<void> => {
    // No `startAfter`: these messages have already waited out one debounce, and
    // the pass that found them is the one that just ran. If a job is already
    // queued for this room the policy drops this send, which is correct — that
    // job will drain the same leftovers.
    await boss.send(INTERPRET_QUEUE, { roomId }, { singletonKey: roomId });
  };

  await boss.work<InterpretRoomJob>(
    INTERPRET_QUEUE,
    {
      // ONE job per handler invocation. A batch is settled as a unit, so a
      // batch of twelve rooms fails twelve rooms when one of them throws.
      batchSize: 1,
      // This is the concurrency knob. `batchSize` never was.
      localConcurrency: concurrency,
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
    enqueueFollowUp,
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
      // The coalescing key. Under the queue's `stately` policy this is "one
      // queued and one active pass for this room" — no time bucket, so no
      // boundary for a burst to fall across.
      singletonKey: roomId,
      // The debounce: run at the end of the burst, not at the start.
      startAfter: coalesceSeconds,
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
