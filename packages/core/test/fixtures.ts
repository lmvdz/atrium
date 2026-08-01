import {
  AcceptedObject,
  type AcceptedObjectInput,
  type Actor,
  type AppendResult,
  type AuthoredEvent,
  appendEvent,
  authored,
  type CoreEvent,
  type CoreEventInput,
  CoreEvent as CoreEventSchema,
  type CoreState,
  emptyProvenance,
  type ProvenanceMessage,
} from '../src/index.js';

export const ROOM = 'room_1';
export const ALICE = 'user_alice';
export const BOB = 'user_bob';

/** Fixed timestamps — the core never reads a clock, so tests never need one. */
export function at(minute: number): string {
  const mm = String(minute).padStart(2, '0');
  return `2026-07-31T10:${mm}:00.000Z`;
}

export function object(input: AcceptedObjectInput) {
  return AcceptedObject.parse(input);
}

/** The raw payload, with no actor anywhere near it. */
export function payload(input: CoreEventInput): CoreEvent {
  return CoreEventSchema.parse(input);
}

/**
 * One ledger row, the way a command layer produces it: the payload, plus the
 * actor it authenticated and the messages it can show for the receipt.
 *
 * The `actor` key here is **not** part of the event — this helper is standing in
 * for the session lookup #22 will do, and it splits the actor out into the
 * trusted slot before the payload is ever parsed. Putting one in the payload is
 * a parse error, which `guards.test.ts` pins.
 */
export function event(
  input: CoreEventInput & { actor: Actor; messages?: readonly ProvenanceMessage[] },
): AuthoredEvent {
  const { actor, messages, ...rest } = input as Record<string, unknown> & {
    actor: Actor;
    messages?: readonly ProvenanceMessage[];
  };
  return authored(CoreEventSchema.parse(rest), {
    actor,
    ...(messages === undefined ? {} : { messages }),
  });
}

/**
 * A ledger row whose payload is **not parsed** — the shape a command layer
 * actually hands over when the event came off a wire, out of a jsonb column, or
 * through any call site TypeScript could not see.
 *
 * This is the one deliberate cast in the test suite, and it exists because r2's
 * gauntlet found that its absence was the whole gap: `event()` above parses
 * every fixture, so the tests proved the *schemas* refuse things while proving
 * nothing about whether the reducer ever runs them. Rows built here go in raw,
 * exactly as an untyped caller's would.
 */
export function rawEvent(
  payload: unknown,
  trusted: { actor: Actor; messages?: readonly ProvenanceMessage[] },
): AuthoredEvent {
  return authored(payload as CoreEvent, trusted);
}

/** `appendEvent` for a ledger row — the payload and its trusted context, split. */
export function append(state: CoreState, entry: AuthoredEvent): AppendResult {
  return appendEvent(state, entry.event, entry);
}

/** The event ids of a log, in order. */
export function ids(log: readonly AuthoredEvent[]): string[] {
  return log.map((entry) => entry.event.id);
}

/** The same row, re-minted at a different position — a redelivery, as the wire makes one. */
export function reminted(
  entry: AuthoredEvent,
  changes: { at?: string; id?: string },
): AuthoredEvent {
  return {
    ...entry,
    event: {
      ...entry.event,
      ...(changes.at === undefined ? {} : { at: changes.at }),
      ...(changes.id === undefined ? {} : { id: changes.id }),
    },
  };
}

export const human = (userId = ALICE) => ({ kind: 'human', userId }) as const;
export const model = (name = 'test-model') => ({ kind: 'model', model: name }) as const;
export const system = () => ({ kind: 'system' }) as const;

/**
 * The room's messages, as the trusted context supplies them.
 *
 * `msg_1` is ALICE's own words and `msg_3` is BOB's, so a claim of ALICE's
 * quoting `msg_1` has a receipt that holds and a commitment owned by BOB quoting
 * `msg_3` is self-stated. `msg_2` is BOB quoting ALICE — the blockquote shape
 * that makes a receipt look right and be wrong.
 */
export const MESSAGES: ProvenanceMessage[] = [
  { id: 'msg_1', authorId: ALICE, body: 'Ship the scaffold behind a flag, I think.' },
  { id: 'msg_2', authorId: BOB, body: '> Ship the scaffold behind a flag, I think.\n\nAgreed.' },
  { id: 'msg_3', authorId: BOB, body: "I'll wire the flag into the server tomorrow." },
  { id: 'msg_4', authorId: ALICE, body: 'Do we keep the flag after launch?' },
  { id: 'msg_5', authorId: ALICE, body: 'Drop the flag; ship it on.' },
];

/**
 * A small but complete log: a model proposes a decision, a human accepts it,
 * amends the wording, opens a commitment and a question, then a second decision
 * supersedes the first and answers the question.
 */
export function sampleLog(): AuthoredEvent[] {
  return [
    event({
      id: 'ev_01',
      at: at(1),
      actor: model(),
      type: 'proposal_recorded',
      proposal: {
        id: 'prop_1',
        roomId: ROOM,
        type: 'decision',
        payload: { statement: 'Ship the scaffold behind a flag' },
        confidence: 0.82,
        proposer: { kind: 'model', model: 'test-model' },
        provenance: ['msg_1', 'msg_2'],
        quote: 'Ship the scaffold behind a flag',
        createdAt: at(1),
      },
    }),
    event({
      id: 'ev_02',
      at: at(2),
      actor: human(),
      type: 'object_accepted',
      object: {
        id: 'obj_decision_1',
        roomId: ROOM,
        type: 'decision',
        payload: { statement: 'Ship the scaffold behind a flag', decidedBy: ALICE },
        provenance: { messageIds: ['msg_1', 'msg_2'], proposalId: 'prop_1' },
        createdAt: at(2),
        updatedAt: at(2),
      },
    }),
    event({
      id: 'ev_03',
      at: at(3),
      actor: human(),
      type: 'object_corrected',
      objectId: 'obj_decision_1',
      action: 'amend',
      patch: { statement: 'Ship the scaffold behind a flag, default off' },
      note: 'that was the wording we actually agreed',
    }),
    event({
      id: 'ev_04',
      at: at(4),
      actor: human(BOB),
      type: 'object_accepted',
      object: {
        id: 'obj_commitment_1',
        roomId: ROOM,
        type: 'commitment',
        payload: { statement: 'Wire the flag into the server', owner: BOB, due: at(9) },
        provenance: { ...emptyProvenance, messageIds: ['msg_3'] },
        createdAt: at(4),
        updatedAt: at(4),
      },
    }),
    event({
      id: 'ev_05',
      at: at(5),
      actor: human(),
      type: 'object_accepted',
      object: {
        id: 'obj_question_1',
        roomId: ROOM,
        type: 'open_question',
        payload: { question: 'Do we keep the flag after launch?' },
        provenance: { ...emptyProvenance, messageIds: ['msg_4'] },
        createdAt: at(5),
        updatedAt: at(5),
      },
    }),
    event({
      id: 'ev_06',
      at: at(6),
      actor: human(),
      type: 'object_accepted',
      object: {
        id: 'obj_decision_2',
        roomId: ROOM,
        type: 'decision',
        payload: { statement: 'Drop the flag; ship it on', decidedBy: ALICE },
        provenance: { ...emptyProvenance, messageIds: ['msg_5'] },
        createdAt: at(6),
        updatedAt: at(6),
      },
    }),
    event({
      id: 'ev_07',
      at: at(7),
      actor: human(),
      type: 'relation_added',
      relation: {
        id: 'rel_1',
        roomId: ROOM,
        kind: 'supersedes',
        fromObjectId: 'obj_decision_2',
        to: { kind: 'object', objectId: 'obj_decision_1' },
        createdAt: at(7),
      },
    }),
    event({
      id: 'ev_08',
      at: at(8),
      actor: human(),
      type: 'relation_added',
      relation: {
        id: 'rel_2',
        roomId: ROOM,
        kind: 'answers',
        fromObjectId: 'obj_question_1',
        to: { kind: 'object', objectId: 'obj_decision_2' },
        createdAt: at(8),
      },
    }),
  ];
}

/**
 * Deterministic shuffle (no Math.random — a flaky determinism test would be
 * worse than none). Linear-congruential walk over the index space.
 */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}
