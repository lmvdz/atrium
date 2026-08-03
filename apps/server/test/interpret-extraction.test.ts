import type { ProvenanceMessage } from '@atrium/core';
import { Proposal } from '@atrium/core';
import { describe, expect, it } from 'vitest';
import {
  ExtractedReading,
  ExtractionOutput,
  ExtractionWireSchema,
  mintProposal,
  proposalId,
} from '../src/jobs/extraction.js';

/**
 * The reading → proposal mapping, and the two things it has to refuse.
 *
 * Every test here names the source change it catches, because an assertion that
 * passes against three different implementations is not evidence about any of
 * them.
 */

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const M1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const M2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const RUN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const ROOM = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';

const WINDOW: ProvenanceMessage[] = [
  { id: M1, authorId: ALICE, body: 'We are going with Postgres for the queue, final answer.' },
  { id: M2, authorId: BOB, body: 'I will write the migration this week.' },
];

function reading(over: Partial<ExtractedReading> = {}): ExtractedReading {
  return ExtractedReading.parse({
    type: 'claim',
    text: 'We are going with Postgres for the queue',
    subject: ALICE,
    confidence: 0.8,
    quote: 'We are going with Postgres for the queue',
    messageIds: [M1],
    ...over,
  });
}

const context = {
  roomId: ROOM,
  interpretationId: RUN,
  model: 'test/model',
  createdAt: '2026-08-01T00:00:00.000Z',
  messages: WINDOW,
};

describe('proposalId — the retry half of the idempotency contract', () => {
  /**
   * Mutation: make `proposalId` return `randomUUID()`, or hash anything that
   * varies per run (a clock, a counter). The re-append that the reducer refuses
   * as "already recorded" becomes a second `~` in the room.
   */
  it('is the same id for the same run and the same reading', () => {
    expect(proposalId(RUN, reading())).toBe(proposalId(RUN, reading()));
  });

  /**
   * Mutation: derive the id from the reading's *index* in the output array
   * instead of its content. A retry whose model output shifted by one reading
   * then reuses an id for a different sentence — a receipt pointing at words
   * nobody said, which is worse than a duplicate.
   */
  it('is a different id when the sentence changes', () => {
    expect(proposalId(RUN, reading())).not.toBe(
      proposalId(RUN, reading({ text: 'We are going with SQS for the queue' })),
    );
  });

  /**
   * Mutation: drop `interpretationId` from the hash. Two versions of the same
   * message re-reading the same sentence would then mint the same proposal id,
   * so a re-interpretation could never supersede its predecessor — it would
   * collide with it.
   */
  it('is a different id in a different interpretation run', () => {
    expect(proposalId(RUN, reading())).not.toBe(proposalId(`${RUN}-v2`, reading()));
  });

  /**
   * Mutation: return the raw sha256 hex, or forget the version/variant nibbles.
   * `proposals.id` is a `uuid` column and the insert fails at runtime, in the
   * projection, inside the append transaction.
   */
  it('is a well-formed uuid, so the proposals column accepts it', () => {
    expect(proposalId(RUN, reading())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('mintProposal', () => {
  /**
   * Mutation: accept `reading.messageIds` verbatim as the provenance. A model
   * that invents a message id then produces a proposal whose receipt cannot be
   * opened — and `validateProposalProvenance` would report `unknown_message`
   * rather than the fact that the reading rests on nothing.
   */
  it('refuses a reading that cites no message in the window', () => {
    const minted = mintProposal(reading({ messageIds: ['not-a-message-in-this-room'] }), context);
    expect(minted.ok).toBe(false);
    if (!minted.ok) expect(minted.problem.reason).toMatch(/cites no message in the window/);
  });

  /** Mutation: keep only the unknown ids, or keep none. */
  it('keeps exactly the cited messages that exist', () => {
    const minted = mintProposal(reading({ messageIds: [M1, 'ghost', M2] }), context);
    expect(minted.ok).toBe(true);
    if (minted.ok) expect(minted.proposal.provenance).toEqual([M1, M2]);
  });

  /**
   * Mutation: fall back to `reading.subject` when it does not resolve — i.e.
   * `subject ?? reading.subject` instead of refusing. This is #10's standing
   * invariant: a claimant the model invented would be rendered beside a `~` as
   * a person in the room, and no such person wrote anything.
   */
  it('refuses a claimant who authored nothing in the window', () => {
    const minted = mintProposal(reading({ subject: 'Jordan' }), context);
    expect(minted.ok).toBe(false);
    if (!minted.ok) expect(minted.problem.reason).toMatch(/is not the author of any message/);
  });

  /**
   * Mutation: resolve an unrecognised subject to the first author of the
   * window rather than to the *sole* author of the cited messages. A commitment
   * would then land on whoever happened to speak first.
   */
  it('does not guess between two authors', () => {
    const minted = mintProposal(
      reading({ type: 'commitment', subject: null, messageIds: [M1, M2] }),
      context,
    );
    expect(minted.ok).toBe(false);
  });

  /** The self-attribution case, which is the one the spike found models get right. */
  it('resolves a null subject to the sole author of the cited messages', () => {
    const minted = mintProposal(
      reading({
        type: 'commitment',
        subject: null,
        text: 'write the migration this week',
        quote: 'I will write the migration this week.',
        messageIds: [M2],
      }),
      context,
    );
    expect(minted.ok).toBe(true);
    if (minted.ok) {
      expect((minted.proposal.payload as { owner: string }).owner).toBe(BOB);
    }
  });

  /**
   * Mutation: put the sentence in `statement` for every type. An open question
   * with a `statement` key fails `OpenQuestionPayload`, and an objective with
   * one fails `ObjectivePayload` — but only at the `Proposal.parse` in the job,
   * which is a rejected reading rather than a compile error.
   */
  it.each([
    ['decision', 'statement'],
    ['commitment', 'statement'],
    ['open_question', 'question'],
    ['claim', 'statement'],
    ['objective', 'title'],
  ] as const)('puts the sentence in the %s payload key %s', (type, key) => {
    const minted = mintProposal(
      reading({
        type,
        subject: ALICE,
        messageIds: [M1],
        text: 'We are going with Postgres for the queue',
      }),
      context,
    );
    expect(minted.ok).toBe(true);
    if (minted.ok) {
      expect((minted.proposal.payload as Record<string, unknown>)[key]).toBe(
        'We are going with Postgres for the queue',
      );
      // And the whole thing has to survive the core's own schema, including the
      // two model-proposer rules (non-empty provenance, non-blank quote).
      expect(Proposal.safeParse(minted.proposal).success).toBe(true);
    }
  });

  /**
   * Mutation: hand the proposal the room's model-tier *name* instead of the id
   * that answered. `proposals.proposer_model` is what a person reads to know
   * what produced a `~`.
   */
  it('records the model as the proposer', () => {
    const minted = mintProposal(reading(), context);
    expect(minted.ok).toBe(true);
    if (minted.ok) expect(minted.proposal.proposer).toEqual({ kind: 'model', model: 'test/model' });
  });
});

describe('the extraction schema is an allowlist', () => {
  /**
   * Mutation: add a `relations` field to `ExtractionWireSchema` so a model can
   * express objective membership as an edge. #3 models it as a field, the spike
   * measured both tiers misusing `depends_on` to mean "is about" five times,
   * and a relation between two *proposals* has nowhere to be appended.
   *
   * Asserted on the schema's own key set rather than on a rejection, because a
   * denylist of forbidden edge kinds is the thing this design replaces.
   */
  it('gives the model no way to say "relation"', () => {
    expect(Object.keys(ExtractionWireSchema.shape)).toEqual(['readings']);
    const readingShape = Object.keys(ExtractionWireSchema.shape.readings.element.shape);
    expect(readingShape).toEqual(['type', 'text', 'subject', 'confidence', 'quote', 'messageIds']);
  });

  /**
   * Mutation: give `messageIds` a `.default([])` or drop `.min(1)`. A reading
   * with no citation would reach `mintProposal`, be refused there, and appear
   * as a rejected reading rather than as malformed output — so the DLQ path
   * would never fire for a model that stopped citing anything.
   */
  it('refuses a reading that cites nothing at all', () => {
    expect(ExtractedReading.safeParse({ ...reading(), messageIds: [] }).success).toBe(false);
  });

  /** Mutation: make `quote` optional. The quote is the whole receipt. */
  it('refuses a reading with no quote', () => {
    expect(ExtractedReading.safeParse({ ...reading(), quote: '' }).success).toBe(false);
  });

  /** An empty answer is the correct answer for most windows, and must parse. */
  it('accepts an empty reading list', () => {
    expect(ExtractionOutput.parse({ readings: [] })).toEqual({ readings: [] });
  });
});
