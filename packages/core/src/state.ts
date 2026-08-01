import type { AttentionItem } from './attention.js';
import type { Actor, Id, Timestamp } from './common.js';
import type { CorrectionAction } from './events.js';
import type { AcceptedObject } from './objects.js';
import type { Proposal, ProposalStatus } from './proposal.js';
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

export interface ProposalRecord {
  proposal: Proposal;
  status: ProposalStatus;
  /** The accepted object this proposal turned into, if any. */
  acceptedObjectId: Id | null;
  rejectedReason: string | null;
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
 * An event the reducer refused, or applied only after coercing it. Replay is
 * total: it records, never throws. Most issues mean "the event changed
 * nothing"; the exception is a proposal recorded with a pre-decided status,
 * which is applied with the status forced back to `proposed` and the coercion
 * noted here.
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
   * Per-room high-water mark: the canonical position of the last event this
   * room's state consumed. An event that sorts before its room's watermark is
   * refused (it lands in `issues`), which is what makes an incremental fold
   * indistinguishable from a full replay of the same log. See `reduce`.
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
