import type { z } from 'zod';
import type { CoreEvent } from './events.js';
import {
  type AcceptedObject,
  ClaimPayload,
  CommitmentPayload,
  DecisionPayload,
  ObjectivePayload,
  OpenQuestionPayload,
} from './objects.js';
import { relationShapeError } from './relations.js';
import {
  type CoreState,
  canonicalJson,
  type EventCursor,
  emptyState,
  type ObjectRecord,
  type ProposalRecord,
  type ReducerIssue,
} from './state.js';

/**
 * The deterministic reducer.
 *
 * Contract:
 *  - Pure. No clock, no randomness, no I/O. Given the same events it returns a
 *    state that serializes byte-identically, on any machine, in any order of
 *    arrival — events are canonically ordered by `(at, id)` before folding.
 *  - Total. A malformed or unapplicable event never throws; it lands in
 *    `state.issues` so replay of a real log can never wedge.
 *  - Append-only. Corrections and supersessions change *status*, never history:
 *    the prior value is written to `state.corrections` and the object stays.
 *  - Trust-preserving. The proposal → acceptance boundary is enforced here, not
 *    upstream: a recorded proposal is always `proposed`, and an acceptance that
 *    cites a proposal must cite one that exists, is still open, has not already
 *    been accepted, and is of the object's own type.
 *
 * ## Incremental application and the room watermark
 *
 * `reduce(events)` sorts the whole batch, so a full replay is canonically
 * ordered by construction. `reduce([next], state)` — the live fold a server
 * runs per arriving event — has no such luxury: it cannot re-sort events it has
 * already folded. Without a rule, feeding a late-arriving event into a live
 * fold would produce a state that a replay of the same accepted sequence would
 * never produce.
 *
 * The rule: `CoreState.watermarks[roomId]` holds the canonical `(at, id)`
 * position of the last event that room consumed. An event that sorts *before*
 * its room's watermark is never applied — it lands in `state.issues` and the
 * watermark holds. So for any sequence of events a state actually accepted,
 * folding them one at a time and replaying them all at once land on the same
 * state; a stale event is refused loudly instead of being silently applied out
 * of order.
 *
 * The watermark advances on every consumed event, applied or refused: it
 * records the log position the room's state reflects, not a success count. It
 * does not advance for an event whose room cannot be resolved (a correction to
 * an unknown object, a rejection of an unknown proposal) — those events change
 * nothing and are recorded as issues regardless.
 */
export function reduce(events: readonly CoreEvent[], initial?: CoreState): CoreState {
  const state = initial ? cloneState(initial) : emptyState();
  for (const event of orderEvents(events)) {
    applyEvent(state, event);
  }
  return state;
}

/**
 * Canonical event order: ascending timestamp, ties broken by event id. Two
 * nodes handed the same set in different orders reduce to the same state.
 */
export function orderEvents(events: readonly CoreEvent[]): CoreEvent[] {
  return [...events].sort((a, b) => compareCursor(cursorOf(a), cursorOf(b)));
}

/** The canonical sort key of an event. */
export function cursorOf(event: CoreEvent): EventCursor {
  return { at: event.at, id: event.id };
}

/** The comparison `orderEvents` sorts by, exposed so callers can reason about order. */
export function compareCursor(a: EventCursor, b: EventCursor): number {
  return a.at === b.at ? compare(a.id, b.id) : compare(a.at, b.at);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Structural clone. Hand-rolled rather than `structuredClone` so this package
 * depends on nothing beyond the ECMAScript standard library — it must run
 * unchanged in Node, in a worker, and in the browser.
 */
function cloneState(state: CoreState): CoreState {
  return deepClone(state) as CoreState;
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(deepClone) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) out[key] = deepClone(source[key]);
    return out as T;
  }
  return value;
}

function fail(state: CoreState, eventId: string, reason: string): void {
  const issue: ReducerIssue = { eventId, reason };
  state.issues.push(issue);
}

/**
 * The room an event belongs to, or `null` when it cannot be resolved from state
 * — which only happens for events that reference something that does not exist
 * and are about to be recorded as issues anyway.
 */
function resolveRoomId(state: CoreState, event: CoreEvent): string | null {
  switch (event.type) {
    case 'proposal_recorded':
      return event.proposal.roomId;
    case 'proposal_rejected':
      return state.proposals[event.proposalId]?.proposal.roomId ?? null;
    case 'object_accepted':
      return event.object.roomId;
    case 'object_corrected':
      return state.objects[event.objectId]?.object.roomId ?? null;
    case 'relation_added':
      return event.relation.roomId;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function applyEvent(state: CoreState, event: CoreEvent): void {
  if (state.appliedEventIds.includes(event.id)) {
    fail(state, event.id, 'duplicate event id — already applied');
    return;
  }

  const roomId = resolveRoomId(state, event);
  if (roomId !== null) {
    const mark = state.watermarks[roomId];
    if (mark && compareCursor(cursorOf(event), mark) < 0) {
      fail(
        state,
        event.id,
        `event (${event.at}, ${event.id}) precedes the watermark (${mark.at}, ${mark.id}) of room "${roomId}" — out-of-order application refused`,
      );
      return;
    }
  }

  const applied = dispatch(state, event);

  // Advances whether or not the event applied: it is the log position this
  // room's state reflects, which is what keeps a live fold and a replay
  // indistinguishable. See the contract on `reduce`.
  if (roomId !== null) state.watermarks[roomId] = cursorOf(event);

  if (applied) state.appliedEventIds.push(event.id);
}

/** Applies one event. Returns whether it was applied; issues are recorded in state. */
function dispatch(state: CoreState, event: CoreEvent): boolean {
  switch (event.type) {
    case 'proposal_recorded':
      return applyProposalRecorded(state, event);
    case 'proposal_rejected':
      return applyProposalRejected(state, event);
    case 'object_accepted':
      return applyObjectAccepted(state, event);
    case 'object_corrected':
      return applyObjectCorrected(state, event);
    case 'relation_added':
      return applyRelationAdded(state, event);
    default: {
      const exhaustive: never = event;
      fail(state, (exhaustive as CoreEvent).id, 'unknown event type');
      return false;
    }
  }
}

type EventOf<T extends CoreEvent['type']> = Extract<CoreEvent, { type: T }>;

function applyProposalRecorded(state: CoreState, event: EventOf<'proposal_recorded'>): boolean {
  const { proposal } = event;
  if (state.proposals[proposal.id]) {
    fail(state, event.id, `proposal "${proposal.id}" already recorded`);
    return false;
  }

  // A proposal enters the log as a proposal, full stop. An incoming status of
  // `accepted` is an interpreter asserting that its own reading is a fact —
  // exactly what the acceptance boundary exists to refuse (init.md §5). The
  // status is forced back to `proposed` and the coercion is recorded, so the
  // proposal is still staged for a human but can never arrive pre-blessed.
  if (proposal.status !== 'proposed') {
    fail(
      state,
      event.id,
      `proposal "${proposal.id}" was recorded with status "${proposal.status}" — forced to "proposed"; only an acceptance or rejection event may move a proposal`,
    );
  }

  state.proposals[proposal.id] = {
    proposal: { ...proposal, status: 'proposed' },
    status: 'proposed',
    acceptedObjectId: null,
    rejectedReason: null,
  };
  return true;
}

function applyProposalRejected(state: CoreState, event: EventOf<'proposal_rejected'>): boolean {
  const record = state.proposals[event.proposalId];
  if (!record) {
    fail(state, event.id, `unknown proposal "${event.proposalId}"`);
    return false;
  }
  if (record.status === 'accepted') {
    fail(state, event.id, `proposal "${event.proposalId}" was already accepted`);
    return false;
  }
  if (record.status === 'rejected') {
    fail(state, event.id, `proposal "${event.proposalId}" was already rejected`);
    return false;
  }
  record.status = 'rejected';
  record.rejectedReason = event.reason;
  return true;
}

function applyObjectAccepted(state: CoreState, event: EventOf<'object_accepted'>): boolean {
  const { object } = event;
  if (state.objects[object.id]) {
    fail(state, event.id, `object "${object.id}" already accepted`);
    return false;
  }

  // An object may be born without a proposal — a human writing a decision
  // directly, or answer-bound creation. But an object that *claims* a proposal
  // must claim a real, still-open, type-matching one: that citation is the
  // provenance the UI shows, so an unverifiable one is worse than none.
  const proposalId = object.provenance.proposalId;
  let proposal: ProposalRecord | undefined;
  if (proposalId !== null) {
    proposal = state.proposals[proposalId];
    if (!proposal) {
      fail(state, event.id, `object "${object.id}" cites unknown proposal "${proposalId}"`);
      return false;
    }
    if (proposal.status === 'rejected') {
      fail(state, event.id, `proposal "${proposalId}" was already rejected`);
      return false;
    }
    if (proposal.status === 'accepted' || proposal.acceptedObjectId !== null) {
      fail(
        state,
        event.id,
        `proposal "${proposalId}" was already accepted as object "${proposal.acceptedObjectId}"`,
      );
      return false;
    }
    if (proposal.proposal.type !== object.type) {
      fail(
        state,
        event.id,
        `proposal "${proposalId}" is a ${proposal.proposal.type}, cannot be accepted as a ${object.type}`,
      );
      return false;
    }
    if (proposal.proposal.roomId !== object.roomId) {
      fail(
        state,
        event.id,
        `proposal "${proposalId}" belongs to room "${proposal.proposal.roomId}", object "${object.id}" to room "${object.roomId}"`,
      );
      return false;
    }
  }

  const record: ObjectRecord = {
    object,
    acceptedAt: event.at,
    updatedAt: event.at,
    revision: 0,
    retractedAt: null,
    supersededById: null,
  };
  state.objects[object.id] = record;

  if (proposal) {
    proposal.status = 'accepted';
    proposal.acceptedObjectId = object.id;
  }
  return true;
}

function applyObjectCorrected(state: CoreState, event: EventOf<'object_corrected'>): boolean {
  const record = state.objects[event.objectId];
  if (!record) {
    fail(state, event.id, `unknown object "${event.objectId}"`);
    return false;
  }

  if (event.action === 'retract') {
    if (record.retractedAt !== null) {
      fail(state, event.id, `object "${event.objectId}" is already retracted`);
      return false;
    }
    state.corrections.push({
      eventId: event.id,
      objectId: record.object.id,
      action: 'retract',
      before: { retracted: false },
      after: { retracted: true },
      actor: event.actor,
      note: event.note,
      at: event.at,
    });
    record.retractedAt = event.at;
    record.updatedAt = event.at;
    record.revision += 1;
    return true;
  }

  if (event.action === 'restore') {
    if (record.retractedAt === null) {
      fail(state, event.id, `object "${event.objectId}" is not retracted`);
      return false;
    }
    state.corrections.push({
      eventId: event.id,
      objectId: record.object.id,
      action: 'restore',
      before: { retracted: true },
      after: { retracted: false },
      actor: event.actor,
      note: event.note,
      at: event.at,
    });
    record.retractedAt = null;
    record.updatedAt = event.at;
    record.revision += 1;
    return true;
  }

  // A retracted object is withdrawn, not editable. Amending one would quietly
  // resurrect content the room already took back; restore it first, in the open.
  if (record.retractedAt !== null) {
    fail(state, event.id, `object "${event.objectId}" is retracted — restore it before amending`);
    return false;
  }

  const patched = applyPayloadPatch(record.object, event.patch);
  if (!patched.ok) {
    fail(state, event.id, `invalid amendment to "${event.objectId}": ${patched.error}`);
    return false;
  }

  // An amendment that changes nothing is a no-op, not a correction. Bumping the
  // revision would invent history — and `revision` is the optimistic-concurrency
  // token, so a phantom bump would spuriously invalidate every open editor.
  if (canonicalJson(patched.after) === canonicalJson(patched.before)) {
    return true;
  }

  state.corrections.push({
    eventId: event.id,
    objectId: record.object.id,
    action: 'amend',
    before: patched.before,
    after: patched.after,
    actor: event.actor,
    note: event.note,
    at: event.at,
  });
  record.object = { ...patched.object, updatedAt: event.at };
  record.updatedAt = event.at;
  record.revision += 1;
  return true;
}

function applyRelationAdded(state: CoreState, event: EventOf<'relation_added'>): boolean {
  const { relation } = event;
  if (state.relations.some((existing) => existing.id === relation.id)) {
    fail(state, event.id, `relation "${relation.id}" already exists`);
    return false;
  }
  const shapeError = relationShapeError(relation);
  if (shapeError) {
    fail(state, event.id, shapeError);
    return false;
  }
  const from = state.objects[relation.fromObjectId];
  if (!from) {
    fail(state, event.id, `unknown source object "${relation.fromObjectId}"`);
    return false;
  }
  const target = relation.to.kind === 'object' ? state.objects[relation.to.objectId] : undefined;
  if (relation.to.kind === 'object' && !target) {
    fail(state, event.id, `unknown target object "${relation.to.objectId}"`);
    return false;
  }

  // Rooms are the isolation boundary: a relation must not reach across one.
  if (from.object.roomId !== relation.roomId) {
    fail(
      state,
      event.id,
      `relation "${relation.id}" is in room "${relation.roomId}" but its source object "${relation.fromObjectId}" is in room "${from.object.roomId}"`,
    );
    return false;
  }
  if (target && target.object.roomId !== relation.roomId) {
    fail(
      state,
      event.id,
      `relation "${relation.id}" is in room "${relation.roomId}" but its target object "${target.object.id}" is in room "${target.object.roomId}"`,
    );
    return false;
  }

  // `answers` is the one structural kind with a typed signature: only an open
  // question answers, and only a decision or a claim answers it. Without this
  // the reducer would happily record "a commitment answers an objective" and
  // then silently skip the status flip — an edge that renders but means nothing.
  if (relation.kind === 'answers') {
    if (from.object.type !== 'open_question') {
      fail(
        state,
        event.id,
        `relation "answers" must originate from an open_question, got "${from.object.type}"`,
      );
      return false;
    }
    if (target && target.object.type !== 'decision' && target.object.type !== 'claim') {
      fail(
        state,
        event.id,
        `relation "answers" must target a decision or a claim, got "${target.object.type}"`,
      );
      return false;
    }
  }

  if (relation.kind === 'supersedes' && target) {
    if (target.supersededById !== null) {
      fail(
        state,
        event.id,
        `object "${target.object.id}" is already superseded by "${target.supersededById}"`,
      );
      return false;
    }
    if (supersessionWouldCycle(state, relation.fromObjectId, target.object.id)) {
      fail(
        state,
        event.id,
        `"${relation.fromObjectId}" cannot supersede "${target.object.id}" — it is already superseded by it, directly or transitively`,
      );
      return false;
    }
  }

  state.relations.push(relation);

  // Structural side effects. Status flips only — nothing is removed.
  if (relation.kind === 'supersedes' && target) {
    target.supersededById = relation.fromObjectId;
    target.updatedAt = event.at;
    if (target.object.type === 'decision') {
      target.object = {
        ...target.object,
        payload: { ...target.object.payload, status: 'superseded' },
        updatedAt: event.at,
      };
    }
  }

  if (relation.kind === 'answers' && from.object.type === 'open_question') {
    from.object = {
      ...from.object,
      payload: { ...from.object.payload, status: 'answered' },
      updatedAt: event.at,
    };
    from.updatedAt = event.at;
  }
  return true;
}

/**
 * Would `from supersedes target` close a loop? Walks the chain of objects that
 * already supersede `from`; reaching `target` means the two would supersede each
 * other, leaving neither current. A pre-existing loop also returns true rather
 * than spinning.
 */
function supersessionWouldCycle(state: CoreState, fromId: string, targetId: string): boolean {
  const seen = new Set<string>();
  let cursor: string | null = fromId;
  while (cursor !== null) {
    if (cursor === targetId) return true;
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = state.objects[cursor]?.supersededById ?? null;
  }
  return false;
}

type PatchResult =
  | { ok: true; object: AcceptedObject; before: unknown; after: unknown }
  | { ok: false; error: string };

/**
 * Merges a partial patch into an object's payload and re-validates it against
 * that type's schema. An amendment that would produce an invalid object is
 * rejected outright rather than half-applied.
 */
function applyPayloadPatch(object: AcceptedObject, patch: Record<string, unknown>): PatchResult {
  const merged = { ...object.payload, ...patch };
  switch (object.type) {
    case 'decision':
      return finish(object, DecisionPayload.safeParse(merged));
    case 'commitment':
      return finish(object, CommitmentPayload.safeParse(merged));
    case 'open_question':
      return finish(object, OpenQuestionPayload.safeParse(merged));
    case 'claim':
      return finish(object, ClaimPayload.safeParse(merged));
    case 'objective':
      return finish(object, ObjectivePayload.safeParse(merged));
    default: {
      const exhaustive: never = object;
      return { ok: false, error: `unknown object type ${JSON.stringify(exhaustive)}` };
    }
  }
}

function finish<T extends AcceptedObject>(
  object: T,
  parsed: z.ZodSafeParseResult<T['payload']>,
): PatchResult {
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map(describeIssue).join('; ') };
  }
  return {
    ok: true,
    object: { ...object, payload: parsed.data } as AcceptedObject,
    before: object.payload,
    after: parsed.data,
  };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}
