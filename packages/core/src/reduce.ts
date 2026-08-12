import type { z } from 'zod';
import { ATTRIBUTION_FIELD, payloadAttributions } from './attribution.js';
import {
  acceptanceAttributionRefusal,
  acceptanceReceiptRefusal,
  actorMatchesProposer,
  confidenceFloorRefusal,
  correctionAttributionRefusal,
  humanOnlyRefusal,
  isHuman,
  modelMintingGate,
  ownerConfirmRefusal,
  proposalBindingRefusal,
  selfStagedReadingRefusal,
  selfVerificationRefusal,
  uncertifiedTypeRefusal,
} from './authority.js';
import { type Actor, instantKey } from './common.js';
// `ATTRIBUTION_FIELD` moved out of `corrections.ts` and into `attribution.ts`
// on the realtime lane (it is derived from `PAYLOAD_FIELD_ROLE` there, not
// declared); `corrections.ts` now imports it too. The core lane's import of it
// from `./corrections.js` is therefore re-pointed, not dropped — same binding,
// its new home, one line up.
import { retypeCarryOver } from './corrections.js';
// The `~`/`✓` predicate itself, not a second reading of it: the supersession
// gate below refuses a machine retiring what the room is shown as confirmed, so
// it has to ask the same function the glyph is rendered from.
import { epistemicStateOf } from './epistemic.js';
import { type AuthoredEvent, CoreEvent, type TrustedContext } from './events.js';
import { normalizeForReceipt } from './matching.js';
import {
  AcceptedObject,
  type AcceptedObjectType,
  ClaimPayload,
  CommitmentPayload,
  DecisionPayload,
  ObjectivePayload,
  OpenQuestionPayload,
  payloadText,
} from './objects.js';
import { decideSupersession, MODEL_ACCEPTANCE_FLOOR, typeCertifiableFromText } from './policy.js';
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
 * The reducer's three answers to one event.
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
 *
 * A **malformed** event never even became an event. It failed `CoreEvent.parse`,
 * so there is no `type` to dispatch on, no `(at, id)` to sort by, and nothing to
 * fold — the value is handed back verbatim as `unknown`, because typing it as a
 * `CoreEvent` would be the lie the parse just refused. Like a rejection it
 * changes nothing; unlike a rejection its problem is the payload rather than the
 * payload's position, so re-minting it at a later timestamp will not help.
 *
 * Every non-malformed outcome carries the **trusted actor** the event was folded
 * under, not one read out of the payload — the payload has no such field. A
 * caller logging "who did this" is logging the authenticated identity or nothing.
 */
export type EventOutcome =
  | { outcome: 'applied'; event: CoreEvent; actor: Actor }
  | { outcome: 'applied_with_issue'; event: CoreEvent; actor: Actor; issues: ReducerIssue[] }
  | {
      outcome: 'rejected';
      event: CoreEvent;
      actor: Actor;
      reason: RejectionReason;
      detail: string;
    }
  | { outcome: 'malformed'; event: unknown; actor: Actor; detail: string };

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
 * ## The signature, and why it has three arguments
 *
 * `trusted` is everything the reducer is allowed to believe that did not come
 * out of the payload: the actor, derived from the authenticated session, and the
 * messages a receipt can be checked against. Round 1's gauntlet rated the old
 * two-argument form blocking — the actor was a payload field, so every
 * human-only gate below was a gate a writer could declare itself through. See
 * `TrustedContext` for the contract #22 implements, including where the actor
 * lives when the event is persisted (a column, not the payload jsonb).
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
 *    is judged here — the proposal boundary, the actor floor, the receipt
 *    checks, the correction and relation guards — and none of those judgements
 *    depend on when the event arrived, only on the log before it and the trusted
 *    context handed in with it.
 * 4. Therefore the consumed sequence is in canonical order **by construction**.
 *    Write `L` for the ledger rows a state consumed, in the order it consumed
 *    them. Then, whatever order those events *arrived* in:
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
 *    A row is the payload *and its trusted columns*: replaying an event under a
 *    different actor is replaying a different event, so #22 persists the actor
 *    with it and hands it back on replay.
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
 *
 * ## The payload is parsed here, not trusted here
 *
 * The parameter is typed `CoreEvent`, and the runtime does not believe the type.
 * Round 2's gauntlet found the gap: every existing test parsed its fixtures
 * before folding them, so the *boundary* had never been exercised, and a caller
 * handing over a plain object — a row read back from jsonb, a decoded request
 * body, anything that reached TypeScript as `any` — got it folded unvalidated. A
 * model claim with no `quote` at all went in and came out an accepted object,
 * with the schema that forbids it sitting one layer up, never called.
 *
 * So every event is run through `CoreEvent.parse` on the way in, and the
 * *parsed* value is what gets folded — which also means defaults (`patch: {}`,
 * `toType: null`, a proposal's `status`) are applied here rather than assumed to
 * have been applied by somebody else. A payload that fails is `malformed`: not
 * consumed, not recorded, state untouched.
 */
export function appendEvent(
  state: CoreState,
  event: CoreEvent,
  trusted: TrustedContext,
): AppendResult {
  const parsed = CoreEvent.safeParse(event);
  if (!parsed.success) {
    return {
      outcome: 'malformed',
      event,
      actor: trusted.actor,
      detail: parseFailureDetail(parsed.error),
      state,
    };
  }
  const entry: AuthoredEvent = { ...trusted, event: parsed.data };
  const rejection = rejectionFor(state, parsed.data);
  if (rejection) {
    return { outcome: 'rejected', event: parsed.data, actor: trusted.actor, ...rejection, state };
  }
  const next = cloneState(state);
  return { ...consume(next, entry), state: next };
}

/**
 * A parse failure, as a sentence a caller can act on.
 *
 * The actor guard gets its own opening line because it is the one failure whose
 * cause is a *design* the caller has not read yet, rather than a field they got
 * wrong: somebody is sending an actor in the payload and believes it is doing
 * something. Telling them "invalid input" would be true and useless.
 */
function parseFailureDetail(error: z.core.$ZodError): string {
  const issues = error.issues.map(describeIssue);
  const forgedActor = error.issues.some((issue) => issue.path[0] === 'actor');
  const preamble = forgedActor
    ? 'event payload carries an actor and was refused at the boundary'
    : 'event payload does not parse as a CoreEvent and was refused at the boundary';
  return `${preamble} — not consumed, not recorded, nothing folded: ${issues.join('; ')}`;
}

/**
 * The deterministic reducer: fold a whole log into a state.
 *
 * Contract:
 *  - Pure. No clock, no randomness, no I/O. Given the same ledger rows it
 *    returns a state that serializes byte-identically, on any machine, in any
 *    order of arrival — rows are canonically ordered by `(at, id)` before
 *    folding.
 *  - **Validating.** Every row's payload goes through `CoreEvent.parse` before
 *    anything else looks at it, and the parsed value is what is folded. A row
 *    that does not parse is reported as `malformed` by `foldEvents` and takes no
 *    part in the fold. Round 2's gauntlet: the schemas that forbid a model claim
 *    without a quote were only ever run by tests that parsed their own fixtures,
 *    so the boundary they were guarding had never been crossed in anger.
 *  - Total. An unapplicable event never throws; it lands in `state.issues` so
 *    replay of a real log can never wedge.
 *  - Append-only. Corrections and supersessions change *status*, never history:
 *    the prior value is written to `state.corrections` and the object stays.
 *  - Trust-preserving. The proposal → acceptance boundary is enforced here, not
 *    upstream: a recorded proposal is always `proposed`; an acceptance that
 *    cites a proposal must cite one that exists, is still open, has not already
 *    been spent, matches the object's type, carries the payload that was staged,
 *    and — for a non-human actor — survives its receipt. See `authority.ts`.
 *
 * `reduce(log)` sorts, so nothing in a fresh replay is genuinely out of order:
 * the only events rejected are repeats. A verbatim repeat sorts onto the
 * position its twin just took and is refused there (`out_of_order`); a repeated
 * id carrying a different timestamp sorts elsewhere and is refused by the id
 * (`duplicate`). `reduce(log, state)` is the same fold continued: events at or
 * before `state.cursor` are rejected and skipped, exactly as `appendEvent` would
 * reject them. Use `foldEvents` when you need to see *which* ones, and
 * `appendEvent` when you are consuming one at a time — that is where the
 * outcome matters.
 */
export function reduce(log: readonly AuthoredEvent[], initial?: CoreState): CoreState {
  return foldEvents(log, initial).state;
}

/**
 * `reduce`, plus the per-event outcome. Same fold, nothing hidden.
 *
 * Rows are **parsed before they are ordered**, because a row that does not parse
 * has no `(at, id)` to be ordered by — asking where a malformed value sorts is
 * asking a question about a field it may not have. Malformed rows come back
 * first, in the order they were supplied, and take no part in the fold. That is
 * the one place output order depends on input order, and it is confined to rows
 * that are not ledger rows: the *state* is unchanged by them, so the
 * live≡replay guarantee below is untouched.
 */
export function foldEvents(log: readonly AuthoredEvent[], initial?: CoreState): FoldResult {
  const state = initial ? cloneState(initial) : emptyState();
  const outcomes: EventOutcome[] = [];
  const rows: AuthoredEvent[] = [];

  for (const entry of log) {
    const parsed = CoreEvent.safeParse(entry.event);
    if (!parsed.success) {
      outcomes.push({
        outcome: 'malformed',
        event: entry.event,
        actor: entry.actor,
        detail: parseFailureDetail(parsed.error),
      });
      continue;
    }
    rows.push({ ...entry, event: parsed.data });
  }

  for (const entry of orderEvents(rows)) {
    const rejection = rejectionFor(state, entry.event);
    outcomes.push(
      rejection
        ? { outcome: 'rejected', event: entry.event, actor: entry.actor, ...rejection }
        : consume(state, entry),
    );
  }
  return { state, outcomes };
}

/** True when the event was consumed — i.e. it belongs in the durable log. */
export function wasConsumed(outcome: EventOutcome): boolean {
  return outcome.outcome === 'applied' || outcome.outcome === 'applied_with_issue';
}

/**
 * Canonical event order: ascending timestamp, ties broken by event id. Two
 * nodes handed the same set in different orders reduce to the same state.
 *
 * This is a sort and only a sort — it does not parse. `foldEvents` parses first
 * and orders the survivors, because a row whose payload is not a `CoreEvent` has
 * no `(at, id)` to sort by. A caller ordering rows it has not had parsed is
 * ordering them by whatever `at` and `id` they happen to carry.
 */
export function orderEvents(log: readonly AuthoredEvent[]): AuthoredEvent[] {
  return [...log].sort((a, b) => compareCursor(cursorOf(a.event), cursorOf(b.event)));
}

/** The canonical sort key of an event. */
export function cursorOf(event: CoreEvent): EventCursor {
  return { at: event.at, id: event.id };
}

/**
 * The comparison `orderEvents` sorts by, exposed so callers can reason about
 * order.
 *
 * **Ordered by the instant, not by the spelling of it — r8.** This read
 * `compare(a.at, b.at)` on the raw strings, and `Timestamp` admits several
 * spellings of one moment. `'.'` sorts before `'Z'`, so `…T00:00:00.500Z`
 * compared *earlier* than `…T00:00:00Z` — half a second later, rejected as
 * `out_of_order`, unrecoverably. `instantKey` is the canonical form; see its
 * docblock in `common.ts` for why the fix is here and not in the schema.
 *
 * Two spellings of the same instant now compare equal and fall through to the id
 * tiebreak, which is the same total order the promise in `reduce`'s contract
 * describes — and now the same one it delivers.
 */
export function compareCursor(a: EventCursor, b: EventCursor): number {
  const ka = instantKey(a.at);
  const kb = instantKey(b.at);
  return ka === kb ? compare(a.id, b.id) : compare(ka, kb);
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
    case 'proposal_superseded':
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
function consume(state: CoreState, entry: AuthoredEvent): EventOutcome {
  const { event, actor } = entry;
  const issuesBefore = state.issues.length;
  const roomId = resolveRoomId(state, event);
  const applied = dispatch(state, entry);

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
    ? { outcome: 'applied_with_issue', event, actor, issues }
    : { outcome: 'applied', event, actor };
}

/** Applies one event. Returns whether it was applied; issues are recorded in state. */
function dispatch(state: CoreState, entry: AuthoredEvent): boolean {
  const { event, actor } = entry;
  switch (event.type) {
    case 'proposal_recorded':
      return applyProposalRecorded(state, event, actor);
    case 'proposal_rejected':
      return applyProposalRejected(state, event, actor);
    case 'proposal_superseded':
      return applyProposalSuperseded(state, event, actor);
    case 'object_accepted':
      return applyObjectAccepted(state, event, actor, entry.messages);
    case 'object_corrected':
      return applyObjectCorrected(state, event, actor);
    case 'relation_added':
      return applyRelationAdded(state, event, actor);
    default: {
      const exhaustive: never = event;
      fail(state, (exhaustive as CoreEvent).id, 'unknown event type');
      return false;
    }
  }
}

type EventOf<T extends CoreEvent['type']> = Extract<CoreEvent, { type: T }>;

function applyProposalRecorded(
  state: CoreState,
  event: EventOf<'proposal_recorded'>,
  actor: Actor,
): boolean {
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
    // Who typed it, from the trusted context — never from the payload. See
    // `ProposalRecord.stagedBy`: `proposal.proposer` is what the reading claims
    // to be, and staging stays open to every actor, so the only thing that makes
    // the claim answerable later is recording who made it.
    stagedBy: actor,
    status: 'proposed',
    acceptedObjectId: null,
    rejectedReason: null,
    supersededByProposalId: null,
    supersededReason: null,
  };
  return true;
}

function applyProposalRejected(
  state: CoreState,
  event: EventOf<'proposal_rejected'>,
  actor: Actor,
): boolean {
  const record = state.proposals[event.proposalId];
  if (!record) {
    fail(state, event.id, `unknown proposal "${event.proposalId}"`);
    return false;
  }

  // Actor binding, before status — authority is a property of the event, status
  // is a property of what it points at, and an interpreter with no business
  // touching this proposal should be told that rather than sent to check
  // whether it is still open.
  //
  // r4 left `proposal_rejected` open to any actor on the grounds that
  // withdrawing a staged reading destroys nothing. That is true of a model
  // withdrawing *its own* reading. It is not true of one interpreter retiring
  // another's — or a human's — before anyone has seen it, which is a silent
  // delete with no correction chain, performed by the one kind of actor that may
  // not correct anything.
  if (!actorMatchesProposer(actor, record.proposal.proposer)) {
    fail(
      state,
      event.id,
      proposalBindingRefusal(
        'rejection_binding',
        actor,
        record.proposal.proposer,
        event.proposalId,
      ),
    );
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
  if (record.status === 'superseded') {
    fail(state, event.id, `proposal "${event.proposalId}" was already superseded`);
    return false;
  }
  record.status = 'rejected';
  record.rejectedReason = event.reason;
  return true;
}

/**
 * A newer reading retires an older one. See `ProposalSuperseded` for why this is
 * not a rejection: nobody judged it, so telling the room a person declined it
 * would be a lie about who did what.
 */
function applyProposalSuperseded(
  state: CoreState,
  event: EventOf<'proposal_superseded'>,
  actor: Actor,
): boolean {
  const record = state.proposals[event.proposalId];
  if (!record) {
    fail(state, event.id, `unknown proposal "${event.proposalId}"`);
    return false;
  }
  if (!actorMatchesProposer(actor, record.proposal.proposer)) {
    fail(
      state,
      event.id,
      proposalBindingRefusal(
        'supersession_binding',
        actor,
        record.proposal.proposer,
        event.proposalId,
      ),
    );
    return false;
  }
  if (record.status !== 'proposed') {
    fail(state, event.id, `proposal "${event.proposalId}" was already ${record.status}`);
    return false;
  }

  const byId = event.supersededByProposalId;
  if (byId !== null) {
    if (byId === event.proposalId) {
      fail(state, event.id, `proposal "${event.proposalId}" cannot supersede itself`);
      return false;
    }
    const replacement = state.proposals[byId];
    if (!replacement) {
      fail(
        state,
        event.id,
        `proposal "${event.proposalId}" is superseded by unknown proposal "${byId}"`,
      );
      return false;
    }
    if (replacement.proposal.roomId !== record.proposal.roomId) {
      fail(
        state,
        event.id,
        `proposal "${byId}" is in room "${replacement.proposal.roomId}", not "${record.proposal.roomId}" — a re-reading cannot cross rooms`,
      );
      return false;
    }
  }

  record.status = 'superseded';
  record.supersededByProposalId = byId;
  record.supersededReason = event.reason;
  return true;
}

function applyObjectAccepted(
  state: CoreState,
  event: EventOf<'object_accepted'>,
  actor: Actor,
  messages: TrustedContext['messages'],
): boolean {
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
  const subject = `object "${object.id}"`;

  // The types a machine may not mint at all, whatever its confidence.
  //
  // A decision is the one #4 bans inference at by name: "that sounds good" is
  // where the ambiguity lives. r5 adds commitment and objective — see
  // `modelMintingGate`, which reads the same θ table `MODEL_ACCEPTANCE_FLOOR`
  // does, so this gate and that floor cannot disagree about which types are in
  // the row. Note this gate does not care whether a proposal was cited — an
  // interpreter accepting *its own* decision proposal is exactly the move.
  const mintingGate = modelMintingGate(object.type);
  if (mintingGate !== null && !isHuman(actor)) {
    fail(state, event.id, humanOnlyRefusal(mintingGate, actor, subject));
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
    if (proposal.status === 'superseded') {
      fail(
        state,
        event.id,
        `proposal "${proposalId}" was already superseded by "${proposal.supersededByProposalId ?? 'a newer reading'}" — accept the reading that replaced it`,
      );
      return false;
    }

    // A non-human actor may only accept what it itself staged. Two interpreters
    // run against one room by construction (#7's two tiers), and without this
    // the cheap tier can land the expensive tier's staged readings — or a
    // person's, which is a machine minting a human's judgement.
    if (!actorMatchesProposer(actor, proposal.proposal.proposer)) {
      fail(
        state,
        event.id,
        proposalBindingRefusal('acceptance_binding', actor, proposal.proposal.proposer, proposalId),
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

    // ── θ, as a trust boundary rather than a manner ──
    //
    // The gates above close the *types* a model may not mint. This closes the
    // rest of the write surface, and it is the engine's own θ_auto: round 1's
    // gauntlet routed the split (a separate, lower "malformed" floor) as a hole,
    // because a model could land a claim at 0.55 that the engine at 0.7 would
    // never have emitted. One number, read from `policy.ts` by both.
    if (!isHuman(actor)) {
      // ── The receipt, and it is ruled on before the confidence ──
      //
      // Payload binding, provenance binding, a message window at all, the quote,
      // and third-party attribution. All five were call-site manners in round 1.
      //
      // **Above the confidence floor since r5**, for the reason `acceptance.ts`
      // gives at length where the same ordering mattered more: the two answer
      // different questions. The floor asks how sure the model was; the receipt
      // asks whether the citation and the sentence agree. Both refuse the fold,
      // so nothing is at stake here except which reason the room is shown — and
      // "the quote says the opposite of the statement" is the one worth showing.
      // A refusal that reports the cheaper finding buries the more serious one.
      const refusal = acceptanceReceiptRefusal({
        actor,
        proposalId,
        proposal: proposal.proposal,
        object,
        messages,
      });
      if (refusal) {
        fail(state, event.id, refusal.detail);
        return false;
      }

      // ── …and θ, as a trust boundary rather than a manner ──
      const floor = MODEL_ACCEPTANCE_FLOOR[object.type];
      if (proposal.proposal.confidence < floor) {
        fail(
          state,
          event.id,
          confidenceFloorRefusal(actor, object.type, proposalId, proposal.proposal.confidence),
        );
        return false;
      }

      // ── …and the one thing the receipt cannot settle, r7 ──────────────────
      //
      // The engine's twin is `acceptance.ts`'s `type_not_certified` row and the
      // predicate is the same function, because a rule applied at one site is
      // not a rule and `#21`'s whole history is the two drifting. `type` is
      // supplied by the proposal and it selected which rule judged the proposal:
      // one body, one quote, one author, `pending` as a commitment and
      // `auto_accept` as a claim.
      //
      // Read over the **object's own payload text**, not the proposal's — those
      // are checked equal three screens up (`payload_binding`), and reading the
      // thing being minted is the honest place to ask what is being minted.
      // Over `normalizeForReceipt` of the payload text, r8 — the engine's twin
      // read the raw statement and so did this, so the same zero-width splice
      // walked through both. See `ReceiptText` in `common.ts`.
      if (
        !typeCertifiableFromText(
          object.type,
          normalizeForReceipt(payloadText(object.type, object.payload)),
        )
      ) {
        fail(state, event.id, uncertifiedTypeRefusal(actor, object.type, subject));
        return false;
      }
    }
  }

  // ── Attribution: the mint route ──────────────────────────────────────────
  //
  // **Outside the `proposalId !== null` block, which is where r9 left it.**
  // `actorMatchesProposer` asks whether this actor may touch a reading of this
  // *description*; this asks who wrote the description, and it has to be asked
  // of every acceptance rather than only the ones that cite a proposal. An
  // acceptance citing no proposal at all is human-only (above) and unreachable
  // from today's command layer — `objectFromProposal` always names one — but the
  // reducer is the boundary, not the command layer, and a route that only
  // *happens* not to be reachable is a route the check has to cover anyway.
  // With no proposal there is no stager but the accepter, and no reading to
  // describe, so the gate reduces to its second clause: your own name only.
  //
  // See `selfStagedReadingRefusal` for why it is a refusal rather than a receipt
  // check, and for what stays deliberately open (#22 r9 D1, r10 D2).
  const selfStaged = selfStagedReadingRefusal({
    actor,
    proposalId,
    proposer: proposal?.proposal.proposer ?? null,
    stagedBy: proposal?.stagedBy ?? actor,
    attributedTo: payloadAttributions(object.type, object.payload),
  });
  if (selfStaged) {
    fail(state, event.id, selfStaged);
    return false;
  }

  // ── #95's HUMAN relation matrix (#102), the three rules keyed on the actor's
  // relation to the object rather than only on its kind. The kind gates above
  // (`modelMintingGate`, `claim_verification`, `direct_acceptance`) answer *may
  // this species certify at all*; these answer *may this actor certify THIS
  // object*, and both must pass. Each is reducer-enforceable from state alone —
  // the stager (`proposal.stagedBy`), the owner and claimant (payload) — so none
  // needs the command layer's session context.

  // Verification is a second pair of eyes (#68/H2): a claim reaches `verified`
  // only through a human who is neither its claimant nor the stager of its
  // reading. A disinterested member verifying stays open — that is verification
  // working, not a hole (#68's redirect). The gate at the top of this function
  // still refuses a *machine* verifying; this is the relation layer above it.
  if (object.type === 'claim' && object.payload.verification === 'verified' && isHuman(actor)) {
    const refusal = selfVerificationRefusal({
      actor,
      claimant: object.payload.claimant,
      stagedBy: proposal?.stagedBy ?? actor,
    });
    if (refusal) {
      fail(state, event.id, refusal);
      return false;
    }
  }

  // Owner-confirm (#67): a third-party commitment is confirmed by its named
  // owner, not by any member on their behalf. `commitment_acceptance` above
  // refuses a machine minting one at all; this is the relation rule for the
  // humans it admits, and #95 reversed the "any human other than the stager"
  // design position `selfStagedReadingRefusal` used to document.
  if (object.type === 'commitment' && isHuman(actor)) {
    const refusal = ownerConfirmRefusal({ actor, owner: object.payload.owner });
    if (refusal) {
      fail(state, event.id, refusal);
      return false;
    }
  }

  // Amended acceptance (#81/H3): the human path skips payload binding, so an
  // accepter may reword a reading — but only into a sentence naming nobody but
  // themselves, or accept it verbatim. `selfStagedReadingRefusal` above caught
  // the accepter who *staged* the reading; this catches the one who did not and
  // mints a changed sentence over somebody else's staged one. If the amended
  // sentence states a third party's commitment, `ownerConfirmRefusal` above has
  // already required the owner to be the accepter.
  if (proposalId !== null && proposal && isHuman(actor)) {
    const staged = { ...object, payload: proposal.proposal.payload } as AcceptedObject;
    const refusal = acceptanceAttributionRefusal({
      actor,
      objectId: object.id,
      proposalId,
      staged,
      object,
    });
    if (refusal) {
      fail(state, event.id, refusal);
      return false;
    }
  }

  // An `objectiveId` that points at nothing is the same defect as a `proposalId`
  // that points at nothing, and is refused for the same reason: it is provenance
  // the UI renders, and an unverifiable one is worse than none. The object files
  // itself under a heading the room cannot open, which reads as "this belongs to
  // something" while belonging to nothing.
  //
  // Refused rather than recorded-and-applied, because `reduce` sorts: in a
  // replay the objective would already be there if it ever existed, so a dangling
  // pointer is not a race, it is wrong. The acceptance can be re-minted with a
  // corrected pointer; a fact filed under a ghost cannot be un-filed.
  const objectiveId = object.objectiveId;
  if (objectiveId !== null) {
    const objective = state.objects[objectiveId];
    if (!objective) {
      fail(
        state,
        event.id,
        `object "${object.id}" belongs to objective "${objectiveId}", which does not exist`,
      );
      return false;
    }
    if (objective.object.type !== 'objective') {
      fail(
        state,
        event.id,
        `object "${object.id}" belongs to "${objectiveId}", which is a ${objective.object.type}, not an objective`,
      );
      return false;
    }
    if (objective.object.roomId !== object.roomId) {
      fail(
        state,
        event.id,
        `object "${object.id}" is in room "${object.roomId}" but its objective "${objectiveId}" is in room "${objective.object.roomId}"`,
      );
      return false;
    }
  }

  const record: ObjectRecord = {
    object,
    acceptedAt: event.at,
    updatedAt: event.at,
    // `~` vs `✓` is derived from this and nothing else — see `epistemic.ts`.
    acceptedBy: actor,
    humanTouchedAt: isHuman(actor) ? event.at : null,
    revision: 0,
    retractedAt: null,
    supersededById: null,
    reopenedFromAnswers: [],
  };
  state.objects[object.id] = record;

  if (proposal) {
    proposal.status = 'accepted';
    proposal.acceptedObjectId = object.id;
  }
  return true;
}

/**
 * What a correction verb decided, before anything has been written.
 *
 * ## Why the verbs return this instead of assigning
 *
 * #22 r10's organizing finding: **#4's invariant was enforced where a reading is
 * *accepted* and nowhere else, while three verbs reach the same end state.**
 * `reattribute` moves a name by definition, `retype` mints one on a type that
 * never carried it, `amend` is kept off one only by a separate check — and each
 * of the three used to assign `record.object` itself, so the gate would have had
 * to be four call sites, with the fifth verb somebody writes next year skipping
 * it silently. That is the shape the core lane has hit three rounds running: *an
 * invariant asserted on one branch of a dispatch does not constrain the others.*
 *
 * So the verbs are planners. They validate their own preconditions, they may
 * `fail` and return `null`, and what they return is a *description* of the next
 * state. **`commitPlan` is the only function in this file that assigns
 * `record.object`, `record.retractedAt` or `record.reopenedFromAnswers`**, and it
 * runs `correctionAttributionRefusal` over every plan before it writes anything.
 *
 * A sixth verb therefore cannot skip the check by forgetting to call it: to
 * change anything at all it has to return a `CorrectionPlan`, and the exhaustive
 * `switch` in `planCorrection` will not compile until it does.
 */
interface CorrectionPlan {
  /**
   * The object as it will read. Identical to the current one for a verb that
   * only tombstones — the gate compares attributions, so "no payload change"
   * says exactly that rather than being a case the gate has to know about.
   */
  object: AcceptedObject;
  /** The correction log's `before` / `after`, verbatim. */
  before: unknown;
  after: unknown;
  /** `retract` sets a timestamp, `restore` clears it, everything else omits it. */
  retractedAt?: string | null;
  /**
   * `reopen`'s prior-answer bookkeeping. Runs after the correction is logged.
   *
   * Not called `then`: an object with a `then` property is a thenable, and a
   * plan that `await` treats as a promise is a class of bug nobody would find
   * twice.
   */
  afterCommit?: (record: ObjectRecord) => void;
}

/**
 * A verb's verdict. `refused` and `noop` have both already called `fail`; the
 * difference is what `dispatch` returns, and therefore whether `consume` reports
 * the event as applied.
 */
type CorrectionOutcome =
  | { kind: 'plan'; plan: CorrectionPlan }
  | { kind: 'refused' }
  | { kind: 'noop' };

const refused: CorrectionOutcome = { kind: 'refused' };
const noop: CorrectionOutcome = { kind: 'noop' };
const planned = (plan: CorrectionPlan): CorrectionOutcome => ({ kind: 'plan', plan });

function applyObjectCorrected(
  state: CoreState,
  event: EventOf<'object_corrected'>,
  actor: Actor,
): boolean {
  const record = state.objects[event.objectId];
  if (!record) {
    fail(state, event.id, `unknown object "${event.objectId}"`);
    return false;
  }

  // Every correction verb is human-only in v1 (#4, and the correction verbs
  // #21 grew are the same shape). A correction rewrites, withdraws or restores
  // something the room already accepted — it is the one operation that reaches
  // backwards, and an interpreter must never reach backwards on its own
  // authority. A model that thinks an object is wrong proposes a supersession.
  //
  // The claim-verification gate is repeated here rather than left to the
  // blanket rule above it. Today it is unreachable — a model cannot amend
  // anything — but the two rules have different lifetimes: a later round may
  // hand a model some correction verb, and "a claim only becomes ✓ by a human"
  // must not depend on that never happening.
  if (!isHuman(actor)) {
    const verifying =
      event.patch.verification === 'verified' &&
      (record.object.type === 'claim' || event.toType === 'claim');
    fail(
      state,
      event.id,
      humanOnlyRefusal(
        verifying ? 'claim_verification' : 'correction',
        actor,
        `object "${event.objectId}"`,
      ),
    );
    return false;
  }

  const outcome = planCorrection(state, event, record);
  if (outcome.kind === 'refused') return false;
  if (outcome.kind === 'noop') return true;

  // ── Attribution: every correction route, one door ────────────────────────
  //
  // Not per-verb. `planCorrection` is a total function from `event.action` to a
  // plan, and this is the only place a plan becomes state — so `reattribute`,
  // `retype`, `amend`, `reopen`, `retract`, `restore` and whatever verb is added
  // next are all checked here, by construction rather than by four remembered
  // calls. See `CorrectionPlan`.
  //
  // The two objects go in whole. r10 passed two name arrays computed here, which
  // left this call site holding half the question — and #22 r11 was the other
  // half arriving unasked: the gate compared names, the text was never looked
  // at, and five `amend`s rewrote a colleague's sentence into a confession under
  // his name with `issues: []` every time. Both questions are answered inside
  // the gate now, so a caller cannot answer either one narrowly.
  const attributionRefusal = correctionAttributionRefusal({
    actor,
    objectId: event.objectId,
    action: event.action,
    before: record.object,
    after: outcome.plan.object,
  });
  if (attributionRefusal) {
    fail(state, event.id, attributionRefusal);
    return false;
  }

  // ── Verification is a second pair of eyes, even for a human (#68/H2, #95) ───
  //
  // The blanket gate above refuses a *machine* correcting at all. This refuses
  // the human relation #95 forbids on the one correction that mints a `✓
  // verified`: the claimant may not verify their own claim, nor may the member
  // who staged it. A third party verifying stays open (#68's redirect) — that is
  // the product. Keyed on the *transition* to verified (`becomesVerified`), so a
  // later edit to an already-verified claim by anyone is not re-gated as a fresh
  // verification. `correctionAttributionRefusal` above has already refused
  // rewording somebody else's sentence, so this adds only the verification act.
  const before = record.object;
  const after = outcome.plan.object;
  const becomesVerified =
    after.type === 'claim' &&
    after.payload.verification === 'verified' &&
    !(before.type === 'claim' && before.payload.verification === 'verified');
  if (isHuman(actor) && becomesVerified && after.type === 'claim') {
    const proposalId = after.provenance.proposalId;
    const stagedBy = proposalId !== null ? (state.proposals[proposalId]?.stagedBy ?? null) : null;
    const refusal = selfVerificationRefusal({
      actor,
      claimant: after.payload.claimant,
      stagedBy,
    });
    if (refusal) {
      fail(state, event.id, refusal);
      return false;
    }
  }

  commitPlan(state, event, record, actor, outcome.plan);
  return true;
}

/**
 * Every correction verb, as a total function from `action` to a plan.
 *
 * Exhaustive over `CorrectionAction` — the `never` in the default arm is what
 * makes a new verb a compile error here rather than a silent fall-through past
 * the gate in `applyObjectCorrected`.
 */
function planCorrection(
  state: CoreState,
  event: EventOf<'object_corrected'>,
  record: ObjectRecord,
): CorrectionOutcome {
  switch (event.action) {
    case 'retract':
      if (record.retractedAt !== null) {
        fail(state, event.id, `object "${event.objectId}" is already retracted`);
        return refused;
      }
      return planned({
        object: record.object,
        before: { retracted: false },
        after: { retracted: true },
        retractedAt: event.at,
        /* THE CORE LANE'S SUPERSESSION BOOKKEEPING, CARRIED INTO THE PLAN.
           `retract`/`restore` used to be inline branches of
           `applyObjectCorrected` and called these two directly, after the
           correction was logged and after `record.retractedAt` was assigned.
           The realtime lane turned every verb into a planner and made
           `commitPlan` the only writer — a restructure that had no place for
           these because that lane never had them. `afterCommit` is that place,
           it already exists for `reopen`'s prior-answer bookkeeping, and it runs
           at exactly the point the inline code did: after the log entry, after
           `retractedAt` is set. A retracted superseder must stop suppressing
           what it superseded; restoring it must put that back. */
        afterCommit: (target) => releaseSupersessions(state, target.object.id, event.at),
      });

    case 'restore':
      if (record.retractedAt === null) {
        fail(state, event.id, `object "${event.objectId}" is not retracted`);
        return refused;
      }
      return planned({
        object: record.object,
        before: { retracted: true },
        after: { retracted: false },
        retractedAt: null,
        /* The other half — see the note on `retract` above. */
        afterCommit: (target) => reapplySupersessions(state, target.object.id, event.at),
      });

    case 'retype':
    case 'reopen':
    case 'reattribute':
    case 'amend': {
      // A retracted object is withdrawn, not editable. Editing one would quietly
      // resurrect content the room already took back; restore it first, in the
      // open.
      if (record.retractedAt !== null) {
        fail(
          state,
          event.id,
          `object "${event.objectId}" is retracted — restore it before ${event.action === 'amend' ? 'amending' : `applying "${event.action}"`}`,
        );
        return refused;
      }
      if (event.action === 'retype') return planRetype(state, event, record);
      if (event.action === 'reopen') return planReopen(state, event, record);
      return planPayloadEdit(state, event, record);
    }

    default: {
      const exhaustive: never = event.action;
      fail(state, event.id, `unknown correction verb ${JSON.stringify(exhaustive)}`);
      return refused;
    }
  }
}

/** `amend` and `reattribute`: the two verbs that patch a payload in place. */
function planPayloadEdit(
  state: CoreState,
  event: EventOf<'object_corrected'>,
  record: ObjectRecord,
): CorrectionOutcome {
  const attributionField = ATTRIBUTION_FIELD[record.object.type];
  const touchesAttribution =
    attributionField !== null && Object.hasOwn(event.patch, attributionField);

  if (event.action === 'reattribute') {
    if (attributionField === null) {
      fail(
        state,
        event.id,
        `a ${record.object.type} has no attribution field — nothing to reattribute; use "amend"`,
      );
      return refused;
    }
    const keys = Object.keys(event.patch);
    if (keys.length === 0) {
      fail(
        state,
        event.id,
        `"reattribute" on object "${event.objectId}" changed nothing — it must set "${attributionField}"`,
      );
      return refused;
    }
    const strays = keys.filter((key) => key !== attributionField);
    if (strays.length > 0) {
      fail(
        state,
        event.id,
        `"reattribute" on object "${event.objectId}" may only change "${attributionField}", not ${strays.map((key) => `"${key}"`).join(', ')} — use "amend" for those`,
      );
      return refused;
    }
  } else if (touchesAttribution) {
    // The verb split, enforced. Moving an obligation off a named person is the
    // most consequential edit in the product (#4), and an `amend` that quietly
    // does it turns "who took this off me" into a substring search over patches.
    fail(
      state,
      event.id,
      `"amend" on object "${event.objectId}" may not change "${attributionField}" — moving a ${record.object.type} onto or off a person is a "reattribute", so the correction log can be read by verb`,
    );
    return refused;
  }

  const patched = applyPayloadPatch(record.object, event.patch);
  if (!patched.ok) {
    fail(
      state,
      event.id,
      event.action === 'amend'
        ? `invalid amendment to "${event.objectId}": ${patched.error}`
        : `invalid ${event.action} of "${event.objectId}": ${patched.error}`,
    );
    return refused;
  }

  // An amendment that changes nothing is a no-op, not a correction. Bumping the
  // revision would invent history — and `revision` is the optimistic-concurrency
  // token, so a phantom bump would spuriously invalidate every open editor.
  //
  // It is recorded as an issue rather than passed over in silence: the object
  // did not change, somebody thought it would, and `applied` with nothing
  // applied is exactly the outcome a caller reads as success. Nothing about the
  // *state* changes — this is a diagnosis, not a refusal.
  if (canonicalJson(patched.after) === canonicalJson(patched.before)) {
    fail(
      state,
      event.id,
      `"${event.action}" on object "${event.objectId}" changed nothing — no correction was recorded and the revision did not move; an edit that matches what is already there is a no-op, not history`,
    );
    return noop;
  }

  return planned({
    object: { ...patched.object, updatedAt: event.at },
    before: patched.before,
    after: patched.after,
  });
}

/**
 * #5's canonical fix: "that was only a suggestion" turns a Decision into a
 * Claim, provenance intact.
 *
 * The envelope — id, room, objective, provenance, createdAt — is carried
 * verbatim, because retyping is a statement about how the sentence was *read*,
 * not about where it came from. The text carries across under the new type's own
 * key (a decision's `statement` becomes a question's `question`), and anything
 * the new type needs that the old one never had must come from the patch. The
 * whole result is re-validated as an `AcceptedObject`, so a retype that would
 * produce an invalid object is refused rather than half-applied — the same rule
 * amendments already follow.
 */
function planRetype(
  state: CoreState,
  event: EventOf<'object_corrected'>,
  record: ObjectRecord,
): CorrectionOutcome {
  const toType = event.toType;
  if (toType === null) {
    fail(
      state,
      event.id,
      `"retype" on object "${event.objectId}" did not say what to retype it to — set "toType"`,
    );
    return refused;
  }
  const from = record.object;
  if (toType === from.type) {
    fail(
      state,
      event.id,
      `object "${event.objectId}" is already a ${toType} — a retype to the same type is not a correction; use "amend"`,
    );
    return refused;
  }

  // ── The invariants the fold enforces at creation, enforced here too — r8 ───
  //
  // **No mutant in the ledger touched this function, and no test reached past
  // its payload.** A retype re-validates the *object* against its new schema and
  // stopped there, so it was the one door into a state the reducer refuses to be
  // handed directly. Two of them, both found by r8's blind review:
  //
  //  1. Retype an `objective` that other objects are filed under, and every one
  //     of them now points at a `decision` through `objectiveId` — the exact
  //     state `applyObjectAccepted` refuses three screens up ("belongs to X,
  //     which is a decision, not an objective"). The control fires; this path
  //     walked around it.
  //  2. Retype an **answered** `open_question` to a `claim`, and the `answers`
  //     edge that settled it now originates from a claim — which
  //     `applyRelationAdded` refuses to create — while `status: 'answered'`
  //     silently disappears, because `retypeCarryOver` moves the text and a
  //     claim has no such field. The room loses the fact that the question was
  //     settled and keeps the edge that settled it.
  //
  // Refused rather than repaired: a correction is a person saying the reading
  // was wrong, and the honest answer to "this retype would break something else"
  // is to name the something else, not to quietly rewrite it. Both messages say
  // what to do first.
  const structural = retypeStructuralRefusal(state, from, toType);
  if (structural) {
    fail(state, event.id, structural);
    return refused;
  }

  // ── …and the verb split survives a round trip — r8 ───────────────────────
  //
  // `applyPayloadPatch` refuses an `amend` that touches the attribution field
  // with *"moving a commitment onto or off a person is a 'reattribute', so the
  // correction log can be read by verb"*. A retype went around it in two hops:
  // commitment(owner: alice) → claim(claimant: mallory) → commitment(owner:
  // mallory), two `retype` rows and no `reattribute` row anywhere, and the
  // correction log answers "who took this off Alice" with silence. The
  // attribution now carries across a retype exactly as the text does
  // (`retypeCarryOver`), and a patch that moves it gets the invariant's own
  // sentence back.
  const carried = retypeCarryOver(from, toType);
  const toField = ATTRIBUTION_FIELD[toType];
  if (toField !== null && carried[toField] !== undefined) {
    const proposed = event.patch[toField];
    if (proposed !== undefined && proposed !== carried[toField]) {
      fail(
        state,
        event.id,
        `"retype" on object "${event.objectId}" may not change "${toField}" from "${String(carried[toField])}" to "${String(proposed)}" — a retype says how the sentence was read, not who it is on; moving a ${toType} onto or off a person is a "reattribute", so the correction log can be read by verb`,
      );
      return refused;
    }
  }

  const payload = { ...carried, ...event.patch };
  const parsed = AcceptedObject.safeParse({
    id: from.id,
    roomId: from.roomId,
    objectiveId: from.objectiveId,
    provenance: from.provenance,
    type: toType,
    payload,
    createdAt: from.createdAt,
    updatedAt: event.at,
  });
  if (!parsed.success) {
    fail(
      state,
      event.id,
      `cannot retype "${event.objectId}" from ${from.type} to ${toType}: ${parsed.error.issues
        .map(describeIssue)
        .join('; ')}`,
    );
    return refused;
  }

  return planned({
    object: parsed.data,
    before: { type: from.type, payload: from.payload },
    after: { type: toType, payload: parsed.data.payload },
  });
}

/**
 * **Retracting the replacement un-retires what it replaced — r8, and the remedy
 * this file already promises in words.**
 *
 * `applyReopen` refuses to reopen a superseded decision and tells the room what
 * to do instead: *"a superseded decision is reopened by retracting the decision
 * that replaced it"*. Executed, that did nothing. `supersededById` was set once
 * by `applyRelationAdded` and never read again by any other path, so retracting
 * the superseder left the superseded object exactly as superseded as before —
 * not live, not in the panel, status `superseded` — and the second supersession
 * gate refuses to point anything new at it. Supersession was a one-way door with
 * a sign on it naming an exit that was painted on.
 *
 * A refusal that names a remedy is a promise, and r8's own adjudication turned
 * on the same defect one file over (`acceptance.ts` promising Needs-you for a
 * reading `projectAttention` skipped). So this is the remedy, implemented:
 *
 *  - **Retract X** → everything X superseded is released. `supersededById` goes
 *    back to `null` (or to another superseder that is still live, if one exists
 *    because this one was released and replaced), and a decision's status goes
 *    back to `active`.
 *  - **Restore X** → it takes back anything still unclaimed. Anything a *third*
 *    object has since retired stays retired: two live objects claiming to
 *    supersede one target is the state `applyRelationAdded` refuses, and restore
 *    is not a door into it either.
 *
 * The relation is never removed — the log is append-only and the room is
 * entitled to see that the retirement happened and was withdrawn. What moves is
 * the derived field, which is what "supersession lives in the relation graph"
 * meant all along.
 */
function supersessionEdges(state: CoreState, supersederId: string) {
  return state.relations.filter(
    (relation) =>
      relation.kind === 'supersedes' &&
      relation.fromObjectId === supersederId &&
      relation.to.kind === 'object',
  );
}

function releaseSupersessions(state: CoreState, supersederId: string, at: string): void {
  for (const relation of supersessionEdges(state, supersederId)) {
    if (relation.to.kind !== 'object') continue;
    const target = state.objects[relation.to.objectId];
    if (!target || target.supersededById !== supersederId) continue;
    const stillLive = supersedersOf(state, target.object.id).find(
      (id) => id !== supersederId && state.objects[id]?.retractedAt === null,
    );
    setSuperseded(target, stillLive ?? null, at);
  }
}

function reapplySupersessions(state: CoreState, supersederId: string, at: string): void {
  for (const relation of supersessionEdges(state, supersederId)) {
    if (relation.to.kind !== 'object') continue;
    const target = state.objects[relation.to.objectId];
    if (!target || target.supersededById !== null) continue;
    setSuperseded(target, supersederId, at);
  }
}

function supersedersOf(state: CoreState, targetId: string): string[] {
  return state.relations
    .filter(
      (relation) =>
        relation.kind === 'supersedes' &&
        relation.to.kind === 'object' &&
        relation.to.objectId === targetId,
    )
    .map((relation) => relation.fromObjectId);
}

function setSuperseded(target: ObjectRecord, supersededById: string | null, at: string): void {
  target.supersededById = supersededById;
  target.updatedAt = at;
  if (target.object.type === 'decision') {
    target.object = {
      ...target.object,
      payload: {
        ...target.object.payload,
        status: supersededById === null ? 'active' : 'superseded',
      },
      updatedAt: at,
    };
  }
}

/**
 * **Everything about a retype that is not about its own payload.**
 *
 * The schema re-validation inside `applyRetype` answers *"is the result a valid
 * object of the new type"*. These answer *"is the result a valid **state**"* —
 * the questions `applyObjectAccepted` and `applyRelationAdded` ask when the same
 * shapes are built the ordinary way. Every entry here is a rule that already
 * exists somewhere else in this file, and the reason it needs restating is the
 * one `RETRO.md` keeps recording: a rule with one enforcement point is not a
 * rule, and a correction verb is a second way in.
 */
function retypeStructuralRefusal(
  state: CoreState,
  from: AcceptedObject,
  toType: AcceptedObjectType,
): string | null {
  if (from.type === 'objective' && toType !== 'objective') {
    const filed = Object.keys(state.objects)
      .sort()
      .filter((id) => state.objects[id]?.object.objectiveId === from.id);
    if (filed.length > 0) {
      return `objective "${from.id}" cannot be retyped to a ${toType} — ${filed.length === 1 ? `object "${filed[0]}" is` : `${filed.length} objects (${filed.map((id) => `"${id}"`).join(', ')}) are`} filed under it, and an acceptance that pointed at a ${toType} this way is refused; move ${filed.length === 1 ? 'it' : 'them'} to another objective first`;
    }
  }

  const answersFrom = liveAnswers(state).filter((relation) => relation.fromObjectId === from.id);
  if (answersFrom.length > 0 && toType !== 'open_question') {
    return `open question "${from.id}" cannot be retyped to a ${toType} — ${answersFrom.length === 1 ? `relation "${answersFrom[0]?.id}" answers it` : `${answersFrom.length} relations answer it`}, and an "answers" edge may only originate from an open question; reopen it first, so the room can see the question stopped being settled before it stopped being a question`;
  }

  const answersTo = liveAnswers(state).filter(
    (relation) => relation.to.kind === 'object' && relation.to.objectId === from.id,
  );
  if (answersTo.length > 0 && toType !== 'decision' && toType !== 'claim') {
    return `object "${from.id}" cannot be retyped to a ${toType} — ${answersTo.length === 1 ? `relation "${answersTo[0]?.id}" points at it as an answer` : `${answersTo.length} relations point at it as an answer`}, and an "answers" edge may only target a decision or a claim; reopen the question it settles first`;
  }

  return null;
}

/**
 * `answers` edges that are still doing work.
 *
 * An edge listed in its question's `reopenedFromAnswers` is **history**: the room
 * has said the question is no longer settled, `applyReopen` copied the edge onto
 * that list precisely so the prior conclusion stays visible, and the edge is not
 * holding any status in place any more. Scoping the retype gates to live edges
 * is what makes their refusals name a remedy that works — `reopen` is a verb
 * this reducer has, and "retract the relation" is not.
 */
function liveAnswers(state: CoreState): Extract<CoreState['relations'][number], object>[] {
  return state.relations.filter(
    (relation) =>
      relation.kind === 'answers' &&
      !(state.objects[relation.fromObjectId]?.reopenedFromAnswers ?? []).includes(relation.id),
  );
}

/**
 * #5's `reopen`: "answered/accepted returns to pending, prior answer preserved
 * on record" — the v6 affordance.
 *
 * The `answers` edges are not removed; the relation log is append-only and
 * removing them would erase the fact that the room once thought this was
 * settled. What changes is the question's status, and the edges that had settled
 * it are copied onto `reopenedFromAnswers` so the UI can say *what* the room had
 * concluded before somebody reopened it. Without that list, an answered-then-
 * reopened question is indistinguishable from one that was never answered, and
 * the reopen has erased exactly the thing it promised to preserve.
 */
function planReopen(
  state: CoreState,
  event: EventOf<'object_corrected'>,
  record: ObjectRecord,
): CorrectionOutcome {
  const { object } = record;

  if (object.type === 'open_question') {
    if (object.payload.status !== 'answered') {
      fail(state, event.id, `open question "${event.objectId}" is already open`);
      return refused;
    }
    const answers = state.relations
      .filter((relation) => relation.kind === 'answers' && relation.fromObjectId === object.id)
      .map((relation) => relation.id);
    return planned({
      object: {
        ...object,
        payload: { ...object.payload, status: 'open' },
        updatedAt: event.at,
      },
      before: { status: 'answered', answeredBy: answers },
      after: { status: 'open', priorAnswers: answers },
      afterCommit: (target) => {
        for (const id of answers) {
          if (!target.reopenedFromAnswers.includes(id)) target.reopenedFromAnswers.push(id);
        }
      },
    });
  }

  if (object.type === 'commitment') {
    if (object.payload.status === 'open') {
      fail(state, event.id, `commitment "${event.objectId}" is already open`);
      return refused;
    }
    return planned({
      object: {
        ...object,
        payload: { ...object.payload, status: 'open' },
        updatedAt: event.at,
      },
      before: { status: object.payload.status },
      after: { status: 'open' },
    });
  }

  // A decision's supersession lives in the relation graph, not in a status
  // field a correction can flip: reopening one would leave `supersededById`
  // pointing at the object that replaced it while both claimed to be current.
  // Retract the superseding decision instead — in the open, with a chain.
  fail(
    state,
    event.id,
    `a ${object.type} cannot be reopened — only an answered question or a closed commitment can; a superseded decision is reopened by retracting the decision that replaced it`,
  );
  return refused;
}

/**
 * Write one correction to the log and move the record with it. **The only
 * writer of `record.object`, `record.retractedAt` and `record.reopenedFromAnswers`
 * on the correction path.**
 *
 * Every verb goes through here, so `revision`, `updatedAt` and `humanTouchedAt`
 * cannot drift apart per-verb — which they did the last time each branch kept
 * its own copy of these three lines. Since r10 the same singleness is what makes
 * the attribution gate unskippable: the gate runs immediately before this call,
 * over the plan this call is about to install, and there is no other way to
 * install one.
 */
function commitPlan(
  state: CoreState,
  event: EventOf<'object_corrected'>,
  record: ObjectRecord,
  actor: Actor,
  plan: CorrectionPlan,
): void {
  const { before, after } = plan;
  state.corrections.push({
    eventId: event.id,
    objectId: record.object.id,
    // The type as it reads *now*, before a retype changes it — see
    // `CorrectionRecord.objectType`.
    objectType: record.object.type as AcceptedObjectType,
    action: event.action,
    before,
    after,
    // The trusted actor, not a payload field: "who took this off me" is a
    // question about an authenticated identity or it is not a question.
    actor,
    provenance: event.provenance,
    note: event.note,
    at: event.at,
  });
  record.object = plan.object;
  if (plan.retractedAt !== undefined) record.retractedAt = plan.retractedAt;
  record.updatedAt = event.at;
  record.revision += 1;
  // Corrections are human-only, so reaching here means a person has now taken
  // responsibility for this object: `~` becomes `✓`.
  if (record.humanTouchedAt === null && isHuman(actor)) {
    record.humanTouchedAt = event.at;
  }
  plan.afterCommit?.(record);
}

function applyRelationAdded(
  state: CoreState,
  event: EventOf<'relation_added'>,
  actor: Actor,
): boolean {
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
    // …and it is human-only. Round 1's gauntlet: any actor could close a
    // person's open question by pointing an arbitrary claim at it, and the
    // question would flip to `answered` and leave everybody's Needs-you. #4
    // gives a decision exactly two doors — answer-binding and an explicit
    // human accept — and an `answers` edge is the first one, so it is gated
    // like the second. A model that thinks it knows the answer proposes it.
    if (!isHuman(actor)) {
      fail(
        state,
        event.id,
        humanOnlyRefusal('answer_relation', actor, `relation "${relation.id}"`),
      );
      return false;
    }
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
    // ── The other three of `answerBindingRefusal`'s seven — r8 ──────────────
    //
    // `acceptance.ts` says of that function, in its own words: *"checked here so
    // a caller can refuse before minting events, and checked again by the
    // reducer because a check that only runs upstream is not a check."* The
    // reducer repeated four of the seven. These are two of the three it did not,
    // and both were live:
    //
    //  - A raw `answers` edge flipped a **retracted** question to `answered`, so
    //    a question the room had withdrawn came back settled.
    //  - Two `answers` edges landed on one question, which is verbatim round 1's
    //    gauntlet finding — fixed then in the command layer only, which is the
    //    shape this whole ticket keeps rediscovering.
    //
    // `reopen` is the route that stays open, and both messages name it: it is
    // what puts an answered question back to `open` while keeping the prior
    // answer on the record (`reopenedFromAnswers`).
    if (from.retractedAt !== null) {
      fail(
        state,
        event.id,
        `open question "${from.object.id}" is retracted — restore it before answering, or an edge would mark a withdrawn question settled`,
      );
      return false;
    }
    if (from.object.type === 'open_question' && from.object.payload.status !== 'open') {
      fail(
        state,
        event.id,
        `open question "${from.object.id}" is already answered — reopen it before binding a different answer, so the room can see that it was settled twice`,
      );
      return false;
    }
  }

  if (relation.kind === 'supersedes' && target) {
    // #4 splits supersession by what is being retired, and the reducer enforces
    // **the whole split**, not the decision row of it. Round 1's gauntlet found
    // the gap: `decideSupersession` required a human for commitments and
    // objectives while this gate asked only about decisions, so a model could
    // retire a human-accepted commitment — and silence the attention item that
    // went with it — through a door the policy believed was shut. One table,
    // read from `policy.ts`.
    const retired = target.object.type;
    if (decideSupersession(retired).authority === 'requires_human' && !isHuman(actor)) {
      fail(
        state,
        event.id,
        humanOnlyRefusal('supersession', actor, `relation "${relation.id}"`, retired),
      );
      return false;
    }
    // …and the rule the type table cannot express, because it is not about the
    // type. #95: **a non-human may never retire an accepted object by
    // superseding it — it may only draft a superseding reading (`~`).**
    // `decideSupersession` calls a claim and an open question `auto_accept` —
    // cheap to correct, one reading replacing another — which reads as though a
    // machine may swap one for the next. It may not: the swap is a `supersedes`
    // relation that retires an *accepted* object, and #95 puts every such
    // retirement in a person's hand. Drafting a fresh `~` is the open route;
    // retiring the standing one never is.
    //
    // Harmless while every non-human was anonymous and could not hold a room
    // membership. #96 gives a machine a session, and both of that round's blind
    // critics walked an authenticated agent straight through here to retire
    // human-accepted claims and open questions. The matrix in
    // `authority-matrix.test.ts` asserted that was correct.
    //
    // #96 r2 closed the `✓` half; #96 r3 closes the `~` half its critic found
    // still open. Keying on `epistemicStateOf(target) === 'confirmed'` refused a
    // machine retiring a person's `✓` but let it retire a model's unconfirmed
    // `~` — and since an agent owns no proposal of its own, every unconfirmed
    // accepted object it reaches belongs to another machine, so that path was a
    // machine unmaking another machine's reading, foreign and always reachable.
    // #95's rule is on the *relation* (a non-human retiring anything accepted),
    // not on the epistemic state, so the gate is now `!isHuman(actor)`.
    //
    // `epistemicStateOf` still decides only the *message* — the predicate the
    // product renders `✓` from, one definition, so the reason a room is shown
    // names the `✓`/`~` distinction without a second opinion on it. #90's audit
    // asked for exactly this check and this is where it became a product
    // consumer of `epistemic.ts` rather than a renderer's private opinion.
    if (!isHuman(actor)) {
      // #95 decided the whole rule, not the confirmed subset of it: a non-human
      // **never** retires an accepted object by superseding it. The gate above
      // already refused the `requires_human` types; what reaches here is the
      // `auto_accept` pair (claim, open_question) — and #96 r2's blind critic
      // found that keying this on `=== 'confirmed'` left every *unconfirmed*
      // accepted reading open. Because an agent cannot stage or accept its own
      // proposal yet, every unconfirmed accepted object it can reach was
      // accepted by a *model*, so every such retirement is foreign — a machine
      // unmaking another machine's reading, which #95 reserves to a person just
      // as it reserves unmaking a `✓`. The route that stays open is the
      // covenant's left-hand side: draft a superseding reading (`~`) and let a
      // person retire the old one. A non-human cannot draft one today (Proposer
      // has no agent variant), so this is a hard refusal until it can — which is
      // the honest current state, not a narrowing of the rule.
      //
      // The message still distinguishes the two: retiring a person's `✓` and
      // retiring a machine's `~` are refused for the same reason but are not the
      // same act, and a room reads which one it attempted.
      const confirmed = epistemicStateOf(target) === 'confirmed';
      fail(
        state,
        event.id,
        humanOnlyRefusal(
          confirmed ? 'confirmed_supersession' : 'unconfirmed_supersession',
          actor,
          `relation "${relation.id}"`,
          retired,
        ),
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
