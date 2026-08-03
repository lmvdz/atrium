import {
  type AuthoredEvent,
  authored,
  type CoreEvent,
  emptyState,
  type ProvenanceMessage,
  reduce,
} from '@atrium/core';
import { describe, expect, it } from 'vitest';
import { assemblePrompt, EXTRACTION_INSTRUCTION, renderTranscript } from '../src/jobs/prompt.js';

/**
 * The prompt, and the two amendments it exists to hold.
 *
 * #8's resolution put a compressed accepted-state view in this prompt and its
 * second amendment took it back out on measurement. A prompt is the easiest
 * thing in a codebase to quietly re-add a paragraph to, so the absence is
 * asserted rather than commented.
 */

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ROOM = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const M1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const M2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

const WINDOW: ProvenanceMessage[] = [
  { id: M1, authorId: ALICE, body: 'We are going with Postgres for the queue.' },
  { id: M2, authorId: BOB, body: '> We are going with Postgres\n\nAgreed.' },
];

/**
 * A room holding two accepted claims, one of which was later corrected.
 *
 * The uncorrected one is the load-bearing half: a correction counterexample
 * legitimately quotes the sentence it corrected, so "the corrected statement is
 * absent" would be a test that fails for the right feature. `UNTOUCHED` was
 * never corrected, so the only way it can reach a prompt is an accepted-state
 * block — which is the thing #8's second amendment removed.
 */
const CORRECTED = 'Postgres handles the queue';
const UNTOUCHED = 'The migration runs before the server boots';

function roomWithAcceptedStateAndACorrection() {
  const at = (n: number) => `2026-08-01T00:00:0${n}.000Z`;
  const objectId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
  const otherObjectId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';
  const proposalIdent = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
  const otherProposalIdent = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
  const claim = (statement: string) => ({
    statement,
    claimant: ALICE,
    verification: 'unverified' as const,
  });
  const events: CoreEvent[] = [
    {
      id: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
      at: at(1),
      type: 'proposal_recorded',
      proposal: {
        id: proposalIdent,
        roomId: ROOM,
        type: 'claim',
        payload: claim(CORRECTED),
        confidence: 0.9,
        proposer: { kind: 'human', userId: ALICE },
        provenance: [M1],
        quote: 'We are going with Postgres for the queue.',
        interpretationId: null,
        status: 'proposed',
        createdAt: at(1),
      },
    },
    {
      id: 'ffffffff-ffff-4fff-8fff-fffffffffff2',
      at: at(2),
      type: 'object_accepted',
      object: {
        id: objectId,
        roomId: ROOM,
        type: 'claim',
        payload: claim(CORRECTED),
        objectiveId: null,
        provenance: { messageIds: [M1], proposalId: proposalIdent, interpretationId: null },
        createdAt: at(2),
        updatedAt: at(2),
      },
    },
    {
      id: 'ffffffff-ffff-4fff-8fff-fffffffffff3',
      at: at(3),
      type: 'object_corrected',
      objectId,
      action: 'retype',
      patch: {},
      toType: 'decision',
      provenance: { messageIds: [], proposalId: null, interpretationId: null },
      note: 'this was the call, not a claim about the world',
    },
    {
      id: 'ffffffff-ffff-4fff-8fff-fffffffffff4',
      at: at(4),
      type: 'proposal_recorded',
      proposal: {
        id: otherProposalIdent,
        roomId: ROOM,
        type: 'claim',
        payload: claim(UNTOUCHED),
        confidence: 0.9,
        proposer: { kind: 'human', userId: ALICE },
        provenance: [M1],
        quote: 'We are going with Postgres for the queue.',
        interpretationId: null,
        status: 'proposed',
        createdAt: at(4),
      },
    },
    {
      id: 'ffffffff-ffff-4fff-8fff-fffffffffff5',
      at: at(5),
      type: 'object_accepted',
      object: {
        id: otherObjectId,
        roomId: ROOM,
        type: 'claim',
        payload: claim(UNTOUCHED),
        objectiveId: null,
        provenance: { messageIds: [M1], proposalId: otherProposalIdent, interpretationId: null },
        createdAt: at(5),
        updatedAt: at(5),
      },
    },
  ];
  const log: AuthoredEvent[] = events.map((event) =>
    authored(event, { actor: { kind: 'human', userId: ALICE }, messages: WINDOW }),
  );
  return reduce(log, emptyState());
}

describe('the extraction prompt', () => {
  /**
   * Mutation: re-add an accepted-state block ("## What this room has already
   * settled …"). The spike measured recall collapsing 19 → 11 objects with one
   * present, the dispute edge lost, and zero cross-window relations. Dedup is
   * `findDuplicate`'s job (#8 amendment 2), and it happens after the call.
   */
  it('carries no accepted state, only the transcript and corrections', () => {
    const state = roomWithAcceptedStateAndACorrection();
    const prompt = assemblePrompt({ messages: WINDOW, state });
    expect(Object.keys(state.objects)).toHaveLength(2);
    // The one nobody corrected can only have reached a prompt through an
    // accepted-state block, and there is none.
    expect(prompt.prompt).not.toContain(UNTOUCHED);
    expect(prompt.prompt).not.toContain('## Accepted');
    expect(prompt.prompt).toContain('## Transcript');
    // The corrected one appears exactly once, and only as the counterexample it
    // is — quoting what a person changed, not listing what the room believes.
    expect(prompt.prompt.split(CORRECTED)).toHaveLength(2);
    expect(prompt.prompt.indexOf(CORRECTED)).toBeGreaterThan(
      prompt.prompt.indexOf('corrected earlier readings'),
    );
  });

  /**
   * Mutation: drop the corrections section, or stop passing `state`. #5's whole
   * point is that a correction teaches something no downstream rule can — it is
   * about this room's habits, not about the sentence.
   */
  it('injects the room’s corrections as counterexamples', () => {
    const state = roomWithAcceptedStateAndACorrection();
    const prompt = assemblePrompt({ messages: WINDOW, state });
    expect(prompt.counterexampleCount).toBe(1);
    expect(prompt.prompt).toContain('How this room has corrected earlier readings');
    expect(prompt.prompt).toContain('this was the call, not a claim about the world');
  });

  /** Mutation: emit an empty corrections heading for a room with none. */
  it('says nothing about corrections when a room has none', () => {
    const prompt = assemblePrompt({ messages: WINDOW });
    expect(prompt.counterexampleCount).toBe(0);
    expect(prompt.prompt).not.toContain('corrected earlier readings');
  });

  /**
   * Mutation: render the transcript without message ids. The ids are the
   * receipt: a model that cannot see them cannot cite them, `mintProposal`
   * refuses every reading, and the worker silently produces nothing.
   */
  it('prints the id and author beside every message', () => {
    const rendered = renderTranscript(WINDOW);
    expect(rendered).toContain(`--- message ${M1} · author ${ALICE} ---`);
    expect(rendered).toContain(`--- message ${M2} · author ${BOB} ---`);
  });

  /**
   * Mutation: reformat a body — strip the `> ` prefixes, collapse whitespace,
   * "clean it up". The quote check downstream compares against the message's
   * stored body, so a prompt that shows the model different text than the
   * receipt is checked against makes every quote fail for reasons nobody can
   * see.
   */
  it('carries message bodies verbatim, blockquotes included', () => {
    expect(renderTranscript(WINDOW)).toContain('> We are going with Postgres\n\nAgreed.');
  });

  /**
   * Mutation: soften the precision-first sentence, or drop the blockquote
   * attribution rule. The spike names both as spec rather than garnish: zero
   * hallucinated decisions in six runs came from the first, and its worst
   * single error — a claim attributed to the wrong person at 0.98 confidence —
   * is what the second addresses.
   */
  it('states the precision rule and the blockquote attribution rule', () => {
    expect(EXTRACTION_INSTRUCTION).toContain('Precision beats recall');
    expect(EXTRACTION_INSTRUCTION).toContain('an empty list is a correct and common answer');
    expect(EXTRACTION_INSTRUCTION).toMatch(/quoted-reply/);
    expect(EXTRACTION_INSTRUCTION).toContain('VERBATIM');
  });

  /** The coalescing receipt: one prompt, every drained message in it. */
  it('reports how many messages went into the one call', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `msg-${i}`,
      authorId: ALICE,
      body: `line ${i}`,
    }));
    const prompt = assemblePrompt({ messages: many });
    expect(prompt.messageCount).toBe(12);
    for (const message of many) expect(prompt.prompt).toContain(message.id);
  });
});
