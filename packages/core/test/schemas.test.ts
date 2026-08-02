import { describe, expect, it } from 'vitest';
import {
  AcceptedObject,
  AcceptedObjectType,
  AttentionItem,
  CoreEvent,
  type CoreEventInput,
  Proposal,
  Relation,
  RelationKind,
  rationaleFor,
  relationShapeError,
  renderRationale,
} from '../src/index.js';
import { ALICE, at, BOB, ROOM } from './fixtures.js';

describe('accepted object schemas', () => {
  it('covers exactly the five first-class types from issue #3', () => {
    expect(AcceptedObjectType.options).toEqual([
      'decision',
      'commitment',
      'open_question',
      'claim',
      'objective',
    ]);
  });

  it('validates each type and fills its status default', () => {
    const cases = [
      { type: 'decision', payload: { statement: 'do it' }, expected: 'active' },
      { type: 'commitment', payload: { statement: 'do it', owner: ALICE }, expected: 'open' },
      { type: 'open_question', payload: { question: 'do it?' }, expected: 'open' },
      { type: 'claim', payload: { statement: 'it is done', claimant: ALICE }, expected: undefined },
      { type: 'objective', payload: { title: 'ship v1' }, expected: 'open' },
    ] as const;

    for (const testCase of cases) {
      const parsed = AcceptedObject.parse({
        id: `obj_${testCase.type}`,
        roomId: ROOM,
        type: testCase.type,
        payload: testCase.payload,
        createdAt: at(1),
        updatedAt: at(1),
      });
      expect(parsed.type).toBe(testCase.type);
      expect(parsed.provenance).toEqual({
        messageIds: [],
        proposalId: null,
        interpretationId: null,
      });
      if (testCase.expected) {
        expect((parsed.payload as { status: string }).status).toBe(testCase.expected);
      }
    }
  });

  it('defaults a claim to unverified — a claim never dresses as a fact', () => {
    const claim = AcceptedObject.parse({
      id: 'obj_claim',
      roomId: ROOM,
      type: 'claim',
      payload: { statement: 'the migration is reversible', claimant: ALICE },
      createdAt: at(1),
      updatedAt: at(1),
    });
    expect(claim.type === 'claim' && claim.payload.verification).toBe('unverified');
  });

  it('rejects an empty statement and an unknown status', () => {
    const base = { id: 'x', roomId: ROOM, createdAt: at(1), updatedAt: at(1) };
    expect(
      AcceptedObject.safeParse({ ...base, type: 'decision', payload: { statement: '' } }).success,
    ).toBe(false);
    expect(
      AcceptedObject.safeParse({
        ...base,
        type: 'decision',
        payload: { statement: 'ok', status: 'maybe' },
      }).success,
    ).toBe(false);
    expect(AcceptedObject.safeParse({ ...base, type: 'nope', payload: {} }).success).toBe(false);
  });
});

describe('proposal schema', () => {
  const valid = {
    id: 'prop_1',
    roomId: ROOM,
    type: 'decision',
    payload: { statement: 'do it' },
    confidence: 0.5,
    proposer: { kind: 'model', model: 'test-model' },
    provenance: ['msg_1'],
    quote: 'do it',
    createdAt: at(1),
  };

  it('parses a model proposal and defaults it to `proposed`', () => {
    const parsed = Proposal.parse(valid);
    expect(parsed.status).toBe('proposed');
    expect(parsed.provenance).toEqual(['msg_1']);
    expect(parsed.quote).toBe('do it');
    expect(parsed.interpretationId).toBeNull();
  });

  it('refuses a model proposal that cites no message — schema, not comment', () => {
    // Routed out of #19's gauntlet round 1: `provenance` carried the rule
    // "never empty for model proposals" as a doc comment and nothing else. A
    // model proposal with no receipt is an assertion, and the acceptance
    // boundary exists to refuse assertions.
    const result = Proposal.safeParse({ ...valid, provenance: [] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['provenance']);
    expect(result.error?.issues[0]?.message).toContain('at least one source message');
  });

  it('lets a human proposer cite nothing — the person is the receipt', () => {
    const parsed = Proposal.parse({
      ...valid,
      proposer: { kind: 'human', userId: ALICE },
      provenance: [],
    });
    expect(parsed.provenance).toEqual([]);
  });

  it('carries a verbatim quote, for provenance checking', () => {
    const parsed = Proposal.parse({ ...valid, quote: 'we should ship it behind a flag' });
    expect(parsed.quote).toBe('we should ship it behind a flag');
  });

  it('requires that quote from a model on every type, not only the two that name a person', () => {
    // Catches: scoping the schema's quote requirement back to
    // `claim || commitment`. r3's gauntlet minted a model *objective* with
    // `quote: null` through exactly that scope, and nothing downstream ran a
    // single receipt check on it — the citation array was non-empty, so the
    // window looked supplied, and no quote meant no quote check.
    const claim = { ...valid, type: 'claim', payload: { statement: 'x said y', claimant: BOB } };
    const unquoted = Proposal.safeParse({ ...claim, quote: null });
    expect(unquoted.success).toBe(false);
    expect(unquoted.error?.issues[0]?.path).toEqual(['quote']);
    expect(unquoted.error?.issues[0]?.message).toContain('names the sentence it rests on');
    expect(Proposal.safeParse({ ...claim, quote: '   ' }).success).toBe(false);
    expect(Proposal.safeParse({ ...claim, quote: 'x said y' }).success).toBe(true);

    const commitment = {
      ...valid,
      type: 'commitment',
      payload: { statement: 'land it', owner: BOB },
      quote: null,
    };
    expect(Proposal.safeParse(commitment).success).toBe(false);
    expect(Proposal.safeParse({ ...commitment, quote: "I'll land it" }).success).toBe(true);

    // The three that name nobody, which r3 exempted.
    for (const shape of [
      { type: 'decision', payload: { statement: 'do it' } },
      { type: 'open_question', payload: { question: 'do we?' } },
      { type: 'objective', payload: { title: 'ship the thing' } },
    ] as const) {
      expect(Proposal.safeParse({ ...valid, ...shape, quote: null }).success).toBe(false);
      expect(Proposal.safeParse({ ...valid, ...shape, quote: 'we agreed to' }).success).toBe(true);
    }
  });

  it('treats a quote of invisible characters as no quote at all', () => {
    // Catches: replacing `isBlank` with `.trim().length === 0`. A zero-width
    // space is not whitespace, so `trim()` keeps it and the proposal parses —
    // r3's gauntlet: the refusal downstream then happens for the wrong reason
    // ("not found in any cited message"), which is one refactor from no refusal.
    const claim = { ...valid, type: 'claim', payload: { statement: 'x said y', claimant: BOB } };
    for (const quote of ['​', '​ ‍', '﻿', '­', '…', '...', '    ']) {
      const result = Proposal.safeParse({ ...claim, quote });
      expect(result.success, `quote ${JSON.stringify(quote)} must not parse`).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['quote']);
    }
  });

  it('does not require a quote from a human proposer', () => {
    expect(
      Proposal.safeParse({
        ...valid,
        type: 'claim',
        payload: { statement: 'x said y', claimant: BOB },
        proposer: { kind: 'human', userId: ALICE },
        quote: null,
      }).success,
    ).toBe(true);
    expect(
      Proposal.safeParse({
        ...valid,
        type: 'open_question',
        payload: { question: 'do we?' },
        proposer: { kind: 'human', userId: ALICE },
        quote: null,
      }).success,
    ).toBe(true);
  });

  it('constrains confidence to 0..1', () => {
    expect(Proposal.safeParse({ ...valid, confidence: 1.5 }).success).toBe(false);
    expect(Proposal.safeParse({ ...valid, confidence: -0.1 }).success).toBe(false);
  });

  it('validates the payload against the same schema the accepted object uses', () => {
    expect(Proposal.safeParse({ ...valid, payload: { statement: '' } }).success).toBe(false);
    expect(
      Proposal.safeParse({ ...valid, type: 'commitment', payload: { statement: 'x' } }).success,
    ).toBe(false);
  });
});

describe('the event envelope — an actor cannot be forged because there is nowhere to put one', () => {
  const accepted = {
    id: 'ev_1',
    at: at(1),
    type: 'object_accepted' as const,
    object: {
      id: 'obj_1',
      roomId: ROOM,
      type: 'decision' as const,
      payload: { statement: 'do it' },
      createdAt: at(1),
      updatedAt: at(1),
    },
  };

  it('parses an event that carries no actor', () => {
    const parsed = CoreEvent.parse(accepted);
    expect(parsed).not.toHaveProperty('actor');
    expect(Object.keys(parsed)).not.toContain('actor');
  });

  it('refuses a payload that carries one, rather than stripping it silently', () => {
    // The round-1 blocking finding, closed at the boundary: a worker that sends
    // `actor: {kind:"human"}` is not quietly ignored, it is told no. Zod would
    // have dropped the key by default, which is safe and dishonest.
    const forged = CoreEvent.safeParse({ ...accepted, actor: { kind: 'human', userId: ALICE } });
    expect(forged.success).toBe(false);
    expect(forged.error?.issues[0]?.path).toEqual(['actor']);
    expect(forged.error?.issues[0]?.message).toContain('trusted argument to appendEvent');
  });

  it('refuses a forged actor on every event type', () => {
    const payloads = [
      accepted,
      { id: 'ev_2', at: at(2), type: 'proposal_rejected', proposalId: 'p' },
      { id: 'ev_3', at: at(3), type: 'object_corrected', objectId: 'o', action: 'retract' },
    ];
    for (const one of payloads) {
      expect(CoreEvent.safeParse({ ...one, actor: { kind: 'system' } }).success).toBe(false);
    }
  });

  it('will not type-check either, which is the half that catches it before runtime', () => {
    // @ts-expect-error — `actor` is not a member of any event variant.
    const attempt: CoreEventInput = { ...accepted, actor: { kind: 'system' } };
    expect(CoreEvent.safeParse(attempt).success).toBe(false);
  });
});

describe('relation schema', () => {
  it('covers exactly the five edge kinds from issue #3', () => {
    expect(RelationKind.options).toEqual([
      'supersedes',
      'depends_on',
      'blocks',
      'answers',
      'evidence',
    ]);
  });

  const relation = (over: Record<string, unknown>) =>
    Relation.parse({
      id: 'rel',
      roomId: ROOM,
      kind: 'supersedes',
      fromObjectId: 'a',
      to: { kind: 'object', objectId: 'b' },
      createdAt: at(1),
      ...over,
    });

  it('accepts a well-formed structural edge', () => {
    expect(relationShapeError(relation({}))).toBeNull();
  });

  it('rejects self-edges', () => {
    expect(relationShapeError(relation({ to: { kind: 'object', objectId: 'a' } }))).toContain(
      'cannot point an object at itself',
    );
  });

  it('rejects evidence pointing at an object', () => {
    expect(relationShapeError(relation({ kind: 'evidence' }))).toContain(
      'must target a message, url, or file',
    );
  });

  it('accepts evidence pointing at a url or a file', () => {
    expect(
      relationShapeError(
        relation({ kind: 'evidence', to: { kind: 'url', url: 'https://example.com' } }),
      ),
    ).toBeNull();
    expect(
      relationShapeError(relation({ kind: 'evidence', to: { kind: 'file', fileKey: 'k' } })),
    ).toBeNull();
  });

  it('rejects a malformed url target', () => {
    expect(
      Relation.safeParse({ ...relation({}), to: { kind: 'url', url: 'not-a-url' } }).success,
    ).toBe(false);
  });
});

describe('attention item schema', () => {
  const base = {
    id: 'attn_1',
    roomId: ROOM,
    userId: ALICE,
    objectId: 'obj_1',
    subjectKind: 'object',
    class: 'owned_commitment',
    createdAt: at(1),
  };
  const reason = { kind: 'commitment_open', statement: 'wire the flag in', due: null };

  it('requires a structured reason — no unexplained attention, and no free text', () => {
    expect(AttentionItem.safeParse(base).success).toBe(false);
    // The round-1 shape: a bare string that satisfied `min(1)` and meant
    // nothing. The brand did not bind at runtime, so this is what a store or an
    // API could hand back and have accepted.
    expect(AttentionItem.safeParse({ ...base, reason: 'because' }).success).toBe(false);
    expect(AttentionItem.safeParse({ ...base, rationale: 'you own it' }).success).toBe(false);
    expect(AttentionItem.parse({ ...base, reason }).status).toBe('pending');
  });

  it('refuses a reason kind the product does not have', () => {
    expect(
      AttentionItem.safeParse({ ...base, reason: { kind: 'because_i_said_so', statement: 'x' } })
        .success,
    ).toBe(false);
  });

  it('refuses an empty quotation inside a well-formed reason', () => {
    expect(
      AttentionItem.safeParse({ ...base, reason: { kind: 'commitment_confirm', statement: '' } })
        .success,
    ).toBe(false);
  });

  it('has no default for subjectKind — the wrong value there is unfalsifiable', () => {
    // #22's subject column is polymorphic: an item that silently defaults to
    // `object` points a foreign key at a proposal id and nothing complains.
    const { subjectKind: _dropped, ...withoutKind } = base;
    expect(AttentionItem.safeParse({ ...withoutKind, reason }).success).toBe(false);
  });

  it('renders its sentence from the reason, naming the person first', () => {
    const item = AttentionItem.parse({ ...base, reason });
    expect(renderRationale(item)).toBe(rationaleFor(ALICE, item.reason));
    expect(renderRationale(item).startsWith(`@${ALICE} — `)).toBe(true);
  });
});
