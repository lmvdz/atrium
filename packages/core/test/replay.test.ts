import { describe, expect, it } from 'vitest';
import {
  appendEvent,
  type CoreEvent,
  CoreEvent as CoreEventSchema,
  type CoreState,
  reduce,
  serializeState,
  wasConsumed,
} from '../src/index.js';
import { ALICE, BOB, shuffle } from './fixtures.js';

/**
 * The live≡replay invariant, checked property-style rather than by example.
 *
 * The claim under test is exactly the one `appendEvent` documents: for the
 * sequence of events a state actually *consumed*, folding them one at a time in
 * arrival order and replaying them all at once produce byte-identical states —
 * `issues` and `appliedEventIds` included, since those are the two places an
 * ordering bug hides. Rejected events are excluded from both sides, because a
 * rejected event never enters state here and (per #22) never enters the log.
 *
 * The generated logs are deliberately nasty: two rooms, timestamps drawn from a
 * six-value pool so ties are constant, ids that sort against insertion order,
 * verbatim redeliveries, and a mix of events that apply, events that record a
 * business issue, and events that arrive stale.
 */

const ROOMS = ['room_1', 'room_2'] as const;
const MINUTES = 6;

function makeRng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function minute(rng: () => number): string {
  const mm = String(1 + Math.floor(rng() * MINUTES)).padStart(2, '0');
  return `2026-07-31T10:${mm}:00.000Z`;
}

/**
 * `unknown` in, validated event out. The generator assembles `type` and
 * `payload` from separate draws, which TypeScript cannot correlate across a
 * discriminated union — so the schema does the checking, at runtime, on every
 * generated event. A generator that drifts out of spec fails loudly here.
 */
function parse(input: unknown): CoreEvent {
  return CoreEventSchema.parse(input);
}

interface Staged {
  id: string;
  roomId: string;
  type: 'decision' | 'claim';
}

const payloadFor = (type: 'decision' | 'claim', text: string) =>
  type === 'claim' ? { statement: text, claimant: BOB } : { statement: text, decidedBy: ALICE };

/**
 * A delivery stream: what a server's socket actually hands the reducer, warts
 * and all. Returned unsorted — the caller shuffles it further to simulate
 * arrival order.
 */
function generateLog(seed: number, size: number): CoreEvent[] {
  const rng = makeRng(seed);
  const events: CoreEvent[] = [];
  const proposals: Staged[] = [];
  const objects: Staged[] = [];

  const nextId = (index: number) =>
    // A random prefix so id order fights insertion order: every timestamp tie
    // then breaks somewhere the arrival sequence did not expect.
    `ev_${String(Math.floor(rng() * 90) + 10)}_${String(index).padStart(3, '0')}`;

  for (let index = 0; index < size; index += 1) {
    const id = nextId(index);
    const at = minute(rng);
    const roomId = pick(rng, ROOMS);
    const type = rng() < 0.5 ? 'decision' : 'claim';
    const roll = rng();

    if (roll < 0.24) {
      // A proposal. One in four arrives pre-blessed: coerced, with an issue.
      const proposalId = `prop_${index}`;
      const preBlessed = rng() < 0.25;
      events.push(
        parse({
          id,
          at,
          actor: { kind: 'model', model: 'test-model' },
          type: 'proposal_recorded',
          proposal: {
            id: proposalId,
            roomId,
            type,
            payload: payloadFor(type, `proposed ${index}`),
            confidence: 0.7,
            proposer: { kind: 'model', model: 'test-model' },
            provenance: [`msg_${index}`],
            createdAt: at,
            ...(preBlessed ? { status: 'accepted' as const } : {}),
          },
        }),
      );
      proposals.push({ id: proposalId, roomId, type });
      continue;
    }

    if (roll < 0.58) {
      // An acceptance. Cites a real proposal, a ghost, or nothing at all — and
      // the proposal-less ones are split between human and model actors so the
      // actor gate is exercised in both directions.
      const staged = proposals.length > 0 && rng() < 0.7 ? pick(rng, proposals) : undefined;
      const direct = staged === undefined && rng() < 0.5;
      const objectId = `obj_${index}`;
      const objectType = staged && rng() < 0.8 ? staged.type : type;
      const objectRoom = staged && rng() < 0.85 ? staged.roomId : roomId;
      const actor =
        direct && rng() < 0.5
          ? ({ kind: 'model', model: 'test-model' } as const)
          : ({ kind: 'human', userId: ALICE } as const);
      events.push(
        parse({
          id,
          at,
          actor,
          type: 'object_accepted',
          object: {
            id: objectId,
            roomId: objectRoom,
            type: objectType,
            payload: payloadFor(objectType, `accepted ${index}`),
            provenance: {
              messageIds: [`msg_${index}`],
              proposalId: staged ? staged.id : direct ? null : `prop_ghost_${index}`,
            },
            createdAt: at,
            updatedAt: at,
          },
        }),
      );
      objects.push({ id: objectId, roomId: objectRoom, type: objectType });
      continue;
    }

    if (roll < 0.76) {
      // A correction, half of them to objects that may not exist.
      const target = objects.length > 0 && rng() < 0.75 ? pick(rng, objects) : undefined;
      const action = pick(rng, ['amend', 'retract', 'restore'] as const);
      events.push(
        parse({
          id,
          at,
          actor: { kind: 'human', userId: ALICE },
          type: 'object_corrected',
          objectId: target ? target.id : `obj_ghost_${index}`,
          action,
          ...(action === 'amend' ? { patch: { statement: `amended ${index}` } } : {}),
          note: `note ${index}`,
        }),
      );
      continue;
    }

    if (roll < 0.94 && objects.length >= 2) {
      // A relation: often cross-room, often the wrong endpoint types.
      const from = pick(rng, objects);
      const to = pick(rng, objects);
      const kind = pick(rng, ['supersedes', 'answers', 'depends_on', 'blocks'] as const);
      events.push(
        parse({
          id,
          at,
          actor: { kind: 'human', userId: ALICE },
          type: 'relation_added',
          relation: {
            id: `rel_${index}`,
            roomId: rng() < 0.8 ? from.roomId : roomId,
            kind,
            fromObjectId: from.id,
            to: { kind: 'object', objectId: to.id },
            createdAt: at,
          },
        }),
      );
      continue;
    }

    // A verbatim redelivery of something already in the stream.
    const earlier = events.length > 0 ? pick(rng, events) : undefined;
    if (earlier) {
      events.push(earlier);
      continue;
    }

    events.push(
      parse({
        id,
        at,
        actor: { kind: 'human', userId: ALICE },
        type: 'proposal_rejected',
        proposalId: proposals.length > 0 ? pick(rng, proposals).id : `prop_ghost_${index}`,
        reason: `rejected ${index}`,
      }),
    );
  }

  return events;
}

/**
 * At-least-once delivery, as a transport actually produces it: the socket
 * re-sends the frame it just sent. Applied *after* shuffling, because a
 * redelivery is a property of the wire, not of the log's order.
 */
function withRedeliveries(events: readonly CoreEvent[], seed: number): CoreEvent[] {
  const rng = makeRng(seed);
  const out: CoreEvent[] = [];
  for (const event of events) {
    out.push(event);
    if (rng() < 0.15) out.push(event);
  }
  return out;
}

interface Run {
  state: CoreState;
  consumed: CoreEvent[];
  counts: Record<string, number>;
}

/** The live path: one event at a time, in arrival order, through `appendEvent`. */
function foldLive(events: readonly CoreEvent[]): Run {
  let state = reduce([]);
  const consumed: CoreEvent[] = [];
  const counts: Record<string, number> = {
    applied: 0,
    applied_with_issue: 0,
    out_of_order: 0,
    duplicate: 0,
  };

  for (const event of events) {
    const before = state;
    const result = appendEvent(state, event);
    if (result.outcome === 'rejected') {
      // The rejection contract, asserted on every rejected event of every
      // generated log rather than once by example.
      expect(result.state).toBe(before);
      counts[result.reason] = (counts[result.reason] ?? 0) + 1;
      continue;
    }
    expect(wasConsumed(result)).toBe(true);
    counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
    consumed.push(event);
    state = result.state;
  }

  return { state, consumed, counts };
}

describe('live≡replay — generated logs, mixed outcomes, same-`at` ties', () => {
  const seeds = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
  const totals: Record<string, number> = {};
  let sawIssues = false;
  let sawApplied = false;

  for (const seed of seeds) {
    it(`folds a shuffled 60-event log to the replay of what it consumed (seed ${seed})`, () => {
      const shuffled = withRedeliveries(shuffle(generateLog(seed, 60), seed * 7 + 1), seed);
      const live = foldLive(shuffled);
      const replayed = reduce(live.consumed);

      // The whole claim, in one line: the same bytes.
      expect(serializeState(live.state)).toBe(serializeState(replayed));

      // Spelled out for the two fields an ordering bug hides in. These are
      // compared in full — nothing is stripped before comparing.
      expect(live.state.issues).toEqual(replayed.issues);
      expect(live.state.appliedEventIds).toEqual(replayed.appliedEventIds);
      expect(live.state.cursor).toEqual(replayed.cursor);
      expect(live.state.watermarks).toEqual(replayed.watermarks);

      // And the replay does not depend on the order the consumed log is handed
      // back in either — `reduce` sorts, so any shuffle of it lands identically.
      expect(serializeState(reduce(shuffle(live.consumed, seed + 17)))).toBe(
        serializeState(replayed),
      );

      for (const [key, value] of Object.entries(live.counts)) {
        totals[key] = (totals[key] ?? 0) + value;
      }
      sawIssues ||= live.state.issues.length > 0;
      sawApplied ||= live.state.appliedEventIds.length > 0;
    });
  }

  it('exercised every outcome, so the equality above is not vacuous', () => {
    expect(totals.applied ?? 0).toBeGreaterThan(0);
    expect(totals.applied_with_issue ?? 0).toBeGreaterThan(0);
    expect(totals.out_of_order ?? 0).toBeGreaterThan(0);
    expect(totals.duplicate ?? 0).toBeGreaterThan(0);
    expect(sawIssues).toBe(true);
    expect(sawApplied).toBe(true);
  });

  it('generates the same log twice — the corpus itself is deterministic', () => {
    expect(generateLog(42, 40).map((e) => e.id)).toEqual(generateLog(42, 40).map((e) => e.id));
  });

  it('produces same-`at` ties, which is what the id tie-break is for', () => {
    const events = generateLog(7, 60);
    const byAt = new Map<string, number>();
    for (const event of events) byAt.set(event.at, (byAt.get(event.at) ?? 0) + 1);
    expect([...byAt.values()].filter((count) => count > 1).length).toBeGreaterThan(0);
  });

  it('rejects a stale event without a trace, across the whole corpus', () => {
    // Every seed, every rejection: the state object handed back is the one
    // handed in. Asserted inside `foldLive`; this pins that it actually ran.
    const live = foldLive(shuffle(generateLog(3, 60), 22));
    expect(live.counts.out_of_order ?? 0).toBeGreaterThan(0);
    expect(live.state.issues.every((issue) => !issue.reason.includes('sorts before'))).toBe(true);
  });
});
