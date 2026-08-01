import type { Actor, Id, Provenance, Timestamp } from './common.js';
import type { CorrectionAction } from './events.js';
import type { AcceptedObject, AcceptedObjectType } from './objects.js';
import type { Proposal, ProposalStatus, StoredProposal } from './proposal.js';
import type { Relation } from './relations.js';

/** One accepted object plus the bookkeeping the reducer maintains for it. */
export interface ObjectRecord {
  object: AcceptedObject;
  acceptedAt: Timestamp;
  updatedAt: Timestamp;
  /**
   * Who accepted it. The epistemic glyph is derived from this and nothing else
   * (`epistemic.ts`): `~` for a model-accepted object, `✓` once a human has
   * touched it. Recording it on the record rather than re-deriving it from the
   * log is what lets a projection answer "is this a fact yet" without a replay.
   */
  acceptedBy: Actor;
  /**
   * When a human first touched this object — accepted it, or corrected it
   * afterwards. `null` while it is still only a machine's reading.
   */
  humanTouchedAt: Timestamp | null;
  /** Bumped by every correction. Cheap optimistic-concurrency token. */
  revision: number;
  /** Set by a `retract` correction. Retracted objects stay in state, visibly. */
  retractedAt: Timestamp | null;
  /** Set when another object supersedes this one. */
  supersededById: Id | null;
  /**
   * Relation ids that answered this question before it was reopened, newest
   * last. Empty for everything else.
   *
   * #5's `reopen` returns an answered question to open "prior answer preserved
   * on record". The `answers` edges themselves are never removed — the relation
   * log is append-only — but once the status flips back to `open` there is
   * nothing distinguishing "answered by that edge" from "reopened despite that
   * edge", and the UI has to be able to say *what* the room had settled on
   * before somebody reopened it. This is that list.
   */
  reopenedFromAnswers: Id[];
}

/**
 * A staged proposal plus its lifecycle. `status` here is the *only* status:
 * `proposal` is stored without one (see `StoredProposal`), because a nested
 * copy that acceptance forgot to update is a second answer to a question that
 * has one answer.
 */
export interface ProposalRecord {
  proposal: StoredProposal;
  status: ProposalStatus;
  /** The accepted object this proposal turned into, if any. */
  acceptedObjectId: Id | null;
  rejectedReason: string | null;
  /**
   * The newer reading that retired this one, when `status === 'superseded'`.
   * `null` when a re-interpretation retired it without naming a replacement.
   */
  supersededByProposalId: Id | null;
  /** Why it was superseded, when the event said. */
  supersededReason: string | null;
}

/** The whole proposal, status included — assembled from the single source. */
export function proposalWithStatus(record: ProposalRecord): Proposal {
  return { ...record.proposal, status: record.status } as Proposal;
}

/** Append-only correction log — the "nothing is erased" guarantee, materialised. */
export interface CorrectionRecord {
  eventId: Id;
  objectId: Id;
  /**
   * The object's type **at the moment of correction**, before a `retype`
   * changed it. Stored rather than looked up, because looking it up gives the
   * type the object has *now*, and the whole point of the counterexample
   * extractor (#5) is "the room keeps correcting things we read as decisions" —
   * a query that resolves through the current type answers the opposite
   * question after every retype.
   */
  objectType: AcceptedObjectType;
  action: CorrectionAction;
  before: unknown;
  after: unknown;
  actor: Actor;
  /** The messages that motivated the correction (#19 r1). */
  provenance: Provenance;
  note: string | null;
  at: Timestamp;
}

/**
 * A *business* problem with an event the reducer consumed: it was in order, it
 * occupies a position in the log, and it either changed nothing (an amendment
 * to an unknown object) or was applied only after coercion (a proposal that
 * arrived pre-accepted). Replay is total: issues are recorded, never thrown.
 *
 * Every issue is a function of the log alone, so a replay of the same log
 * reproduces the same issues in the same order. Out-of-order and duplicate
 * events are *not* issues — those are rejections, and a rejection leaves no
 * trace in state at all. See `appendEvent`.
 */
export interface ReducerIssue {
  eventId: Id;
  reason: string;
}

/**
 * A position in the canonical event order — the `(at, id)` sort key `reduce`
 * folds by. Comparing two cursors is the same comparison `orderEvents` uses.
 */
export interface EventCursor {
  at: Timestamp;
  id: Id;
}

export interface CoreState {
  objects: Record<Id, ObjectRecord>;
  relations: Relation[];
  proposals: Record<Id, ProposalRecord>;
  corrections: CorrectionRecord[];
  issues: ReducerIssue[];
  /**
   * Every event id this state consumed, in consumption order — whether it
   * applied cleanly or recorded a business issue on the way.
   *
   * "Consumed", not "applied", is the load-bearing word. An id is spent by
   * taking a position in the log, not by succeeding at what it asked for: an
   * event that failed its business checks still happened, and letting it back
   * in later would let a redelivery retry against a state that has moved on
   * (an amendment to an object that did not exist yet, an acceptance whose
   * proposal has since arrived) and flip failure into success. One delivery,
   * one outcome, forever. This is what the duplicate gate checks.
   */
  consumedEventIds: Id[];
  /**
   * The canonical position of the last event this state consumed, or `null`
   * before the first one. This is the gate: an event that does not sort
   * **strictly after** the cursor is rejected outright and changes nothing at
   * all. Strictly — an event landing on exactly the consumed position is
   * refused too, because `(at, id)` is the total order and two distinct events
   * cannot share a position; something that claims to is a re-delivery or a
   * forged id, and admitting it would make the order a partial one. Consumption
   * therefore only ever moves forward, so the consumed sequence is in canonical
   * order by construction — which is exactly what makes a live fold and a full
   * replay of that sequence land on the same bytes. See `appendEvent`.
   */
  cursor: EventCursor | null;
  /**
   * Per-room record of the last position each room consumed. Derived
   * bookkeeping, not a gate — the gate is `cursor`, and it is global because
   * `issues`, `corrections` and `consumedEventIds` are global ordered lists: a
   * per-room gate would let two rooms interleave those lists one way live and
   * another way on replay. Kept because a room's own position is what #22's
   * `core_events.room_seq` maps onto.
   */
  watermarks: Record<Id, EventCursor>;
}

export function emptyState(): CoreState {
  return {
    objects: {},
    relations: [],
    proposals: {},
    corrections: [],
    issues: [],
    consumedEventIds: [],
    cursor: null,
    watermarks: {},
  };
}

/**
 * Canonical serialization: object keys sorted recursively, so two states that
 * are deeply equal always produce the identical string. Determinism tests
 * compare these strings rather than relying on key insertion order.
 */
export function serializeState(state: CoreState): string {
  return canonicalJson(state);
}

/**
 * Canonical JSON for any value: object keys sorted recursively. Used both to
 * serialize state and to compare two payloads for real equality — key order is
 * never a difference.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}
