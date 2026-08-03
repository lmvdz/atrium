import type { DatabaseHandle } from '@atrium/db';
import {
  attentionItems,
  interpretations,
  messages,
  proposalSources,
  proposals,
} from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Command, createCommandService } from '../../apps/server/src/commands.js';
import {
  ACCEPTANCE_MODEL,
  createAcceptanceProvider,
} from '../../apps/server/src/jobs/acceptance-provider.js';
import type { ExtractedReading } from '../../apps/server/src/jobs/extraction.js';
import { runInterpretation } from '../../apps/server/src/jobs/interpret.js';
import type {
  InterpretationProvider,
  InterpretationRequest,
} from '../../apps/server/src/jobs/provider.js';
import { MalformedModelOutputError } from '../../apps/server/src/jobs/provider.js';
import { createLedger, type Ledger } from '../../apps/server/src/ledger.js';
import { createLogger } from '../../apps/server/src/logger.js';
import { type QueueHandle, startQueue } from '../../apps/server/src/queue.js';
import { createMembershipAuthorizer } from '../../apps/server/src/session.js';
import { violatesConstraint } from '../support/constraints.js';
import { databaseUrl } from '../support/env.js';
import {
  openDatabase,
  resetDatabase,
  type SeededRoom,
  seedRoom,
  until,
} from '../support/harness.js';

/**
 * The interpretation worker against a real Postgres and a real pg-boss (#23).
 *
 * The provider is the only thing replaced, and it is replaced by a *counter*:
 * every claim this suite makes about coalescing and idempotency is a claim
 * about how many times a real queue actually invoked it, not about what the
 * code appears to do.
 *
 * Each test names the source change it catches. An assertion that would pass
 * against three different implementations is not evidence about any of them.
 */

const MODEL_DEFAULT = 'test/default-pass';
const MODEL_ESCALATION = 'test/escalation-tier';
const COALESCE_SECONDS = 1;

/** A provider that records every call and answers from a script. */
class ScriptedProvider implements InterpretationProvider {
  readonly calls: InterpretationRequest[] = [];
  /** Readings to return, as a function of the request. */
  respond: (request: InterpretationRequest, call: number) => ExtractedReading[] = () => [];
  /** When set, throw this instead of answering. */
  fail: ((request: InterpretationRequest, call: number) => Error | null) | null = null;

  async generate(request: InterpretationRequest) {
    this.calls.push(request);
    const failure = this.fail?.(request, this.calls.length);
    if (failure) throw failure;
    const readings = this.respond(request, this.calls.length);
    return {
      output: { readings },
      raw: { readings },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.0001 },
      model: request.model,
    };
  }
}

/** The ids the transcript printed, in the order they appear. */
function transcriptMessageIds(prompt: string): string[] {
  return [...prompt.matchAll(/--- message ([0-9a-f-]{36}) ·/g)].map((match) => match[1] as string);
}

let handle: DatabaseHandle;
let ledger: Ledger;
let queue: QueueHandle;
let provider: ScriptedProvider;
let room: SeededRoom;
let commands: ReturnType<typeof createCommandService>;

const logger = createLogger('error');

async function boot(options: { retryLimit?: number } = {}): Promise<void> {
  ledger = createLedger({ db: handle.db, logger });
  await ledger.hydrate();
  provider = new ScriptedProvider();
  queue = await startQueue({
    databaseUrl: databaseUrl(),
    concurrency: 4,
    coalesceSeconds: COALESCE_SECONDS,
    retryLimit: options.retryLimit ?? 1,
    retryDelaySeconds: 1,
    logger,
    interpretation: {
      db: handle.db,
      ledger,
      provider,
      routing: { default: MODEL_DEFAULT, escalation: MODEL_ESCALATION },
      config: { maxWindowMessages: 50, contextMessagesBefore: 25 },
    },
  });
  commands = createCommandService({
    db: handle.db,
    ledger,
    authorizer: createMembershipAuthorizer(handle.db),
    projectionHooks: {
      onMessagePosted: ({ tx, roomId }) => queue.enqueueInterpretation(tx, roomId),
    },
  });
}

/**
 * A message with no job behind it.
 *
 * Used by every test that drives `runInterpretation` by hand: `say` enqueues,
 * and the worker started in `beforeEach` would race the manual pass and make
 * the call counts mean nothing.
 */
async function insertMessage(userId: string, body: string): Promise<string> {
  const [row] = await handle.db
    .insert(messages)
    .values({ roomId: room.roomId, authorId: userId, body })
    .returning({ id: messages.id });
  return row?.id as string;
}

async function say(userId: string, body: string): Promise<string> {
  const result = await commands.execute(
    { userId },
    Command.parse({ name: 'send_message', roomId: room.roomId, body }),
  );
  if (result.kind !== 'appended' || result.event.type !== 'message_posted') {
    throw new Error(`send_message did not append: ${JSON.stringify(result)}`);
  }
  return result.event.messageId;
}

/** Every proposal row in the room, oldest first. */
async function proposalRows() {
  return handle.db
    .select({
      id: proposals.id,
      type: proposals.type,
      payload: proposals.payload,
      status: proposals.status,
      model: proposals.proposerModel,
      interpretationId: proposals.interpretationId,
    })
    .from(proposals)
    .where(eq(proposals.roomId, room.roomId))
    .orderBy(proposals.createdAt);
}

async function interpretationRows(messageId: string) {
  return handle.db
    .select({
      id: interpretations.id,
      version: interpretations.interpretationVersion,
      status: interpretations.status,
      model: interpretations.model,
      error: interpretations.error,
    })
    .from(interpretations)
    .where(eq(interpretations.messageId, messageId))
    .orderBy(interpretations.interpretationVersion);
}

async function jobCount(queueName: string): Promise<number> {
  const rows = (await handle.db.execute(
    sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${queueName}`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

beforeEach(async () => {
  handle ??= openDatabase(20);
  await resetDatabase(handle);
  room = await seedRoom(handle, ['alice', 'bob']);
  await boot();
});

afterEach(async () => {
  await queue?.stop();
});

afterAll(async () => {
  await handle?.close();
});

/* ── coalescing ─────────────────────────────────────────────────────────── */

describe('coalescing a burst', () => {
  /**
   * The gauntlet bar, measured rather than declared.
   *
   * Mutation: drop `singletonKey` from `enqueueInterpretation`, or drop
   * `policy: 'stately'` from the queue. Either one turns twelve messages into
   * twelve jobs and twelve provider calls.
   *
   * Mutation: swap the policy for a `singletonSeconds` time bucket — the shape
   * #16 describes, and the first thing this was built as. That bucket is epoch
   * aligned, so a burst straddling a boundary lands in two of them and costs
   * two calls; this test caught exactly that, on a burst lasting 374ms.
   *
   * Mutation: drop `startAfter`. The job then runs the instant the first
   * message lands, drains it alone, and the other eleven are dropped by the
   * dedup for the rest of the burst — one call, eleven messages lost, which is
   * why "exactly one call" alone is not the assertion.
   */
  it('a 12-message burst costs exactly one provider call and reads all twelve', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      ids.push(await say(room.people.alice as string, `burst line ${i}`));
    }

    expect(await jobCount('interpret-room')).toBe(1);

    await until(() => provider.calls.length > 0, 20_000, 'the coalesced pass to run');
    // And nothing else follows it: no second slot, no follow-up.
    await new Promise((resolve) => setTimeout(resolve, (COALESCE_SECONDS + 2) * 1000));

    expect(provider.calls).toHaveLength(1);
    expect(transcriptMessageIds(provider.calls[0]?.prompt ?? '')).toEqual(ids);

    for (const id of ids) {
      const [row] = await interpretationRows(id);
      expect(row?.status).toBe('succeeded');
      expect(row?.version).toBe(1);
    }
  });

  /**
   * Mutation: have the worker return after `markSucceeded` without re-counting.
   * pg-boss's singleton index covers every non-cancelled state, so a message
   * that commits inside a slot whose job has already finished has its send
   * *dropped* — and with no re-count nothing ever wakes up for it again. It is
   * uninterpreted forever, silently.
   */
  it('a pass that leaves messages unread schedules a follow-up rather than dropping them', async () => {
    // Straight into the database, bypassing the enqueue entirely — which is
    // exactly what a send pg-boss dropped inside a spent slot leaves behind.
    const inserted = await handle.db
      .insert(messages)
      .values([
        { roomId: room.roomId, authorId: room.people.alice as string, body: 'the first thing' },
        { roomId: room.roomId, authorId: room.people.bob as string, body: 'and one more' },
      ])
      .returning({ id: messages.id });
    const [first, second] = inserted.map((row) => row.id) as [string, string];
    expect(await jobCount('interpret-room')).toBe(0);

    // A pass narrow enough to leave one behind, using the production follow-up.
    const run = await runInterpretation(
      {
        db: handle.db,
        ledger,
        provider,
        routing: { default: MODEL_DEFAULT, escalation: MODEL_ESCALATION },
        logger,
        config: { maxWindowMessages: 1, contextMessagesBefore: 25 },
        enqueueFollowUp: queue.enqueueFollowUp,
      },
      { roomId: room.roomId },
    );

    expect(run.messageIds).toEqual([first]);
    expect(run.leftover).toBe(1);

    // Nothing else is going to notice `second`; only the follow-up can.
    await until(
      async () => (await interpretationRows(second))[0]?.status === 'succeeded',
      30_000,
      'the follow-up pass to read the leftover',
    );
  });
});

/* ── the transactional enqueue ──────────────────────────────────────────── */

describe('the enqueue shares the message insert’s transaction', () => {
  /**
   * Mutation: enqueue after `ledger.append` returns instead of inside
   * `projectMessagePosted` — the shape the stub implied and #19's gauntlet
   * routed. A crash between the two leaves a durable message with no job, and
   * nothing in the system ever reads it.
   *
   * Simulated by failing the enqueue itself: if the two share a transaction,
   * the message must not survive. If they do not, the message is committed and
   * only the job is missing — which is the defect, seen from the other side.
   */
  it('a message whose enqueue fails is not committed either', async () => {
    const failing = createCommandService({
      db: handle.db,
      ledger,
      authorizer: createMembershipAuthorizer(handle.db),
      projectionHooks: {
        onMessagePosted: async () => {
          throw new Error('the queue is down');
        },
      },
    });

    await expect(
      failing.execute(
        { userId: room.people.alice as string },
        Command.parse({ name: 'send_message', roomId: room.roomId, body: 'lost?' }),
      ),
    ).rejects.toThrow(/the queue is down/);

    const rows = await handle.db.select().from(messages).where(eq(messages.roomId, room.roomId));
    expect(rows).toHaveLength(0);
    expect(await jobCount('interpret-room')).toBe(0);
  });

  /**
   * And the other direction: an append the *ledger* refuses must not leave a
   * job behind promising to interpret a message that does not exist.
   *
   * Mutation: send the job on the pool (`boss.send` with no `db:` option)
   * rather than through `fromDrizzle(tx, sql)`. The job row then commits on its
   * own connection and survives the rollback — a pass gets scheduled for a
   * message nobody ever wrote.
   */
  it('a rolled-back append leaves no job behind', async () => {
    await expect(
      commands.execute(
        { userId: room.people.alice as string },
        Command.parse({ name: 'send_message', roomId: room.roomId, body: 'from a stranger' }),
      ),
    ).resolves.toBeTruthy();
    const before = await jobCount('interpret-room');

    // A non-member: `authorize` throws inside the append transaction, after the
    // lock and before anything is minted.
    await expect(
      commands.execute(
        { userId: '99999999-9999-4999-8999-999999999999' },
        Command.parse({ name: 'send_message', roomId: room.roomId, body: 'from a stranger' }),
      ),
    ).rejects.toThrow();

    expect(await jobCount('interpret-room')).toBe(before);
  });
});

/* ── idempotency ────────────────────────────────────────────────────────── */

describe('idempotency', () => {
  /**
   * The constraint, exercised rather than declared.
   *
   * Mutation: remove `interpretations_message_version_key` from the schema, or
   * change the claim to `INSERT ... RETURNING` with no conflict target. Two
   * workers racing on one room would each claim every message and each spend a
   * provider call on it.
   */
  it('refuses a second interpretation row for the same message and version', async () => {
    const id = await say(room.people.alice as string, 'once');
    await until(() => provider.calls.length === 1, 20_000, 'the pass');
    const [row] = await interpretationRows(id);
    expect(row?.version).toBe(1);

    await violatesConstraint('interpretations_message_version_key', () =>
      handle.db.insert(interpretations).values({ messageId: id, interpretationVersion: 1 }),
    );
  });

  /**
   * Mutation: mint proposal ids with `randomUUID()` instead of hashing the
   * interpretation id and the reading. The retry then appends a second
   * `proposal_recorded` for the same sentence and the room shows the same `~`
   * twice.
   *
   * Mutation: flip the interpretation row to `failed` when the pass throws
   * rather than leaving it `pending`. The retry claims a *new* interpretation
   * id, so the content-addressed ids differ and every reading is proposed
   * again — the same duplicate, reached through the bookkeeping instead.
   */
  it('a crash mid-pass and its retry leave exactly one proposal per reading', async () => {
    const id = await insertMessage(
      room.people.alice as string,
      'We are going with Postgres for the queue.',
    );

    const reading = (): ExtractedReading[] => [
      {
        type: 'claim',
        text: 'We are going with Postgres for the queue',
        subject: room.people.alice as string,
        confidence: 0.8,
        quote: 'We are going with Postgres for the queue.',
        messageIds: [id],
      },
    ];

    provider.respond = reading;
    const deps = {
      db: handle.db,
      ledger,
      provider,
      routing: { default: MODEL_DEFAULT, escalation: MODEL_ESCALATION },
      logger,
    };

    /**
     * Attempt one dies where a crash actually hurts: after every proposal has
     * been appended and before `markSucceeded` commits. That is the only window
     * in which a retry re-reads a message it has already proposed from, so it is
     * the only window worth reproducing — and it is reproduced by failing the
     * real statement rather than by hand-editing the rows afterwards.
     *
     * The first `update` is `markStarted`, which runs before the provider call;
     * the second is `markSucceeded`.
     */
    let updates = 0;
    const dyingDb = new Proxy(handle.db, {
      get(target, property, receiver) {
        if (property === 'update') {
          updates += 1;
          if (updates === 2) {
            return () => {
              throw new Error('crash: the process died before the bookkeeping committed');
            };
          }
        }
        return Reflect.get(target, property, receiver);
      },
    }) as typeof handle.db;

    await expect(
      runInterpretation({ ...deps, db: dyingDb }, { roomId: room.roomId }),
    ).rejects.toThrow(/died before the bookkeeping committed/);

    const afterCrash = await proposalRows();
    expect(afterCrash).toHaveLength(1);
    const claimedRow = (await interpretationRows(id))[0];
    // Still pending — which is what makes the retry reuse this very row.
    expect(claimedRow?.status).toBe('pending');

    // The retry: same room, same pending row, same interpretation id.
    const retried = await runInterpretation(deps, { roomId: room.roomId });
    expect(retried.providerCalls).toBe(1);
    expect(retried.interpretationIds).toEqual([claimedRow?.id]);

    const afterRetry = await proposalRows();
    expect(afterRetry).toHaveLength(1);
    expect(afterRetry[0]?.id).toBe(afterCrash[0]?.id);
    expect(await countCoreEvents('proposal_recorded')).toBe(1);
    expect((await interpretationRows(id))[0]?.status).toBe('succeeded');
  });
});

async function countCoreEvents(type: string): Promise<number> {
  const rows = (await handle.db.execute(
    sql`SELECT count(*)::int AS n FROM core_events WHERE type = ${type}::event_type`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/* ── re-interpretation ──────────────────────────────────────────────────── */

describe('re-interpretation', () => {
  /**
   * The version bump, and the half of supersession the spike argued for.
   *
   * Mutation: supersede every prior proposal from the message when the version
   * bumps — the obvious reading of "an edit supersedes prior proposals". Two
   * identical runs shared only ~45% of their objects in the spike, so that
   * deletes readings the new run merely failed to re-derive, and the room loses
   * a `~` it never disagreed with.
   *
   * Mutation: make the contradiction test "same type over an overlapping
   * citation" without comparing the quote. One message routinely yields several
   * readings, so every new reading would retire every old one from the same
   * message — including the untouched one this test holds fixed.
   *
   * Mutation: drop `scheduleReinterpretation`'s `MAX(version) + 1` in favour of
   * a literal `2`. The third re-read then collides with the second on
   * `interpretations_message_version_key`.
   */
  it('bumps the version, supersedes what it contradicts, and leaves the rest alone', async () => {
    const body =
      'We are going with Postgres for the queue. Retries are handled by the worker itself.';
    const id = await insertMessage(room.people.alice as string, body);
    // A second message so the window does not end at the citation — otherwise
    // every reading here is `refer`-graded for a reason unrelated to this test.
    await insertMessage(room.people.bob as string, 'Noted, thanks.');

    const queueReading = (text: string): ExtractedReading => ({
      type: 'claim',
      text,
      subject: room.people.alice as string,
      confidence: 0.8,
      quote: 'We are going with Postgres for the queue.',
      messageIds: [id],
    });
    const retriesReading: ExtractedReading = {
      type: 'claim',
      text: 'Retries are handled by the worker itself',
      subject: room.people.alice as string,
      confidence: 0.8,
      quote: 'Retries are handled by the worker itself.',
      messageIds: [id],
    };

    const deps = {
      db: handle.db,
      ledger,
      provider,
      routing: { default: MODEL_DEFAULT, escalation: MODEL_ESCALATION },
      logger,
    };

    provider.respond = () => [
      queueReading('We are going with Postgres for the queue'),
      retriesReading,
    ];
    const first = await runInterpretation(deps, { roomId: room.roomId });

    expect(first.proposalsRecorded).toHaveLength(2);

    // Stage version 2, in a transaction, the way a correction would.
    const staged = await handle.db.transaction((tx) =>
      queue.scheduleReinterpretation(tx, { roomId: room.roomId, messageId: id }),
    );
    expect(staged.interpretationVersion).toBe(2);
    expect((await interpretationRows(id)).map((row) => row.version)).toEqual([1, 2]);

    // The second run re-reads one sentence differently and the other identically.
    // The same sentence, read as a narrower claim. It has to be a reading the
    // quote actually bears — a v2 that says "we are NOT going with Postgres"
    // while quoting a sentence that says the opposite is refused by
    // `quote_does_not_bear_statement`, and rightly: that is a receipt pointing
    // at words nobody wrote, which is the failure this whole path exists to
    // refuse. A contradiction between two runs is a difference in what they
    // read OUT of the sentence, not a difference from it.
    provider.respond = () => [queueReading('going with Postgres for the queue'), retriesReading];
    const second = await runInterpretation(deps, { roomId: room.roomId });

    expect(second.proposalsRecorded).toHaveLength(1);
    expect(second.unchanged).toBe(1);
    expect(second.proposalsSuperseded).toHaveLength(1);

    const rows = await proposalRows();
    expect(rows).toHaveLength(3);
    const superseded = rows.filter((row) => row.status === 'superseded');
    expect(superseded).toHaveLength(1);
    const retired = superseded[0];
    expect((retired?.payload as { statement: string } | undefined)?.statement).toBe(
      'We are going with Postgres for the queue',
    );
    expect(second.proposalsSuperseded).toEqual([retired?.id]);
    // The reading the new run agreed with keeps its `~` and its version-1 id.
    const untouched = rows.filter(
      (row) => (row.payload as { statement: string }).statement === retriesReading.text,
    );
    expect(untouched).toHaveLength(1);
    expect(untouched[0]?.status).toBe('proposed');
    expect(untouched[0]?.interpretationId).toBe(first.interpretationIds[0]);

    expect((await interpretationRows(id))[1]?.status).toBe('succeeded');
  });
});

/* ── escalation routing ─────────────────────────────────────────────────── */

describe('two-tier routing', () => {
  /**
   * Mutation: route on the model's own output (#8's original triggers — a
   * proposed supersession, a third-party commitment, a contradiction, a θ-band
   * confidence). The spike measured all four firing 0/6 against a corpus that
   * contains a real supersession, so the escalation tier would be dead code
   * *and* the routing would need a second call to discover it.
   *
   * Mutation: move the tier decision after the provider call — "call Luna,
   * look at what it said, call Sonnet if it looks load-bearing". That is a
   * second call per burst, which is the bar this suite exists to hold.
   *
   * (The history is passed too, but it does not decide the tier — see
   * `apps/server/test/interpret-routing.test.ts` for what it does decide.)
   */
  it('a reply-blockquote of an earlier message routes the window to the escalation tier', async () => {
    await say(room.people.alice as string, 'We are going with Postgres for the queue.');
    await until(() => provider.calls.length === 1, 20_000, 'the first pass');
    expect(provider.calls[0]?.model).toBe(MODEL_DEFAULT);

    await say(
      room.people.bob as string,
      '> We are going with Postgres for the queue.\n\nHonestly, you are right, I was wrong about SQS.',
    );
    await until(() => provider.calls.length === 2, 20_000, 'the escalated pass');
    expect(provider.calls[1]?.model).toBe(MODEL_ESCALATION);
  });

  /**
   * Mutation: escalate whenever the window is non-empty, or on any message
   * containing a `>` character. The tier is nine times the price of the default
   * pass (#7), so a trigger that fires on everything is a bill, not a routing
   * rule.
   */
  it('ordinary conversation stays on the default pass', async () => {
    await say(room.people.alice as string, 'Morning. Anyone looked at the flaky test yet?');
    await until(() => provider.calls.length === 1, 20_000, 'the pass');
    expect(provider.calls[0]?.model).toBe(MODEL_DEFAULT);
    await until(() => queue.lastRun() !== null, 20_000, 'the completed run');
    expect(queue.lastRun()?.tier).toBe('default');
  });

  /**
   * The routing is *pre-call* and therefore cannot cost a second call. This is
   * the property that makes "one coalesced call per burst" survive escalation.
   *
   * Mutation: make escalation a second pass over the same window ("call Luna,
   * then call Sonnet if the output looks load-bearing"). The burst costs two.
   */
  it('escalation costs one call, not two', async () => {
    await say(room.people.alice as string, 'We are going with Postgres for the queue.');
    await until(() => provider.calls.length === 1, 20_000, 'the first pass');
    await say(room.people.bob as string, '> going with Postgres\n\nCorrection: we are not.');
    await until(() => provider.calls.length === 2, 20_000, 'the escalated pass');
    await new Promise((resolve) => setTimeout(resolve, (COALESCE_SECONDS + 2) * 1000));
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.filter((call) => call.model === MODEL_ESCALATION)).toHaveLength(1);
  });
});

/* ── malformed output ───────────────────────────────────────────────────── */

describe('malformed model output', () => {
  /**
   * Mutation: catch the provider error inside the job and return normally. The
   * pass is acknowledged, the interpretation rows are marked `succeeded`, and a
   * room's messages are recorded as read with nothing read out of them — the
   * failure mode a dead-letter queue exists to make visible.
   *
   * Mutation: mark the rows `failed` on the first throw rather than in the DLQ
   * handler. The retry then claims new interpretation ids (see the idempotency
   * suite), so a poison message that eventually succeeds proposes twice.
   */
  it('retries, dead-letters, and corrupts nothing on the way', async () => {
    provider.fail = () => new MalformedModelOutputError('not an object', '{"readings": ');
    const id = await say(room.people.alice as string, 'something the model chokes on');

    await until(() => jobCount('interpret-room-dlq').then((n) => n > 0), 40_000, 'the dead letter');
    // retryLimit 1 → the original attempt plus one retry, and no more.
    await until(() => provider.calls.length >= 2, 20_000, 'the retry');
    expect(provider.calls.length).toBe(2);

    await until(
      async () => (await interpretationRows(id))[0]?.status === 'failed',
      20_000,
      'the row to be marked failed',
    );

    const [row] = await interpretationRows(id);
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/dead-lettered/);
    // Nothing half-written: no proposals, no events, and the message is intact.
    expect(await proposalRows()).toHaveLength(0);
    expect(await countCoreEvents('proposal_recorded')).toBe(0);
    const [message] = await handle.db.select().from(messages).where(eq(messages.id, id));
    expect(message?.body).toBe('something the model chokes on');
  });

  /**
   * Mutation: keep re-draining `failed` rows. A message the model cannot parse
   * would then be retried on every subsequent pass for the life of the room —
   * an unbounded bill triggered by one sentence.
   */
  it('does not re-drain a message that already dead-lettered', async () => {
    provider.fail = () => new MalformedModelOutputError('not an object', null);
    const id = await say(room.people.alice as string, 'poison');
    await until(() => jobCount('interpret-room-dlq').then((n) => n > 0), 40_000, 'the dead letter');
    await until(
      async () => (await interpretationRows(id))[0]?.status === 'failed',
      20_000,
      'the failed row',
    );

    provider.fail = null;
    const run = await runInterpretation(
      {
        db: handle.db,
        ledger,
        provider,
        routing: { default: MODEL_DEFAULT, escalation: MODEL_ESCALATION },
        logger,
      },
      { roomId: room.roomId },
    );
    expect(run.messageIds).toEqual([]);
    expect(run.providerCalls).toBe(0);
  });
});

/* ── per-job settlement ─────────────────────────────────────────────────── */

describe('per-job settlement', () => {
  /**
   * Mutation: restore `{ batchSize: concurrency }` — the stub's setting, and
   * the first item #19's gauntlet routed. `batchSize` is how many jobs one
   * fetch returns; the batch is handed to ONE handler invocation and settled as
   * a unit, so a throw on one room fails every room fetched with it. Two
   * healthy rooms would be retried and eventually dead-lettered for a third
   * room's poison.
   */
  it('one room’s failure does not fail another room fetched with it', async () => {
    const other = await seedRoom(handle, ['carol']);
    const poisoned = room.roomId;
    provider.fail = (request) =>
      request.prompt.includes('poison') ? new Error('this room only') : null;

    // Both rooms enqueued inside the same coalescing window, so a batching
    // worker would fetch them together.
    await say(room.people.alice as string, 'poison for one room');
    await commands.execute(
      { userId: other.people.carol as string },
      Command.parse({ name: 'send_message', roomId: other.roomId, body: 'perfectly fine' }),
    );

    await until(
      async () => {
        const rows = await handle.db
          .select({ status: interpretations.status })
          .from(interpretations)
          .innerJoin(messages, eq(messages.id, interpretations.messageId))
          .where(and(eq(messages.roomId, other.roomId)));
        return rows.some((row) => row.status === 'succeeded');
      },
      40_000,
      'the healthy room to be interpreted',
    );

    // And the poisoned one is the only thing in the dead-letter queue.
    await until(() => jobCount('interpret-room-dlq').then((n) => n > 0), 40_000, 'the dead letter');
    const dlq = (await handle.db.execute(
      sql`SELECT data->>'roomId' AS room FROM pgboss.job WHERE name = 'interpret-room-dlq'`,
    )) as unknown as Array<{ room: string }>;
    expect(dlq.map((row) => row.room)).toEqual([poisoned]);
  });
});

/* ── acceptance, and what #86 does to it ────────────────────────────────── */

describe('in-job acceptance', () => {
  /**
   * Mutation: replace the model call for acceptance by seeding projections or
   * accepted rows directly. This proof would then find no interpretation,
   * proposal, ledger event, or folded object produced by the real worker.
   *
   * Mutation: let the deterministic seam cite its stripped semantic text
   * rather than the exact source line. Core refuses the proposal because the
   * quote is no longer verbatim, and the folded accepted count remains zero.
   */
  it('drives an exact acceptance fixture through the production worker into the fold', async () => {
    const source = await insertMessage(
      room.people.alice as string,
      'Claim: The reconnect trace contains every committed message.',
    );
    await insertMessage(room.people.bob as string, 'Receipt recorded.');

    const run = await runInterpretation(
      {
        db: handle.db,
        ledger,
        provider: createAcceptanceProvider(),
        routing: { default: ACCEPTANCE_MODEL, escalation: ACCEPTANCE_MODEL },
        logger,
      },
      { roomId: room.roomId },
    );

    expect(run.messageIds).toEqual([source, expect.any(String)]);
    expect(run.proposalsRecorded).toHaveLength(1);
    expect(run.rejected).toEqual([]);
    expect(run.objectsAccepted).toHaveLength(1);
    expect(run.costUsd).toBe(0);
    const rows = (await handle.db.execute(
      sql`SELECT payload FROM accepted_objects WHERE room_id = ${room.roomId}::uuid`,
    )) as unknown as Array<{ payload: { statement?: string } }>;
    expect(rows).toEqual([
      {
        payload: {
          statement: 'Claim: The reconnect trace contains every committed message.',
          claimant: room.people.alice,
          verification: 'unverified',
        },
      },
    ]);
    expect((await proposalRows())[0]?.model).toBe(ACCEPTANCE_MODEL);
  });

  /**
   * Mutation: omit the configured history before the unread window, or resolve
   * a commitment owner from membership instead of authored evidence. The
   * absent owner's UUID cannot be grounded and the reading is rejected rather
   * than staged for their confirmation.
   *
   * Mutation: auto-accept a third-party commitment. An accepted object appears
   * before the named owner acts and their confirmation item never exists.
   */
  it('grounds a third-party commitment in recent owner speech and waits for that owner', async () => {
    const owner = room.people.bob as string;
    await insertMessage(owner, 'I am present before this burst.');
    await runInterpretation(
      {
        db: handle.db,
        ledger,
        provider: createAcceptanceProvider(),
        routing: { default: ACCEPTANCE_MODEL, escalation: ACCEPTANCE_MODEL },
        logger,
      },
      { roomId: room.roomId },
    );
    const source = await insertMessage(
      room.people.alice as string,
      `Commitment for ${owner}: Upload the reconnect trace.`,
    );
    await insertMessage(room.people.alice as string, 'The burst continues.');

    const run = await runInterpretation(
      {
        db: handle.db,
        ledger,
        provider: createAcceptanceProvider(),
        routing: { default: ACCEPTANCE_MODEL, escalation: ACCEPTANCE_MODEL },
        logger,
        config: { maxWindowMessages: 50, contextMessagesBefore: 25 },
      },
      { roomId: room.roomId },
    );

    expect(run.messageIds).toContain(source);
    expect(run.proposalsRecorded).toHaveLength(1);
    expect(run.objectsAccepted).toHaveLength(0);
    expect(run.rejected).toEqual([]);
    const pending = await handle.db
      .select({ userId: attentionItems.userId, reason: attentionItems.reason })
      .from(attentionItems)
      .where(eq(attentionItems.roomId, room.roomId));
    expect(pending).toEqual([
      {
        userId: owner,
        reason: {
          kind: 'commitment_confirm',
          statement: `Commitment for ${owner}: Upload the reconnect trace.`,
        },
      },
    ]);

    const accepted = await commands.execute(
      { userId: owner },
      Command.parse({
        name: 'accept_proposal',
        roomId: room.roomId,
        proposalId: run.proposalsRecorded[0],
      }),
    );
    expect(accepted.kind).toBe('appended');
    const folded = (await handle.db.execute(
      sql`SELECT payload, accepted_by AS "acceptedBy" FROM accepted_objects WHERE room_id = ${room.roomId}::uuid`,
    )) as unknown as Array<{ payload: { statement?: string; owner?: string }; acceptedBy: string }>;
    expect(folded).toEqual([
      {
        payload: {
          statement: `Commitment for ${owner}: Upload the reconnect trace.`,
          owner,
          status: 'open',
          due: null,
        },
        acceptedBy: owner,
      },
    ]);
  });

  /**
   * Mutation: delete `reconcileStoredAttention` from the worker. The proposal
   * and interpretation still report success, but the durable Needs-you panel
   * remains empty.
   *
   * Mutation: reconcile stored rows by their database UUID instead of deriving
   * core's semantic identity. A second cycle sees every row as a different
   * item and cannot preserve its settled status.
   *
   * Mutation: project proposal provenance only when somebody accepts it. The
   * pending decision still appears in Needs you but its receipt has no source
   * message—the item that most needs inspection is the only unsourced one.
   *
   * Mutation: signal `onProjectionChanged` before `reconcileStoredAttention`.
   * A live client is told to reread while the durable attention table still has
   * zero rows, recreating the worker's last-event/late-projection race.
   */
  it('persists pending attention for a decision the worker stages', async () => {
    const body = 'We will use Postgres for the queue.';
    const first = await insertMessage(room.people.alice as string, body);
    await insertMessage(room.people.bob as string, 'Understood.');

    provider.respond = () => [
      {
        type: 'decision',
        text: body,
        subject: null,
        confidence: 0.95,
        quote: body,
        messageIds: [first],
      },
    ];

    let attentionRowsAtSignal = 0;
    const run = await runInterpretation(
      {
        db: handle.db,
        ledger,
        provider,
        routing: { default: MODEL_DEFAULT, escalation: MODEL_ESCALATION },
        logger,
        onProjectionChanged: async () => {
          const rows = await handle.db
            .select()
            .from(attentionItems)
            .where(eq(attentionItems.roomId, room.roomId));
          attentionRowsAtSignal = rows.length;
        },
      },
      { roomId: room.roomId },
    );

    expect(run.proposalsRecorded).toHaveLength(1);
    expect(run.objectsAccepted).toHaveLength(0);
    expect(attentionRowsAtSignal).toBe(2);
    const rows = await handle.db
      .select()
      .from(attentionItems)
      .where(eq(attentionItems.roomId, room.roomId));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.userId).sort()).toEqual(
      [room.people.alice as string, room.people.bob as string].sort(),
    );
    expect(rows.every((row) => /^[0-9a-f-]{36}$/.test(row.id))).toBe(true);
    expect(rows.every((row) => row.status === 'pending')).toBe(true);
    expect(rows.every((row) => row.subjectKind === 'proposal')).toBe(true);
    expect(rows.every((row) => row.reason.kind === 'decision_pending')).toBe(true);
    const sources = await handle.db
      .select()
      .from(proposalSources)
      .where(eq(proposalSources.proposalId, run.proposalsRecorded[0] as string));
    expect(sources).toEqual([
      {
        roomId: room.roomId,
        proposalId: run.proposalsRecorded[0],
        messageId: first,
      },
    ]);
  });

  /**
   * **The #86 receipt: the worker's acceptance reaches the fold.**
   *
   * Before #86, `atrium_receipt_window` ended at the cited message while core
   * required evidence that the reading window continued beyond it. The worker
   * therefore reported `acceptance_refused` and `accepted_objects` stayed empty.
   *
   * Mutation: restore the citation-bounded receipt window. `rejected` contains
   * `acceptance_refused`, `objectsAccepted` is empty, and the database count is
   * zero. All three assertions below must move together: the returned verdict
   * is only a claim, while the folded row is the fact.
   */
  it('accepts a certifiable reading through the worker and into the fold', async () => {
    const body = 'The control flow analysis work landed in the compiler last Tuesday.';
    const first = await insertMessage(room.people.alice as string, body);
    // A later message, so the *worker's own* acceptance window continues past
    // the citation. Only the ledger's SQL-derived window is then narrow, which
    // is what isolates #86 from an ordinary uncertifiable reading.
    await insertMessage(room.people.bob as string, 'Good to know.');

    provider.respond = () => [
      {
        type: 'claim',
        text: body,
        subject: room.people.alice as string,
        confidence: 0.95,
        quote: body,
        messageIds: [first],
      },
    ];

    const run = await runInterpretation(
      {
        db: handle.db,
        ledger,
        provider,
        routing: { default: MODEL_DEFAULT, escalation: MODEL_ESCALATION },
        logger,
      },
      { roomId: room.roomId },
    );

    // The reading is good enough to auto-accept — `decideAcceptance` said so,
    // which is why the worker tried at all.
    expect(run.proposalsRecorded).toHaveLength(1);
    expect(run.rejected).toEqual([]);

    // The worker's report and the database fold agree that it landed.
    expect(run.objectsAccepted).toHaveLength(1);
    const accepted = (await handle.db.execute(
      sql`SELECT count(*)::int AS n FROM accepted_objects WHERE room_id = ${room.roomId}::uuid`,
    )) as unknown as Array<{ n: number }>;
    const [countRow] = accepted;
    expect(countRow?.n).toBe(1);
    expect((await proposalRows())[0]?.status).toBe('accepted');
  });
});
