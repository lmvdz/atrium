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

/** An event the reducer could not apply. Replay is total: it records, never throws. */
export interface ReducerIssue {
  eventId: Id;
  reason: string;
}

export interface CoreState {
  objects: Record<Id, ObjectRecord>;
  relations: Relation[];
  proposals: Record<Id, ProposalRecord>;
  corrections: CorrectionRecord[];
  issues: ReducerIssue[];
  /** Event ids in the order they were applied. */
  appliedEventIds: Id[];
}

export function emptyState(): CoreState {
  return {
    objects: {},
    relations: [],
    proposals: {},
    corrections: [],
    issues: [],
    appliedEventIds: [],
  };
}

/**
 * Canonical serialization: object keys sorted recursively, so two states that
 * are deeply equal always produce the identical string. Determinism tests
 * compare these strings rather than relying on key insertion order.
 */
export function serializeState(state: CoreState): string {
  return JSON.stringify(canonicalize(state));
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
