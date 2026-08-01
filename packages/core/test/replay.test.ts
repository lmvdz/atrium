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
 * `issues` and `consumedEventIds` included, since those are the two places an
 * ordering bug hides.
 *
 * **The replay side does not ask the reducer what it consumed.** r3's version
 * did: it replayed the reducer's own `consumed` list, so any defect shared by
 * both paths — a gate that admits what it should refuse — cancelled out and the
 * equality passed anyway. Here the consumed sequence is reconstructed from the
 * *input* stream by `oracleConsumed`, a filter written in this file from the
 * contract text: strictly-increasing `(at, id)`, ids spent on consumption. The
 * reducer and the oracle are two independent readings of the same rule, and the
 * test fails if they disagree about either the sequence or the resulting state.
 *
 * The generated logs are deliberately nasty: two rooms, timestamps drawn from a
 * six-value pool so ties are constant, deliberate cross-room ties on one `at`,
 * ids that sort against insertion order, verbatim redeliveries, redeliveries
 * that re-minted their timestamp (including of events that failed the first
 * time), and model actors reaching for every human-only gate.
 */

const ROOMS = ['room_1', 'room_2'] as const;
const MINUTES = 6;

/** Where the re-minted redeliveries live: past every generated timestamp. */
const REMINT_BASE = 30;

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

function stamp(minute: number): string {
  return `2026-07-31T10:${String(minute).padStart(2, '0')}:00.000Z`;
}

function minute(rng: () => number): string {
  return stamp(1 + Math.floor(rng() * MINUTES));
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

// ─────────────────────────────────────────────────────────────────────────────
// The oracle: an independent reading of the consumption rule.
//
// Written from `appendEvent`'s contract, not from its code, and using nothing
// out of `../src` — not `compareCursor`, not `orderEvents`, not `foldEvents`.
// If the reducer's gate and this filter ever disagree about which events a log
// consumes, one of them is wrong and the corpus says so.
// ─────────────────────────────────────────────────────────────────────────────

interface Position {
  at: string;
  id: string;
}

/** Lexicographic on `(at, id)`, ascending. */
function oracleCompare(a: Position, b: Position): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * What a correct command layer consumes out of an arrival stream:
 *
 *  1. an event must sort **strictly after** the last consumed position;
 *  2. an id, once consumed, is spent — whatever the first delivery made of it,
 *     and whatever timestamp a later delivery carries.
 *
 * Everything else is refused and leaves no trace, so it is simply absent here.
 */
function oracleConsumed(arrival: readonly CoreEvent[]): CoreEvent[] {
  const consumed: CoreEvent[] = [];
  const spent = new Set<string>();
  let cursor: Position | null = null;

  for (const event of arrival) {
    const position: Position = { at: event.at, id: event.id };
    if (cursor !== null && oracleCompare(position, cursor) <= 0) continue;
    if (spent.has(event.id)) continue;
    consumed.push(event);
    spent.add(event.id);
    cursor = position;
  }
  return consumed;
}

// ─────────────────────────────────────────────────────────────────────────────
// The corpus.
// ─────────────────────────────────────────────────────────────────────────────

interface Staged {
  id: string;
  roomId: string;
  type: 'decision' | 'claim';
}

const payloadFor = (type: 'decision' | 'claim', text: string, verified = false) =>
  type === 'claim'
    ? { statement: text, claimant: BOB, ...(verified ? { verification: 'verified' as const } : {}) }
    : { statement: text, decidedBy: ALICE };

const HUMAN = { kind: 'human', userId: ALICE } as const;
const MODEL = { kind: 'model', model: 'test-model' } as const;

/**
 * A delivery stream: what a server's socket actually hands the reducer, warts
 * and all. Returned unsorted — the caller shuffles it further to simulate
 * arrival order.
 *
 * Every event a model has no authority to emit is generated on purpose, at a
 * rate that makes each gate fire across the corpus: decisions a model tries to
 * accept (with and without a proposal), claims a model tries to land
 * pre-verified, corrections in all three verbs, and supersessions aimed at
 * decisions. The coverage test below fails if any of them stops occurring.
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
          actor: MODEL,
          type: 'proposal_recorded',
          proposal: {
            id: proposalId,
            roomId,
            type,
            payload: payloadFor(type, `proposed ${index}`),
            confidence: 0.7,
            proposer: MODEL,
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
      // An acceptance. Cites a real proposal, a ghost, or nothing at all; the
      // actor is drawn independently of all of that, so the corpus contains
      // model acceptances of decisions (gate: a decision never auto-accepts),
      // model acceptances with no proposal at all (gate: direct acceptance),
      // and model acceptances of claims that arrive pre-verified (gate: ✓).
      const staged = proposals.length > 0 && rng() < 0.7 ? pick(rng, proposals) : undefined;
      const direct = staged === undefined && rng() < 0.5;
      const objectId = `obj_${index}`;
      const objectType = staged && rng() < 0.8 ? staged.type : type;
      const objectRoom = staged && rng() < 0.85 ? staged.roomId : roomId;
      const actor = rng() < 0.45 ? MODEL : HUMAN;
      const verified = objectType === 'claim' && rng() < 0.3;
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
            payload: payloadFor(objectType, `accepted ${index}`, verified),
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
      // A correction, half of them to objects that may not exist, a third of
      // them from a model — which may never correct anything.
      const target = objects.length > 0 && rng() < 0.75 ? pick(rng, objects) : undefined;
      const action = pick(rng, ['amend', 'retract', 'restore'] as const);
      const actor = rng() < 0.35 ? MODEL : HUMAN;
      events.push(
        parse({
          id,
          at,
          actor,
          type: 'object_corrected',
          objectId: target ? target.id : `obj_ghost_${index}`,
          action,
          ...(action === 'amend'
            ? {
                patch:
                  rng() < 0.3 ? { verification: 'verified' } : { statement: `amended ${index}` },
              }
            : {}),
          note: `note ${index}`,
        }),
      );
      continue;
    }

    if (roll < 0.94 && objects.length >= 2) {
      // A relation: often cross-room, often the wrong endpoint types, and
      // sometimes a model trying to retire a decision.
      let from = pick(rng, objects);
      let to = pick(rng, objects);
      const kind = pick(rng, ['supersedes', 'supersedes', 'answers', 'depends_on', 'blocks']);
      const actor = rng() < 0.35 ? MODEL : HUMAN;

      // A model reaching for the supersession gate is aimed, not left to
      // chance: a random endpoint pair almost always dies on an earlier check
      // (a ghost object, a cross-room edge) and the gate never runs. Point it
      // at two decisions in one room and the only thing left to refuse it is
      // the actor rule — which is the thing under test.
      if (kind === 'supersedes' && actor.kind === 'model') {
        const decisions = objects.filter((object) => object.type === 'decision');
        const byRoom = decisions.filter((object) => object.roomId === decisions[0]?.roomId);
        if (byRoom.length >= 2) {
          from = pick(rng, byRoom);
          const others = byRoom.filter((object) => object.id !== from.id);
          to = pick(rng, others);
        }
      }

      events.push(
        parse({
          id,
          at,
          actor,
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

    // A twin in the *other* room at exactly the same `at`: the cross-room tie
    // the global cursor exists to order. Both are objectives with no proposal
    // and a human actor, so neither can fail on business grounds — the only
    // thing under test here is which of them the ordering admits.
    const other = roomId === ROOMS[0] ? ROOMS[1] : ROOMS[0];
    for (const [suffix, room] of [
      ['a', roomId],
      ['b', other],
    ] as const) {
      events.push(
        parse({
          id: `${id}_tie_${suffix}`,
          at,
          actor: HUMAN,
          type: 'object_accepted',
          object: {
            id: `obj_tie_${index}_${suffix}`,
            roomId: room,
            type: 'objective',
            payload: { title: `tie ${index}${suffix}` },
            provenance: { messageIds: [`msg_${index}`], proposalId: null },
            createdAt: at,
            updatedAt: at,
          },
        }),
      );
    }
  }

  return events;
}

/**
 * One aimed attempt at each human-only gate, staged on objects it accepts for
 * itself so nothing else can refuse them first.
 *
 * The random log reaches these gates too, but only by luck: a model
 * supersession usually dies on a ghost endpoint or a cross-room edge long
 * before the actor rule runs, and a coverage assertion that depends on the
 * shape of an rng stream is a coverage assertion that will quietly stop
 * covering. These are deliberate, one per gate, per seed.
 *
 * Timestamps sit past the generator's six-minute pool and before the re-minted
 * redeliveries, so in near-in-order delivery they land at the end of the log.
 */
function gateProbes(seed: number): CoreEvent[] {
  const room = ROOMS[0];
  const tag = `probe_${seed}`;
  const object = (
    index: number,
    type: 'decision' | 'claim',
    payload: Record<string, unknown>,
    actor: typeof HUMAN | typeof MODEL,
    proposalId: string | null,
  ) =>
    parse({
      id: `${tag}_${index}`,
      at: stamp(index),
      actor,
      type: 'object_accepted',
      object: {
        id: `pobj_${seed}_${index}`,
        roomId: room,
        type,
        payload,
        provenance: { messageIds: [`msg_${tag}`], proposalId },
        createdAt: stamp(index),
        updatedAt: stamp(index),
      },
    });

  return [
    // Two decisions a human accepted, for the supersession and correction
    // probes to aim at.
    object(10, 'decision', { statement: `${tag} first`, decidedBy: ALICE }, HUMAN, null),
    object(11, 'decision', { statement: `${tag} second`, decidedBy: ALICE }, HUMAN, null),
    // Gate: a decision never auto-accepts — even through a proposal the model
    // itself staged, which is the whole point of the rule.
    parse({
      id: `${tag}_12`,
      at: stamp(12),
      actor: MODEL,
      type: 'proposal_recorded',
      proposal: {
        id: `pprop_${seed}`,
        roomId: room,
        type: 'decision',
        payload: { statement: `${tag} proposed`, decidedBy: ALICE },
        confidence: 0.99,
        proposer: MODEL,
        provenance: [`msg_${tag}`],
        createdAt: stamp(12),
      },
    }),
    object(
      13,
      'decision',
      { statement: `${tag} proposed`, decidedBy: ALICE },
      MODEL,
      `pprop_${seed}`,
    ),
    // Gate: `~` never becomes `✓` on a model's word.
    object(
      14,
      'claim',
      { statement: `${tag} verified`, claimant: BOB, verification: 'verified' },
      MODEL,
      null,
    ),
    // Gate: no proposal, no human, no object.
    object(15, 'claim', { statement: `${tag} direct`, claimant: BOB }, MODEL, null),
    // Gate: retiring an accepted decision is human-only.
    parse({
      id: `${tag}_16`,
      at: stamp(16),
      actor: MODEL,
      type: 'relation_added',
      relation: {
        id: `prel_${seed}`,
        roomId: room,
        kind: 'supersedes',
        fromObjectId: `pobj_${seed}_11`,
        to: { kind: 'object', objectId: `pobj_${seed}_10` },
        createdAt: stamp(16),
      },
    }),
    // Gate: every correction verb is human-only.
    parse({
      id: `${tag}_17`,
      at: stamp(17),
      actor: MODEL,
      type: 'object_corrected',
      objectId: `pobj_${seed}_10`,
      action: 'amend',
      patch: { statement: `${tag} quietly reworded` },
    }),
  ];
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

/**
 * The nastier redelivery: same id, a *later* timestamp.
 *
 * A verbatim copy lands on the cursor and the ordering gate stops it without
 * ever consulting the id. This one clears the ordering gate — it is genuinely
 * ahead of everything consumed — so only the spent id can refuse it. That is
 * r4's first pin, and it bites hardest on events that *failed* the first time:
 * under the old rule those ids were never recorded, so a re-minted copy would
 * be retried against a state that had moved on and could turn a refusal into an
 * acceptance.
 *
 * Appended at the end of the arrival stream, so everything they shadow has
 * already been delivered.
 */
function withRemintedRedeliveries(events: readonly CoreEvent[], seed: number): CoreEvent[] {
  const rng = makeRng(seed);
  const seen = new Set<string>();
  const candidates: CoreEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (rng() < 0.15) candidates.push(event);
  }
  return [
    ...events,
    ...candidates.map((event, index) => ({ ...event, at: stamp(REMINT_BASE + index) })),
  ];
}

interface Rejection {
  event: CoreEvent;
  reason: string;
}

interface Run {
  state: CoreState;
  consumed: CoreEvent[];
  rejections: Rejection[];
  /** Ids consumed *with a business issue* — the ones r3 forgot to spend. */
  failedIds: Set<string>;
  counts: Record<string, number>;
}

/** The live path: one event at a time, in arrival order, through `appendEvent`. */
function foldLive(events: readonly CoreEvent[]): Run {
  let state = reduce([]);
  const consumed: CoreEvent[] = [];
  const rejections: Rejection[] = [];
  const failedIds = new Set<string>();
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
      rejections.push({ event, reason: result.reason });
      continue;
    }
    expect(wasConsumed(result)).toBe(true);
    counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
    if (result.outcome === 'applied_with_issue') failedIds.add(event.id);
    consumed.push(event);
    state = result.state;
  }

  return { state, consumed, rejections, failedIds, counts };
}

/** The room an *input* event names. Test-local, for the tie assertions. */
function roomOfInput(event: CoreEvent): string | null {
  if (event.type === 'proposal_recorded') return event.proposal.roomId;
  if (event.type === 'object_accepted') return event.object.roomId;
  if (event.type === 'relation_added') return event.relation.roomId;
  return null;
}

/**
 * Near-in-order delivery: the log as the log is, with adjacent frames swapped
 * here and there. This is what a real socket does — a full shuffle is the
 * adversarial case, and a stream that is 80% ordered is the ordinary one. It
 * matters for coverage as much as for realism: under a full shuffle the
 * ordering gate admits only an increasing subsequence, so most events never
 * reach a business rule at all and the rarer gates stop firing.
 */
function jitter(events: readonly CoreEvent[], seed: number): CoreEvent[] {
  const rng = makeRng(seed);
  const out = [...events].sort((a, b) =>
    oracleCompare({ at: a.at, id: a.id }, { at: b.at, id: b.id }),
  );
  for (let index = 0; index < out.length - 1; index += 1) {
    if (rng() >= 0.25) continue;
    const here = out[index] as CoreEvent;
    const next = out[index + 1] as CoreEvent;
    out[index] = next;
    out[index + 1] = here;
    index += 1;
  }
  return out;
}

type Delivery = 'shuffled' | 'jittered';

/** The full arrival stream for a seed: generated, disordered, then redelivered. */
function arrivalStream(seed: number, delivery: Delivery = 'shuffled'): CoreEvent[] {
  const generated = [...generateLog(seed, 60), ...gateProbes(seed)];
  const disordered =
    delivery === 'shuffled' ? shuffle(generated, seed * 7 + 1) : jitter(generated, seed * 11 + 3);
  return withRemintedRedeliveries(withRedeliveries(disordered, seed), seed * 3 + 2);
}

/** Refusal texts the corpus must keep producing, one per human-only gate. */
const GATE_MARKERS = {
  direct_acceptance: 'only a human may accept an object directly',
  decision_acceptance: 'never auto-accepts',
  claim_verification: 'would become a verified claim',
  decision_supersession: 'retires an accepted decision',
  correction: 'corrections (amend, retract, restore)',
} as const;

describe('live≡replay — generated logs, an independent oracle, adversarial redeliveries', () => {
  const seeds = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
  const totals: Record<string, number> = {};
  const gatesSeen = new Set<string>();
  let sawIssues = false;
  let sawConsumed = false;
  let sawRemintedDuplicateOfFailure = false;
  let sawCrossRoomTie = false;
  let sawOracleDrop = false;

  const deliveries: Delivery[] = ['shuffled', 'jittered'];

  for (const seed of seeds) {
    for (const delivery of deliveries) {
      it(`folds a ${delivery} 60-event log to the replay the oracle reconstructs (seed ${seed})`, () => {
        const arrival = arrivalStream(seed, delivery);
        const live = foldLive(arrival);

        // The independent half: what a correct gate consumes out of this exact
        // arrival stream, decided without asking the reducer anything.
        const expected = oracleConsumed(arrival);
        const replayed = reduce(expected);

        // The reducer and the oracle agree on the sequence …
        expect(live.consumed.map((event) => event.id)).toEqual(expected.map((event) => event.id));
        // … and folding that sequence in one shot lands on the same bytes.
        expect(serializeState(live.state)).toBe(serializeState(replayed));

        // Spelled out for the fields an ordering bug hides in. Compared in full —
        // nothing is stripped before comparing.
        expect(live.state.issues).toEqual(replayed.issues);
        expect(live.state.consumedEventIds).toEqual(replayed.consumedEventIds);
        expect(live.state.consumedEventIds).toEqual(expected.map((event) => event.id));
        expect(live.state.cursor).toEqual(replayed.cursor);
        expect(live.state.watermarks).toEqual(replayed.watermarks);

        // And the replay does not depend on the order the consumed log is handed
        // back in either — `reduce` sorts, so any shuffle of it lands identically.
        expect(serializeState(reduce(shuffle(expected, seed + 17)))).toBe(serializeState(replayed));

        for (const [key, value] of Object.entries(live.counts)) {
          totals[key] = (totals[key] ?? 0) + value;
        }
        for (const [gate, marker] of Object.entries(GATE_MARKERS)) {
          if (live.state.issues.some((issue) => issue.reason.includes(marker))) gatesSeen.add(gate);
        }
        sawIssues ||= live.state.issues.length > 0;
        sawConsumed ||= live.state.consumedEventIds.length > 0;
        sawOracleDrop ||= expected.length < arrival.length;
        sawRemintedDuplicateOfFailure ||= live.rejections.some(
          (rejection) =>
            rejection.reason === 'duplicate' &&
            rejection.event.at >= stamp(REMINT_BASE) &&
            live.failedIds.has(rejection.event.id),
        );

        const roomsByAt = new Map<string, Set<string>>();
        for (const event of live.consumed) {
          const room = roomOfInput(event);
          if (room === null) continue;
          const set = roomsByAt.get(event.at) ?? new Set<string>();
          set.add(room);
          roomsByAt.set(event.at, set);
        }
        sawCrossRoomTie ||= [...roomsByAt.values()].some((set) => set.size > 1);
      });
    }
  }

  it('exercised every outcome, so the equality above is not vacuous', () => {
    expect(totals.applied ?? 0).toBeGreaterThan(0);
    expect(totals.applied_with_issue ?? 0).toBeGreaterThan(0);
    expect(totals.out_of_order ?? 0).toBeGreaterThan(0);
    expect(totals.duplicate ?? 0).toBeGreaterThan(0);
    expect(sawIssues).toBe(true);
    expect(sawConsumed).toBe(true);
    // The oracle actually refused things. An oracle that consumed everything
    // would make the equality trivially true.
    expect(sawOracleDrop).toBe(true);
  });

  it('exercised the adversarial classes r4 added, not just the r3 ones', () => {
    // A redelivery of an event that FAILED the first time, carrying a later
    // timestamp so the ordering gate cannot see it. This is the exact shape
    // that was consumable before `consumedEventIds`.
    expect(sawRemintedDuplicateOfFailure).toBe(true);
    // Two rooms, one timestamp, both consumed — ordered by the global cursor.
    expect(sawCrossRoomTie).toBe(true);
    // Every human-only gate was reached for by a model somewhere in the corpus.
    expect([...gatesSeen].sort()).toEqual(Object.keys(GATE_MARKERS).sort());
  });

  it('generates the same corpus twice — the stream itself is deterministic', () => {
    expect(generateLog(42, 40).map((e) => e.id)).toEqual(generateLog(42, 40).map((e) => e.id));
    expect(arrivalStream(42).map((e) => `${e.id}@${e.at}`)).toEqual(
      arrivalStream(42).map((e) => `${e.id}@${e.at}`),
    );
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
    const live = foldLive(arrivalStream(3));
    expect(live.counts.out_of_order ?? 0).toBeGreaterThan(0);
    expect(live.state.issues.every((issue) => !issue.reason.includes('sort strictly after'))).toBe(
      true,
    );
  });

  it('is an oracle that can fail — a re-minted redelivery changes the state it admits', () => {
    // The oracle earns its keep only if consuming one extra event would show.
    // Same stream twice, except the tail carries a fresh id instead of a spent
    // one: the oracle takes the fresh one and the states differ. So "the
    // reducer agreed with the oracle" is a real constraint, not a tautology.
    const base = generateLog(11, 20);
    const first = base[0];
    if (!first) throw new Error('generator changed');
    const spentTail = [...base, { ...first, at: stamp(REMINT_BASE) }];
    const freshTail = [...base, { ...first, id: `${first.id}_fresh`, at: stamp(REMINT_BASE) }];

    const spentConsumed = oracleConsumed(spentTail);
    const freshConsumed = oracleConsumed(freshTail);

    expect(spentConsumed.filter((event) => event.id === first.id)).toHaveLength(1);
    expect(spentConsumed).toHaveLength(freshConsumed.length - 1);
    expect(serializeState(reduce(spentConsumed))).not.toBe(serializeState(reduce(freshConsumed)));
  });
});
