import { PgBoss } from 'pg-boss';
import type { Logger } from './logger.js';

/**
 * pg-boss job queue (issue #16). One queue for now: `interpret-message`, fired
 * once per message so the Semantic Core can propose state changes.
 *
 * The idempotency contract, which the no-op handler below already honours:
 *   1. enqueue inside the same transaction as the message insert, with an
 *      explicit singleton key `${messageId}:${interpretationVersion}` AND an
 *      explicit singleton window (pg-boss silently no-ops dedup without one);
 *   2. the handler upserts against the `(message_id, interpretation_version)`
 *      unique constraint in `interpretations`, so a retry or a redrive is a
 *      no-op on the end state;
 *   3. exhausted retries land in the dead-letter queue for alerting.
 */

export const INTERPRET_QUEUE = 'interpret-message';
export const INTERPRET_DLQ = 'interpret-message-dlq';

/** Payload of an `interpret-message` job. */
export interface InterpretMessageJob {
  messageId: string;
  roomId: string;
  interpretationVersion: number;
}

/** Dedup key. Must be paired with an explicit singleton window at send time. */
export function interpretSingletonKey(job: InterpretMessageJob): string {
  return `${job.messageId}:${job.interpretationVersion}`;
}

export interface QueueOptions {
  databaseUrl: string;
  concurrency: number;
  logger: Logger;
}

export interface QueueHandle {
  boss: PgBoss;
  /** Enqueue an interpretation job with the correct dedup settings. */
  enqueueInterpretation: (job: InterpretMessageJob) => Promise<string | null>;
  stop: () => Promise<void>;
}

export async function startQueue({
  databaseUrl,
  concurrency,
  logger,
}: QueueOptions): Promise<QueueHandle> {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    // pg-boss owns its own `pgboss` schema; drizzle owns `public`.
    schema: 'pgboss',
  });

  boss.on('error', (error: Error) => {
    logger.error('pg-boss error', { error: error.message });
  });

  await boss.start();
  await boss.createQueue(INTERPRET_DLQ);
  await boss.createQueue(INTERPRET_QUEUE, {
    retryLimit: 5,
    retryBackoff: true,
    deadLetter: INTERPRET_DLQ,
  });

  await boss.work<InterpretMessageJob>(
    INTERPRET_QUEUE,
    { batchSize: concurrency },
    async (jobs) => {
      for (const job of jobs) {
        // NO-OP placeholder. The real handler will:
        //   1. upsert `interpretations` on (message_id, interpretation_version)
        //   2. call the model through the AI Gateway with `generateObject`
        //   3. write typed proposals + provenance in one transaction
        // Until then this exists to prove the worker registers, receives, and
        // acknowledges — and to keep the queue's shape honest.
        logger.info('interpret-message received (no-op)', {
          jobId: job.id,
          messageId: job.data.messageId,
          interpretationVersion: job.data.interpretationVersion,
        });
      }
    },
  );

  logger.info('queue worker registered', { queue: INTERPRET_QUEUE, concurrency });

  return {
    boss,
    enqueueInterpretation: (job) =>
      boss.send(INTERPRET_QUEUE, job, {
        singletonKey: interpretSingletonKey(job),
        // Explicit window: pg-boss's dedup silently does nothing without it.
        singletonSeconds: 300,
      }),
    stop: async () => {
      await boss.stop({ graceful: true, timeout: 10_000 });
      logger.info('queue stopped');
    },
  };
}
