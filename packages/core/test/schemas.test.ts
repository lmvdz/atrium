import { describe, expect, it } from 'vitest';
import {
  AcceptedObject,
  AcceptedObjectType,
  AttentionItem,
  Proposal,
  Relation,
  RelationKind,
  relationShapeError,
} from '../src/index.js';
import { ALICE, at, ROOM } from './fixtures.js';

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
    createdAt: at(1),
  };

  it('parses a model proposal and defaults it to `proposed`', () => {
    const parsed = Proposal.parse(valid);
    expect(parsed.status).toBe('proposed');
    expect(parsed.provenance).toEqual([]);
    expect(parsed.interpretationId).toBeNull();
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
  it('requires a non-empty rationale — no unexplained attention', () => {
    const base = {
      id: 'attn_1',
      roomId: ROOM,
      userId: ALICE,
      objectId: 'obj_1',
      class: 'owned_commitment',
      createdAt: at(1),
    };
    expect(AttentionItem.safeParse({ ...base, rationale: '' }).success).toBe(false);
    expect(AttentionItem.safeParse(base).success).toBe(false);
    expect(AttentionItem.parse({ ...base, rationale: 'you own it' }).status).toBe('pending');
  });
});
