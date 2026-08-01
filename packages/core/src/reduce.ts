import type { z } from 'zod';
import { humanOnlyRefusal, isHuman } from './authority.js';
import type { CoreEvent } from './events.js';
import {
  type AcceptedObject,
  ClaimPayload,
  CommitmentPayload,
  DecisionPayload,
  ObjectivePayload,
  OpenQuestionPayload,
} from './objects.js';
import { storeProposal } from './proposal.js';
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

/** Why an event was refused entry. Both are properties of position, not content. */
export type RejectionReason =
  /**
   * It does not sort strictly after `state.cursor`: consuming it would rewrite
   * settled history, or would put two events at one position.
   */
  | 'out_of_order'
  /**
   * Its id has already been consumed, and it arrived *ahead* of the cursor —
   * a redelivery whose timestamp was re-minted. At-least-once delivery, made a
   * no-op.
   */
  | 'duplicate';

/**
 * The reducer's two answers to one event.
 *
 * A **consumed** event took a position in the log. It is part of the history
 * this state is a fold of, whether it applied cleanly (`applied`) or recorded a
 * business problem on the way (`applied_with_issue` — a proposal coerced back
 * to `proposed`, an amendment to an object that does not exist, a relation that
 * fails its type signature). Either way the outcome is a function of the log
 * alone, so replaying the log reproduces it exactly.
 *
 * A **rejected** event was never consumed. It is not history; it is a command
 * the reducer declined to accept, and it leaves *nothing* behind: no `issues`
 * entry, no cursor movement, no `consumedEventIds` entry. The state handed back
 * is the state handed in, byte for byte and reference for reference.
 */
export type EventOutcome =
  | { outcome: 'applied'; event: CoreEvent }
  | { outcome: 'applied_with_issue'; event: CoreEvent; issues: ReducerIssue[] }
  | { outcome: 'rejected'; event: CoreEvent; reason: RejectionReason; detail: string };

/** The three-way taxonomy, for callers that switch on it. */
export type AppendOutcome = EventOutcome['outcome'];

/** What `appendEvent` returns: an outcome plus the state that goes with it. */
export type AppendResult = EventOutcome & { state: CoreState };

export interface FoldResult {
  state: CoreState;
  /** One outcome per input event, in canonical order. */
  outcomes: EventOutcome[];
}

/**
 * Append one event to a state. **This is the command-layer entry point** — the
 * call a server makes for each event as it arrives, and the only one that
 * reports back what happened.
 *
 * ## The contract, stated exactly
 *
 * 1. `appendEvent` never mutates the state it is given. On `applied` /
 *    `applied_with_issue` the result carries a new state; on `rejected` it
 *    carries the *same object*, untouched.
 * 2. An event is **rejected** if it does not sort strictly after `state.cursor`
 *    in the canonical `(at, id)` order, or if its id has already been consumed.
 *    Rejection is total: no issue, no cursor move, no watermark move, no
 *    consumed id. A rejected event must not be persisted (see below).
 * 3. Any other event is **consumed**: `state.cursor` advances to it, its room's
 *    watermark advances to it, its id is spent in `consumedEventIds`, and it
 *    either applies or records one or more `ReducerIssue`s. Business validity
 *    is judged here — the proposal boundary, the actor floor, the correction
 *    and relation guards — and none of those judgements depend on when the
 *    event arrived, only on the log before it.
 * 4. Therefore the consumed sequence is in canonical order **by construction**.
 *    Write `L` for the events a state consumed, in the order it consumed them.
 *    Then, whatever order those events *arrived* in:
 *
 *        serializeState(state) === serializeState(reduce(L))
 *
 *    because `reduce` sorts `L` and `L` is already sorted. `issues` and
 *    `consumedEventIds` are included in that — they are built in consumption
 *    order on one side and in sorted order on the other, and those are the same
 *    order. This is the whole live≡replay guarantee, and the only one claimed:
 *    it says nothing about rejected events, which is the point — they are in
 *    neither `L` nor, per #22, the ledger.
 *
 * ## Why this is safe to rely on
 *
 * Half of the invariant lives in the durable ledger, and it is recorded on
 * issue #22:
 *
 * > "the durable ledger must contain ONLY events accepted in canonical order —
 * > room_seq is assigned transactionally at append, so an out-of-order event is
 * > rejected at the command layer and never persisted. The reducer watermark is
 * > a defense-in-depth guard, not a data path; if refused events could reach the
 * > log, full replay (which re-sorts) would accept what live ingestion refused
 * > and the two states would diverge."
 *
 * So: rejected events never enter state (this file) *and* never enter the log
 * (#22). `fold(log) === live state` holds because the two sides are folding the
 * identical sequence, not because anything reconciles them afterwards.
 *
 * A rejection is an error for the caller to handle, not a silent drop — a
 * command whose event lost the ordering race is re-minted at the current
 * position and appended again.
 */
export function appendEvent(state: CoreState, event: CoreEvent): AppendResult {
  const rejection = rejectionFor(state, event);
  if (rejection) return { outcome: 'rejected', event, ...rejection, state };
  const next = cloneState(state);
  return { ...consume(next, event), state: next };
}

/**
 * The deterministic reducer: fold a whole log into a state.
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
 *    upstream: a recorded proposal is always `proposed`; an acceptance that
 *    cites a proposal must cite one that exists, is still open, has not already
 *    been spent, and matches the object's type; and the actor floor of #4's
 *    acceptance matrix holds regardless of what any layer above did — see
 *    `authority.ts`.
 *
 * `reduce(events)` sorts, so nothing in a fresh replay is genuinely out of
 * order: the only events rejected are repeats. A verbatim repeat sorts onto the
 * position its twin just took and is refused there (`out_of_order`); a repeated
 * id carrying a different timestamp sorts elsewhere and is refused by the id
 * (`duplicate`). `reduce(events, state)` is the same fold continued: events at
 * or before `state.cursor` are rejected and skipped, exactly as `appendEvent`
 * would reject them. Use `foldEvents` when you need to see *which* ones, and
 * `appendEvent` when you are consuming one at a time — that is where the
 * outcome matters.
 */
export function reduce(events: readonly CoreEvent[], initial?: CoreState): CoreState {
  return foldEvents(events, initial).state;
}

/** `reduce`, plus the per-event outcome. Same fold, nothing hidden. */
export function foldEvents(events: readonly CoreEvent[], initial?: CoreState): FoldResult {
  const state = initial ? cloneState(initial) : emptyState();
  const outcomes: EventOutcome[] = [];
  for (const event of orderEvents(events)) {
    const rejection = rejectionFor(state, event);
    outcomes.push(rejection ? { outcome: 'rejected', event, ...rejection } : consume(state, event));
  }
  return { state, outcomes };
}

/** True when the event was consumed — i.e. it belongs in the durable log. */
export function wasConsumed(outcome: EventOutcome): boolean {
  return outcome.outcome !== 'rejected';
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

/**
 * The command-layer gate. Returns why the event may not be consumed, or `null`
 * if it may.
 *
 * ## Two checks, and why they run in this order
 *
 * **Position first.** An event must sort *strictly after* `state.cursor`.
 * Strictly, because `(at, id)` is a total order: two distinct events cannot
 * occupy one position, so an event that lands exactly on the cursor is either a
 * redelivery or a forged id, and admitting it would let two different payloads
 * claim the same place in the log — which is the same divergence the ordering
 * gate exists to prevent, just harder to see.
 *
 * **Identity second.** An id that has already been consumed can never be
 * consumed again, whatever timestamp it now carries.
 *
 * The order cannot change what the state *becomes* — both branches reject, and
 * a rejection leaves the state untouched either way. What it decides is the
 * reason reported, and the reason is a diagnosis, so it should name the
 * strongest fact. Position is the stronger one: it holds on the log's terms
 * alone, whether or not the id was ever seen, which means the ordering gate's
 * correctness does not depend on `consumedEventIds` being complete. Running
 * identity first would invert that — every stale event whose id happened to be
 * spent would be reported as a redelivery, and the ordering guarantee would
 * quietly become a property of the id set. That is the r3 lesson, kept.
 *
 * The detail says when both are true, so a caller is never told "you lost the
 * ordering race, re-mint and retry" about an event that is already in the log.
 */
function rejectionFor(
  state: CoreState,
  event: CoreEvent,
): { reason: RejectionReason; detail: string } | null {
  const cursor = cursorOf(event);
  const spent = state.consumedEventIds.includes(event.id);
  if (state.cursor && compareCursor(cursor, state.cursor) <= 0) {
    const also = spent
      ? '; its id was consumed already too, so this is a redelivery — do not re-mint it'
      : '';
    return {
      reason: 'out_of_order',
      detail: `event (${event.at}, ${event.id}) does not sort strictly after the consumed position (${state.cursor.at}, ${state.cursor.id}) — rejected, not applied and not recorded${also}`,
    };
  }
  if (spent) {
    return {
      reason: 'duplicate',
      detail: `event "${event.id}" was consumed already — rejected as a redelivery, whatever timestamp it now carries and whatever the first delivery made of it`,
    };
  }
  return null;
}

/**
 * Consume one event into `state`, mutating it. The caller has already cleared
 * the gate, so this always advances the cursor: the event is history now,
 * whether or not it changed anything.
 */
function consume(state: CoreState, event: CoreEvent): EventOutcome {
  const issuesBefore = state.issues.length;
  const roomId = resolveRoomId(state, event);
  const applied = dispatch(state, event);

  state.cursor = cursorOf(event);
  // Advances whether or not the event applied: it is the log position this
  // room's state reflects, not a success count.
  if (roomId !== null) state.watermarks[roomId] = cursorOf(event);
  // Spent by being consumed, not by succeeding. An event that failed its
  // business checks got its one delivery; a redelivery must not get a second
  // one against a state that has since moved on. See `consumedEventIds`.
  state.consumedEventIds.push(event.id);

  // A refusal that records no reason is a fact that vanished — the object did
  // not change, nothing says why, and `applied_with_issue` degrades to
  // `applied`. Every `dispatch` path that returns false calls `fail` first;
  // this keeps that true for the next one somebody writes.
  if (!applied && state.issues.length === issuesBefore) {
    fail(state, event.id, `event "${event.id}" did not apply and recorded no reason`);
  }

  const issues = state.issues.slice(issuesBefore);
  return issues.length > 0
    ? { outcome: 'applied_with_issue', event, issues }
    : { outcome: 'applied', event };
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

  // The wire status is dropped rather than copied: `record.status` is the only
  // status a proposal has, so acceptance cannot leave a stale second copy
  // behind. See `StoredProposal`.
  state.proposals[proposal.id] = {
    proposal: storeProposal(proposal),
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

  // ── The actor floor (see `authority.ts` for #4's matrix) ──
  //
  // Checked before the proposal citation, because authority is a property of
  // the event and citation is a property of what it points at: a model that may
  // not accept this object at all should be told that, not sent to fix its
  // provenance first.
  const { actor } = event;
  const subject = `object "${object.id}"`;

  // A decision is the type #4 bans inference at, by name: "that sounds good" is
  // where the ambiguity lives. A model may propose one; only a human accepts
  // it. Note this gate does not care whether a proposal was cited — an
  // interpreter accepting *its own* decision proposal is exactly the move.
  if (object.type === 'decision' && !isHuman(actor)) {
    fail(state, event.id, humanOnlyRefusal('decision_acceptance', actor, subject));
    return false;
  }

  // `~` vs `✓`, as data. A claim may be model-accepted — that is #4's
  // auto-accept path and it stays open — but it arrives unverified. Verified is
  // the room asserting the claim is true, and nothing model-accepted ever
  // renders as fact.
  if (object.type === 'claim' && object.payload.verification === 'verified' && !isHuman(actor)) {
    fail(state, event.id, humanOnlyRefusal('claim_verification', actor, subject));
    return false;
  }

  // An object may be born without a proposal — but only from a human. That is
  // the answer-binding path: a person writes a decision, or binds an answer,
  // and a person's word is not an interpretation that needs accepting.
  //
  // A model or a system actor has exactly one way to mint a fact: propose it,
  // and have the proposal accepted. Without this gate the whole acceptance
  // boundary is optional — an interpreter that cannot hand itself a
  // pre-accepted proposal can simply skip the proposal and emit the object.
  const proposalId = object.provenance.proposalId;
  if (proposalId === null && !isHuman(actor)) {
    fail(state, event.id, humanOnlyRefusal('direct_acceptance', actor, subject));
    return false;
  }

  // An object that *claims* a proposal must claim a real, still-open,
  // type-matching one: that citation is the provenance the UI shows, so an
  // unverifiable one is worse than none.
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

  // Every correction verb is human-only in v1 (#4, and the correction verbs
  // #21 will grow are the same shape). A correction rewrites, withdraws or
  // restores something the room already accepted — it is the one operation that
  // reaches backwards, and an interpreter must never reach backwards on its own
  // authority. A model that thinks an object is wrong proposes a supersession.
  //
  // The claim-verification gate is repeated here rather than left to the
  // blanket rule above it. Today it is unreachable — a model cannot amend
  // anything — but the two rules have different lifetimes: #21 may hand a model
  // some correction verb, and "a claim only becomes ✓ by a human" must not
  // depend on that never happening.
  if (!isHuman(event.actor)) {
    const verifying =
      record.object.type === 'claim' &&
      event.action === 'amend' &&
      event.patch.verification === 'verified';
    fail(
      state,
      event.id,
      humanOnlyRefusal(
        verifying ? 'claim_verification' : 'correction',
        event.actor,
        `object "${event.objectId}"`,
      ),
    );
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
    // #4 splits supersession by what is being retired: retiring a claim or an
    // open question auto-accepts (a newer reading replacing an older one is
    // cheap to correct), but retiring an accepted *decision* needs the same
    // human hand that accepting one needed. Otherwise the decision gate is a
    // front door with the back door open: a model that may not accept a
    // decision could still supersede every decision in the room.
    if (target.object.type === 'decision' && !isHuman(event.actor)) {
      fail(
        state,
        event.id,
        humanOnlyRefusal('decision_supersession', event.actor, `relation "${relation.id}"`),
      );
      return false;
    }
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
