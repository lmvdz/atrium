import type { AttentionItem } from './attention.js';
import type { Actor, Id, Timestamp } from './common.js';
import type { CorrectionAction } from './events.js';
import type { AcceptedObject } from './objects.js';
import type { Proposal, ProposalStatus, StoredProposal } from './proposal.js';
import type { Relation } from './relations.js';

/** One accepted object plus the bookkeeping the reducer maintains for it. */
export interface ObjectRecord {
  object: AcceptedObject;
  acceptedAt: Timestamp;
  updatedAt: Timestamp;
  /** Bumped by every correction. Cheap optimistic-concurrency token. */
  revision: number;
  /** Set by a `retract` correction. Retracted objects stay in state, visibly. */
  retractedAt: Timestamp | null;
  /** Set when another object supersedes this one. */
  supersededById: Id | null;
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
}

/** The whole proposal, status included — assembled from the single source. */
export function proposalWithStatus(record: ProposalRecord): Proposal {
  return { ...record.proposal, status: record.status } as Proposal;
}

/** Append-only correction log — the "nothing is erased" guarantee, materialised. */
export interface CorrectionRecord {
  eventId: Id;
  objectId: Id;
  action: CorrectionAction;
  before: unknown;
  after: unknown;
  actor: Actor;
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
  /** Event ids in the order they were applied. */
  appliedEventIds: Id[];
  /**
   * The canonical position of the last event this state consumed, or `null`
   * before the first one. This is the gate: an event that sorts *before* the
   * cursor is rejected outright and changes nothing at all. Consumption
   * therefore only ever moves forward, so the consumed sequence is in canonical
   * order by construction — which is exactly what makes a live fold and a full
   * replay of that sequence land on the same bytes. See `appendEvent`.
   */
  cursor: EventCursor | null;
  /**
   * Per-room record of the last position each room consumed. Derived
   * bookkeeping, not a gate — the gate is `cursor`, and it is global because
   * `issues`, `corrections` and `appliedEventIds` are global ordered lists: a
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
    appliedEventIds: [],
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

/**
 * Attention projection. v1 derives the one class that needs no interpretation
 * at all: an open commitment routes to its owner. `needs_decision`, `mention`
 * and `blocking_question` need the interpretation pipeline and message bodies,
 * so they are produced upstream and are deliberately not faked here.
 *
 * Deterministic: output is sorted by (objectId), never by insertion.
 */
export function computeAttention(state: CoreState, now: Timestamp): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const id of Object.keys(state.objects).sort()) {
    const record = state.objects[id];
    if (!record || record.retractedAt !== null || record.supersededById !== null) continue;
    const { object } = record;
    if (object.type !== 'commitment' || object.payload.status !== 'open') continue;
    items.push({
      id: `attn:${object.id}:owned_commitment`,
      roomId: object.roomId,
      userId: object.payload.owner,
      objectId: object.id,
      class: 'owned_commitment',
      rationale: `you own this commitment — "${object.payload.statement}"${
        object.payload.due ? ` (due ${object.payload.due})` : ''
      }`,
      status: 'pending',
      createdAt: now,
    });
  }
  return items;
}
