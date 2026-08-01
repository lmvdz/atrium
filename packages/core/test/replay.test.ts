import { describe, expect, it } from 'vitest';
import {
  type Actor,
  type AuthoredEvent,
  appendEvent,
  authored,
  type CoreEvent,
  CoreEvent as CoreEventSchema,
  type CoreState,
  type ProvenanceMessage,
  reduce,
  serializeState,
  wasConsumed,
} from '../src/index.js';
import { ALICE, BOB, shuffle, UNCITED_TAIL } from './fixtures.js';

/**
 * The live≡replay invariant, checked property-style rather than by example.
 *
 * The claim under test is exactly the one `appendEvent` documents: for the
 * sequence of ledger rows a state actually *consumed*, folding them one at a
 * time in arrival order and replaying them all at once produce byte-identical
 * states — `issues` and `consumedEventIds` included, since those are the two
 * places an ordering bug hides.
 *
 * A **row**, not an event: the payload plus its trusted columns (the actor, and
 * the messages a receipt is checked against). Replaying a payload under a
 * different actor is replaying a different event, which is why #22 persists the
 * actor beside it and hands it back here.
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
 * time), and model actors reaching for every gate — the human-only ones, the
 * binding ones, and the receipt ones #21 r2 moved into the reducer.
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

/** One ledger row: the payload, plus the columns the command layer filled in. */
function row(input: unknown, actor: Actor, messages?: readonly ProvenanceMessage[]): AuthoredEvent {
  return authored(parse(input), { actor, ...(messages === undefined ? {} : { messages }) });
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
function oracleConsumed(arrival: readonly AuthoredEvent[]): AuthoredEvent[] {
  const consumed: AuthoredEvent[] = [];
  const spent = new Set<string>();
  let cursor: Position | null = null;

  for (const entry of arrival) {
    const position: Position = { at: entry.event.at, id: entry.event.id };
    if (cursor !== null && oracleCompare(position, cursor) <= 0) continue;
    if (spent.has(entry.event.id)) continue;
    consumed.push(entry);
    spent.add(entry.event.id);
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
  /** The statement that was staged — what an acceptance must carry verbatim. */
  text: string;
  /** The span it rests on, and the message that bears it. */
  quote: string;
  messageId: string;
  window: ProvenanceMessage[];
}

const payloadFor = (type: 'decision' | 'claim', text: string, verified = false) =>
  type === 'claim'
    ? { statement: text, claimant: BOB, ...(verified ? { verification: 'verified' as const } : {}) }
    : { statement: text, decidedBy: ALICE };

const HUMAN: Actor = { kind: 'human', userId: ALICE };
const MODEL: Actor = { kind: 'model', model: 'test-model' };
/**
 * A second interpreter. #7 runs two tiers against one room by construction, so
 * "another model reaching for this model's proposals" is the ordinary case, not
 * an adversarial one, and the corpus has to contain it.
 */
const OTHER_MODEL: Actor = { kind: 'model', model: 'other-model' };

/**
 * A delivery stream: what a server's socket actually hands the reducer, warts
 * and all. Returned unsorted — the caller shuffles it further to simulate
 * arrival order.
 *
 * Every event a model has no authority to emit is generated on purpose, at a
 * rate that makes each gate fire across the corpus: decisions a model tries to
 * accept (with and without a proposal), claims a model tries to land
 * pre-verified, corrections in all three verbs, supersessions aimed at
 * decisions, acceptances that mint a payload nobody staged, and acceptances
 * whose receipt the reducer cannot see. The coverage test below fails if any of
 * them stops occurring.
 */
function generateLog(seed: number, size: number): AuthoredEvent[] {
  const rng = makeRng(seed);
  const events: AuthoredEvent[] = [];
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
      // Confidence is drawn from both sides of the acceptance floor, so a model
      // acceptance in the corpus is sometimes one the floor must refuse.
      const proposalId = `prop_${index}`;
      const preBlessed = rng() < 0.25;
      // Long enough to clear `RECEIPT_POLICY.minQuoteLength`, because the quote
      // *is* this text and since r3 a short quote is a rejected receipt. A
      // corpus of two-word statements would have quietly turned every model
      // acceptance into a receipt failure and stopped testing the clean path.
      const text = `proposed ${index} on the shared migration plan`;
      const messageId = `msg_${index}`;
      const staged: Staged = {
        id: proposalId,
        roomId,
        type,
        text,
        quote: text,
        messageId,
        // Three sentences, the middle one being the quote: r4 requires the quote
        // to be whole sentences of the message, and a corpus whose every quote
        // was a fragment would have turned every model acceptance into a
        // receipt refusal and stopped testing the clean path.
        window: [{ id: messageId, authorId: BOB, body: `We talked. ${text}. Agreed.` }],
      };
      events.push(
        row(
          {
            id,
            at,
            type: 'proposal_recorded',
            proposal: {
              id: proposalId,
              roomId,
              type,
              payload: payloadFor(type, text),
              confidence: rng() < 0.3 ? 0.2 : 0.85,
              proposer: MODEL,
              provenance: [messageId],
              quote: text,
              createdAt: at,
              ...(preBlessed ? { status: 'accepted' as const } : {}),
            },
          },
          MODEL,
        ),
      );
      proposals.push(staged);
      continue;
    }

    if (roll < 0.3 && proposals.length > 0) {
      // A proposal retired or withdrawn by an actor drawn independently of who
      // staged it — so the corpus contains both the interpreter tidying up after
      // itself and a second interpreter reaching for somebody else's readings.
      const target = pick(rng, proposals);
      const actor = pick(rng, [MODEL, OTHER_MODEL, HUMAN, { kind: 'system' } as const]);
      const superseding = rng() < 0.5;
      events.push(
        row(
          {
            id,
            at,
            ...(superseding
              ? {
                  type: 'proposal_superseded',
                  proposalId: target.id,
                  supersededByProposalId:
                    proposals.length > 1 && rng() < 0.6 ? pick(rng, proposals).id : null,
                  reason: `re-read ${index}`,
                }
              : {
                  type: 'proposal_rejected',
                  proposalId: target.id,
                  reason: `withdrawn ${index}`,
                }),
          },
          actor,
        ),
      );
      continue;
    }

    if (roll < 0.58) {
      // An acceptance. Cites a real proposal, a ghost, or nothing at all; the
      // actor is drawn independently of all of that, so the corpus contains
      // model acceptances of decisions (gate: a decision never auto-accepts),
      // model acceptances with no proposal at all (gate: direct acceptance),
      // model acceptances of claims that arrive pre-verified (gate: ✓), and —
      // since r2 — acceptances that mint a payload nobody staged, cite messages
      // nobody staged, or arrive with no window to check at all.
      const staged = proposals.length > 0 && rng() < 0.7 ? pick(rng, proposals) : undefined;
      const direct = staged === undefined && rng() < 0.5;
      const objectId = `obj_${index}`;
      const objectType = staged && rng() < 0.8 ? staged.type : type;
      const objectRoom = staged && rng() < 0.85 ? staged.roomId : roomId;
      const actorRoll = rng();
      const actor = actorRoll < 0.3 ? MODEL : actorRoll < 0.45 ? OTHER_MODEL : HUMAN;
      const verified = objectType === 'claim' && rng() < 0.3;
      // Most acceptances carry the reading that was staged; some do not, which
      // is the payload-binding gate. Same for the citation set and the window.
      const faithful = staged !== undefined && rng() < 0.7;
      const text = faithful ? staged.text : `accepted ${index}`;
      const messageIds = faithful ? [staged.messageId] : [`msg_${index}`];
      const window = staged && rng() < 0.85 ? staged.window : undefined;
      events.push(
        row(
          {
            id,
            at,
            type: 'object_accepted',
            object: {
              id: objectId,
              roomId: objectRoom,
              type: objectType,
              payload: payloadFor(objectType, text, verified),
              provenance: {
                messageIds,
                proposalId: staged ? staged.id : direct ? null : `prop_ghost_${index}`,
              },
              createdAt: at,
              updatedAt: at,
            },
          },
          actor,
          window,
        ),
      );
      objects.push({
        id: objectId,
        roomId: objectRoom,
        type: objectType,
        text,
        quote: text,
        messageId: messageIds[0] as string,
        window: staged?.window ?? [],
      });
      continue;
    }

    if (roll < 0.76) {
      // A correction, a quarter of them to objects that may not exist, a third
      // of them from a model — which may never correct anything. All six verbs,
      // most of them aimed at objects they do not apply to, so the per-verb
      // applicability checks are exercised as hard as the authority one.
      const target = objects.length > 0 && rng() < 0.75 ? pick(rng, objects) : undefined;
      const action = pick(rng, [
        'amend',
        'retract',
        'restore',
        'retype',
        'reattribute',
        'reopen',
      ] as const);
      const actor = rng() < 0.35 ? MODEL : HUMAN;
      const patch = (): Record<string, unknown> => {
        if (action === 'amend') {
          return rng() < 0.3 ? { verification: 'verified' } : { statement: `amended ${index}` };
        }
        if (action === 'reattribute') {
          return rng() < 0.5 ? { claimant: BOB } : { decidedBy: ALICE };
        }
        if (action === 'retype') return rng() < 0.5 ? { claimant: BOB } : {};
        return {};
      };
      events.push(
        row(
          {
            id,
            at,
            type: 'object_corrected',
            objectId: target ? target.id : `obj_ghost_${index}`,
            action,
            ...(action === 'retype'
              ? { toType: pick(rng, ['decision', 'claim', 'open_question'] as const) }
              : {}),
            patch: patch(),
            provenance: { messageIds: [`msg_${index}`], proposalId: null },
            note: `note ${index}`,
          },
          actor,
        ),
      );
      continue;
    }

    if (roll < 0.94 && objects.length >= 2) {
      // A relation: often cross-room, often the wrong endpoint types, and
      // sometimes a model trying to retire a decision or settle a question.
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
        row(
          {
            id,
            at,
            type: 'relation_added',
            relation: {
              id: `rel_${index}`,
              roomId: rng() < 0.8 ? from.roomId : roomId,
              kind,
              fromObjectId: from.id,
              to: { kind: 'object', objectId: to.id },
              createdAt: at,
            },
          },
          actor,
        ),
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
        row(
          {
            id: `${id}_tie_${suffix}`,
            at,
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
          },
          HUMAN,
        ),
      );
    }
  }

  return events;
}

/**
 * One aimed attempt at each gate, staged on objects it accepts for itself so
 * nothing else can refuse them first.
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
function gateProbes(seed: number): AuthoredEvent[] {
  const room = ROOMS[0];
  const tag = `probe_${seed}`;
  // r4: the quote must be a run of *whole sentences* of the cited message. This
  // used to read `it is true that ${text}`, which makes every probe's quote a
  // span cut out of the middle of one — the exact shape r4's own blind review
  // turned into an auto-accept of an inverted claim.
  /**
   * The sentence, and nothing else in the message.
   *
   * r4 wrapped it in "Yes." and "Agreed." to prove a whole-sentence quote taken
   * from the middle of a message still certified. Since r5 that is exactly what
   * does *not* certify — a neighbouring sentence can reverse the quoted one —
   * so wrapping it here routed every claim acceptance in the corpus to
   * `receipt_not_certifiable` and left `confidence_floor` unreached, which the
   * gate-coverage assertion caught. The referral shape has its own case at
   * `${tag}_41`.
   *
   * **And the window carries a message the proposal does not cite, which is r6.**
   * `laterRevision` refuses a window holding nothing but the citations — the
   * correction scan then has nothing to read that the proposal did not choose —
   * so a one-message window routed every claim acceptance to
   * `receipt_not_certifiable` again, and the same coverage assertion caught it
   * again. That is the assertion earning its keep twice.
   */
  const claimWindow = (text: string): ProvenanceMessage[] => [
    { id: `msg_${tag}`, authorId: BOB, body: `${text}.` },
    UNCITED_TAIL,
  ];

  const object = (
    index: number,
    type: 'decision' | 'claim',
    payload: Record<string, unknown>,
    actor: Actor,
    proposalId: string | null,
    messages?: readonly ProvenanceMessage[],
  ) =>
    row(
      {
        id: `${tag}_${index}`,
        at: stamp(index),
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
      },
      actor,
      messages,
    );

  const modelClaimProposal = (
    index: number,
    proposalId: string,
    text: string,
    confidence: number,
  ) =>
    row(
      {
        id: `${tag}_${index}`,
        at: stamp(index),
        type: 'proposal_recorded',
        proposal: {
          id: proposalId,
          roomId: room,
          type: 'claim',
          payload: { statement: text, claimant: BOB },
          confidence,
          proposer: MODEL,
          provenance: [`msg_${tag}`],
          quote: text,
          createdAt: stamp(index),
        },
      },
      MODEL,
    );

  return [
    // Two decisions a human accepted, for the supersession and correction
    // probes to aim at.
    object(10, 'decision', { statement: `${tag} first`, decidedBy: ALICE }, HUMAN, null),
    object(11, 'decision', { statement: `${tag} second`, decidedBy: ALICE }, HUMAN, null),
    // Gate: a decision never auto-accepts — even through a proposal the model
    // itself staged, which is the whole point of the rule.
    row(
      {
        id: `${tag}_12`,
        at: stamp(12),
        type: 'proposal_recorded',
        proposal: {
          id: `pprop_${seed}`,
          roomId: room,
          type: 'decision',
          payload: { statement: `${tag} proposed`, decidedBy: ALICE },
          confidence: 0.99,
          proposer: MODEL,
          provenance: [`msg_${tag}`],
          // r4: a model proposal of *any* type must quote. Before r4 the rule
          // was scoped to claims and commitments, and this decision carried no
          // quote at all — which is exactly the hole r3's gauntlet minted an
          // objective through.
          quote: `${tag} proposed`,
          createdAt: stamp(12),
        },
      },
      MODEL,
    ),
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
    row(
      {
        id: `${tag}_16`,
        at: stamp(16),
        type: 'relation_added',
        relation: {
          id: `prel_${seed}`,
          roomId: room,
          kind: 'supersedes',
          fromObjectId: `pobj_${seed}_11`,
          to: { kind: 'object', objectId: `pobj_${seed}_10` },
          createdAt: stamp(16),
        },
      },
      MODEL,
    ),
    // Gate: every correction verb is human-only.
    row(
      {
        id: `${tag}_17`,
        at: stamp(17),
        type: 'object_corrected',
        objectId: `pobj_${seed}_10`,
        action: 'amend',
        patch: { statement: `${tag} quietly reworded` },
      },
      MODEL,
    ),

    // ── #21 r1's additions to the floor ───────────────────────────────────
    //
    // A low-confidence claim proposal, staged by MODEL, that both acceptance
    // gates are aimed at in turn.
    modelClaimProposal(18, `pprop_low_${seed}`, `${tag} is unsure about the migration plan`, 0.05),
    // Gate: a model may not accept a reading it does not stand behind.
    object(
      19,
      'claim',
      { statement: `${tag} is unsure about the migration plan`, claimant: BOB },
      MODEL,
      `pprop_low_${seed}`,
      claimWindow(`${tag} is unsure about the migration plan`),
    ),
    // A well-founded proposal, staged by MODEL…
    modelClaimProposal(
      20,
      `pprop_own_${seed}`,
      `${tag} is confident about the migration plan`,
      0.95,
    ),
    // Gate: …that a *different* model tries to accept.
    object(
      21,
      'claim',
      { statement: `${tag} is confident about the migration plan`, claimant: BOB },
      OTHER_MODEL,
      `pprop_own_${seed}`,
      claimWindow(`${tag} is confident about the migration plan`),
    ),
    // Gate: …and tries to reject.
    row(
      {
        id: `${tag}_22`,
        at: stamp(22),
        type: 'proposal_rejected',
        proposalId: `pprop_own_${seed}`,
        reason: `${tag} not mine to withdraw`,
      },
      OTHER_MODEL,
    ),
    // Gate: …and tries to supersede.
    row(
      {
        id: `${tag}_23`,
        at: stamp(23),
        type: 'proposal_superseded',
        proposalId: `pprop_own_${seed}`,
        supersededByProposalId: null,
        reason: `${tag} not mine to retire`,
      },
      OTHER_MODEL,
    ),
    // Gate: an object filed under an objective that does not exist.
    row(
      {
        id: `${tag}_24`,
        at: stamp(24),
        type: 'object_accepted',
        object: {
          id: `pobj_${seed}_24`,
          roomId: room,
          objectiveId: `obj_no_such_objective_${seed}`,
          type: 'claim',
          payload: { statement: `${tag} orphan`, claimant: BOB },
          provenance: { messageIds: [`msg_${tag}`], proposalId: null },
          createdAt: stamp(24),
          updatedAt: stamp(24),
        },
      },
      HUMAN,
    ),

    // ── #21 r2's additions: the receipt, as a condition of folding ─────────
    //
    // Gate: the payload that lands is not the payload that was staged.
    modelClaimProposal(25, `pprop_bind_${seed}`, `${tag} is the reading that was staged`, 0.95),
    object(
      26,
      'claim',
      { statement: `${tag} something else entirely`, claimant: BOB },
      MODEL,
      `pprop_bind_${seed}`,
      claimWindow(`${tag} is the reading that was staged`),
    ),
    // Gate: the citation set changed on the way through acceptance.
    modelClaimProposal(27, `pprop_cite_${seed}`, `${tag} is the reading that was cited`, 0.95),
    row(
      {
        id: `${tag}_28`,
        at: stamp(28),
        type: 'object_accepted',
        object: {
          id: `pobj_${seed}_28`,
          roomId: room,
          type: 'claim',
          payload: { statement: `${tag} is the reading that was cited`, claimant: BOB },
          provenance: {
            messageIds: [`msg_${tag}`, `msg_${tag}_extra`],
            proposalId: `pprop_cite_${seed}`,
          },
          createdAt: stamp(28),
          updatedAt: stamp(28),
        },
      },
      MODEL,
      claimWindow(`${tag} is the reading that was cited`),
    ),
    // Gate: no window at all, so the receipt cannot be checked.
    modelClaimProposal(29, `pprop_blind_${seed}`, `${tag} is the reading nobody checked`, 0.95),
    object(
      31,
      'claim',
      { statement: `${tag} is the reading nobody checked`, claimant: BOB },
      MODEL,
      `pprop_blind_${seed}`,
    ),
    // Gate: the claimant wrote none of it — the spike's worst error.
    modelClaimProposal(32, `pprop_wrong_${seed}`, `${tag} is the reading attributed wrongly`, 0.95),
    object(
      33,
      'claim',
      { statement: `${tag} is the reading attributed wrongly`, claimant: BOB },
      MODEL,
      `pprop_wrong_${seed}`,
      [{ id: `msg_${tag}`, authorId: ALICE, body: `it is true that ${tag} misattributed` }],
    ),
    // Gate: a commitment somebody else's sentence named.
    row(
      {
        id: `${tag}_34`,
        at: stamp(34),
        type: 'proposal_recorded',
        proposal: {
          id: `pprop_third_${seed}`,
          roomId: room,
          type: 'commitment',
          payload: { statement: `${tag} will land it on Friday afternoon`, owner: BOB },
          confidence: 0.95,
          proposer: MODEL,
          provenance: [`msg_${tag}`],
          quote: `${tag} will land it on Friday afternoon`,
          createdAt: stamp(34),
        },
      },
      MODEL,
    ),
    row(
      {
        id: `${tag}_35`,
        at: stamp(35),
        type: 'object_accepted',
        object: {
          id: `pobj_${seed}_35`,
          roomId: room,
          type: 'commitment',
          payload: { statement: `${tag} will land it on Friday afternoon`, owner: BOB },
          provenance: { messageIds: [`msg_${tag}`], proposalId: `pprop_third_${seed}` },
          createdAt: stamp(35),
          updatedAt: stamp(35),
        },
      },
      MODEL,
      [
        {
          id: `msg_${tag}`,
          authorId: ALICE,
          body: `${tag} will land it on Friday afternoon. I think so.`,
        },
      ],
    ),
    // Gate: only a human declares a question answered.
    row(
      {
        id: `${tag}_36`,
        at: stamp(36),
        type: 'object_accepted',
        object: {
          id: `pobj_${seed}_36`,
          roomId: room,
          type: 'open_question',
          payload: { question: `${tag} do we?` },
          provenance: { messageIds: [`msg_${tag}`], proposalId: null },
          createdAt: stamp(36),
          updatedAt: stamp(36),
        },
      },
      HUMAN,
    ),
    row(
      {
        id: `${tag}_37`,
        at: stamp(37),
        type: 'relation_added',
        relation: {
          id: `prel_ans_${seed}`,
          roomId: room,
          kind: 'answers',
          fromObjectId: `pobj_${seed}_36`,
          to: { kind: 'object', objectId: `pobj_${seed}_10` },
          createdAt: stamp(37),
        },
      },
      MODEL,
    ),
    // Gate: supersession follows the policy for every type, not just decisions.
    row(
      {
        id: `${tag}_38`,
        at: stamp(38),
        type: 'object_accepted',
        object: {
          id: `pobj_${seed}_38`,
          roomId: room,
          type: 'commitment',
          payload: { statement: `${tag} owed`, owner: BOB },
          provenance: { messageIds: [`msg_${tag}`], proposalId: null },
          createdAt: stamp(38),
          updatedAt: stamp(38),
        },
      },
      HUMAN,
    ),
    row(
      {
        id: `${tag}_39`,
        at: stamp(39),
        type: 'object_accepted',
        object: {
          id: `pobj_${seed}_39`,
          roomId: room,
          type: 'commitment',
          payload: { statement: `${tag} owed, restated`, owner: BOB },
          provenance: { messageIds: [`msg_${tag}`], proposalId: null },
          createdAt: stamp(39),
          updatedAt: stamp(39),
        },
      },
      HUMAN,
    ),
    row(
      {
        id: `${tag}_40`,
        at: stamp(40),
        type: 'relation_added',
        relation: {
          id: `prel_sup_c_${seed}`,
          roomId: room,
          kind: 'supersedes',
          fromObjectId: `pobj_${seed}_39`,
          to: { kind: 'object', objectId: `pobj_${seed}_38` },
          createdAt: stamp(40),
        },
      },
      MODEL,
    ),
    // Gate: a receipt the check declines to rule on. The quote is verbatim,
    // long enough, a whole sentence and by the right author — and the statement
    // drops a word from it, which may be an aside or may be a negation. r3's
    // gauntlet is this shape, and a machine may not act on it.
    row(
      {
        id: `${tag}_41`,
        at: stamp(41),
        type: 'proposal_recorded',
        proposal: {
          id: `pprop_refer_${seed}`,
          roomId: room,
          type: 'claim',
          payload: { statement: `${tag} is confident about the plan`, claimant: BOB },
          confidence: 0.95,
          proposer: MODEL,
          provenance: [`msg_${tag}`],
          quote: `${tag} is not confident about the plan`,
          createdAt: stamp(41),
        },
      },
      MODEL,
    ),
    row(
      {
        id: `${tag}_42`,
        at: stamp(42),
        type: 'object_accepted',
        object: {
          id: `pobj_${seed}_42`,
          roomId: room,
          type: 'claim',
          payload: { statement: `${tag} is confident about the plan`, claimant: BOB },
          provenance: { messageIds: [`msg_${tag}`], proposalId: `pprop_refer_${seed}` },
          createdAt: stamp(42),
          updatedAt: stamp(42),
        },
      },
      MODEL,
      [{ id: `msg_${tag}`, authorId: BOB, body: `${tag} is not confident about the plan.` }],
    ),
  ];
}

/**
 * At-least-once delivery, as a transport actually produces it: the socket
 * re-sends the frame it just sent. Applied *after* shuffling, because a
 * redelivery is a property of the wire, not of the log's order.
 */
function withRedeliveries(log: readonly AuthoredEvent[], seed: number): AuthoredEvent[] {
  const rng = makeRng(seed);
  const out: AuthoredEvent[] = [];
  for (const entry of log) {
    out.push(entry);
    if (rng() < 0.15) out.push(entry);
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
function withRemintedRedeliveries(log: readonly AuthoredEvent[], seed: number): AuthoredEvent[] {
  const rng = makeRng(seed);
  const seen = new Set<string>();
  const candidates: AuthoredEvent[] = [];
  for (const entry of log) {
    if (seen.has(entry.event.id)) continue;
    seen.add(entry.event.id);
    if (rng() < 0.15) candidates.push(entry);
  }
  return [
    ...log,
    ...candidates.map((entry, index) => ({
      ...entry,
      event: { ...entry.event, at: stamp(REMINT_BASE + index) },
    })),
  ];
}

interface Rejection {
  entry: AuthoredEvent;
  reason: string;
}

interface Run {
  state: CoreState;
  consumed: AuthoredEvent[];
  rejections: Rejection[];
  /** Ids consumed *with a business issue* — the ones r3 forgot to spend. */
  failedIds: Set<string>;
  counts: Record<string, number>;
}

/** The live path: one row at a time, in arrival order, through `appendEvent`. */
function foldLive(log: readonly AuthoredEvent[]): Run {
  let state = reduce([]);
  const consumed: AuthoredEvent[] = [];
  const rejections: Rejection[] = [];
  const failedIds = new Set<string>();
  const counts: Record<string, number> = {
    applied: 0,
    applied_with_issue: 0,
    out_of_order: 0,
    duplicate: 0,
  };

  for (const entry of log) {
    const before = state;
    const result = appendEvent(state, entry.event, entry);
    if (result.outcome === 'rejected') {
      // The rejection contract, asserted on every rejected event of every
      // generated log rather than once by example.
      expect(result.state).toBe(before);
      counts[result.reason] = (counts[result.reason] ?? 0) + 1;
      rejections.push({ entry, reason: result.reason });
      continue;
    }
    expect(wasConsumed(result)).toBe(true);
    // The actor the outcome reports is the trusted one, not a payload field —
    // the payload has no such field to report.
    expect(result.actor).toEqual(entry.actor);
    counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
    if (result.outcome === 'applied_with_issue') failedIds.add(entry.event.id);
    consumed.push(entry);
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
function jitter(log: readonly AuthoredEvent[], seed: number): AuthoredEvent[] {
  const rng = makeRng(seed);
  const out = [...log].sort((a, b) =>
    oracleCompare({ at: a.event.at, id: a.event.id }, { at: b.event.at, id: b.event.id }),
  );
  for (let index = 0; index < out.length - 1; index += 1) {
    if (rng() >= 0.25) continue;
    const here = out[index] as AuthoredEvent;
    const next = out[index + 1] as AuthoredEvent;
    out[index] = next;
    out[index + 1] = here;
    index += 1;
  }
  return out;
}

type Delivery = 'shuffled' | 'jittered';

/** The full arrival stream for a seed: generated, disordered, then redelivered. */
function arrivalStream(seed: number, delivery: Delivery = 'shuffled'): AuthoredEvent[] {
  const generated = [...generateLog(seed, 60), ...gateProbes(seed)];
  const disordered =
    delivery === 'shuffled' ? shuffle(generated, seed * 7 + 1) : jitter(generated, seed * 11 + 3);
  return withRemintedRedeliveries(withRedeliveries(disordered, seed), seed * 3 + 2);
}

/**
 * Refusal texts the corpus must keep producing, one per gate — the five the
 * scaffold's actor floor holds, the five #21 r1 added on top of it, and the six
 * r2 moved into the reducer out of the acceptance engine.
 *
 * The assertion below fails if any of them stops firing, which is the point: a
 * corpus that drifts until a gate is never reached is a corpus that stopped
 * testing it, and nothing else would say so.
 */
const GATE_MARKERS = {
  direct_acceptance: 'only a human may accept an object directly',
  decision_acceptance: 'never auto-accepts',
  claim_verification: 'would become a verified claim',
  supersession: 'retires an accepted',
  correction: 'corrections (amend, retract, restore)',
  acceptance_binding: 'may only accept its own reading',
  rejection_binding: 'may only withdraw its own reading',
  supersession_binding: 'may only retire its own reading',
  confidence_floor: 'below the floor',
  dangling_objective: 'which does not exist',
  payload_binding: 'does not carry its payload',
  provenance_binding: 'the receipt may not change on the way through',
  missing_receipt_context: 'no message window supplied',
  receipt_failed: 'on a receipt that does not hold',
  // `third_party_confirm` is deliberately absent since r5: a commitment is
  // human-only now, so the type gate refuses a model's acceptance three checks
  // before the receipt is read and no delivery stream can reach it. It is
  // asserted straight at `acceptanceReceiptRefusal` in `authority-matrix.test.ts`
  // instead — a gate that only another gate makes unreachable is not a gate that
  // may be deleted.
  //
  // `missing_quote` is deliberately absent for the same class of reason: the
  // schema refuses a model proposal
  // with a blank quote at parse time, so the reducer's own gate for it is
  // defence in depth and unreachable through a delivery stream. It is asserted
  // straight at the predicate in `boundary.test.ts` instead, which is the point
  // of a gate that only another gate makes unreachable.
  receipt_not_certifiable: 'declines to rule on',
  answer_relation: 'declares an open question answered',
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
        expect(live.consumed.map((entry) => entry.event.id)).toEqual(
          expected.map((entry) => entry.event.id),
        );
        // … and folding that sequence in one shot lands on the same bytes.
        expect(serializeState(live.state)).toBe(serializeState(replayed));

        // Spelled out for the fields an ordering bug hides in. Compared in full —
        // nothing is stripped before comparing.
        expect(live.state.issues).toEqual(replayed.issues);
        expect(live.state.consumedEventIds).toEqual(replayed.consumedEventIds);
        expect(live.state.consumedEventIds).toEqual(expected.map((entry) => entry.event.id));
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
            rejection.entry.event.at >= stamp(REMINT_BASE) &&
            live.failedIds.has(rejection.entry.event.id),
        );

        const roomsByAt = new Map<string, Set<string>>();
        for (const entry of live.consumed) {
          const room = roomOfInput(entry.event);
          if (room === null) continue;
          const set = roomsByAt.get(entry.event.at) ?? new Set<string>();
          set.add(room);
          roomsByAt.set(entry.event.at, set);
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
    // Every gate was reached for by a model somewhere in the corpus.
    expect([...gatesSeen].sort()).toEqual(Object.keys(GATE_MARKERS).sort());
  });

  it('generates the same corpus twice — the stream itself is deterministic', () => {
    expect(generateLog(42, 40).map((e) => e.event.id)).toEqual(
      generateLog(42, 40).map((e) => e.event.id),
    );
    expect(arrivalStream(42).map((e) => `${e.event.id}@${e.event.at}`)).toEqual(
      arrivalStream(42).map((e) => `${e.event.id}@${e.event.at}`),
    );
  });

  it('produces same-`at` ties, which is what the id tie-break is for', () => {
    const log = generateLog(7, 60);
    const byAt = new Map<string, number>();
    for (const entry of log) byAt.set(entry.event.at, (byAt.get(entry.event.at) ?? 0) + 1);
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
    const spentTail = [...base, { ...first, event: { ...first.event, at: stamp(REMINT_BASE) } }];
    const freshTail = [
      ...base,
      {
        ...first,
        event: { ...first.event, id: `${first.event.id}_fresh`, at: stamp(REMINT_BASE) },
      },
    ];

    const spentConsumed = oracleConsumed(spentTail);
    const freshConsumed = oracleConsumed(freshTail);

    expect(spentConsumed.filter((entry) => entry.event.id === first.event.id)).toHaveLength(1);
    expect(spentConsumed).toHaveLength(freshConsumed.length - 1);
    expect(serializeState(reduce(spentConsumed))).not.toBe(serializeState(reduce(freshConsumed)));
  });

  it('folds the same rows to a different state under a different actor', () => {
    // The half the trusted seam adds: the actor is not in the payload, so a
    // replay that reconstructs it wrongly is not "the same log with a cosmetic
    // difference" — it is a different history, and it must not fold the same.
    const payload = {
      id: 'ev_actor_probe',
      at: stamp(1),
      type: 'object_accepted' as const,
      object: {
        id: 'obj_actor_probe',
        roomId: ROOMS[0],
        type: 'claim' as const,
        payload: { statement: 'the build is green', claimant: BOB },
        provenance: { messageIds: ['msg_1'], proposalId: null },
        createdAt: stamp(1),
        updatedAt: stamp(1),
      },
    };
    const asHuman = reduce([row(payload, HUMAN)]);
    const asModel = reduce([row(payload, MODEL)]);
    expect(asHuman.issues).toEqual([]);
    // A model cannot accept anything directly, so the same bytes with a
    // different trusted actor are refused.
    expect(asModel.issues[0]?.reason).toContain('only a human may accept an object directly');
    expect(serializeState(asHuman)).not.toBe(serializeState(asModel));
  });
});
