import type { Actor, Id, Timestamp } from './common.js';
import {
  bearingMessage,
  contentTokens,
  type ProvenanceMessage,
  type ProvenanceProblem,
  rejectingProblems,
  validateProposalProvenance,
} from './escalation.js';
import { type AuthoredEvent, authored, type CoreEvent, trustedContext } from './events.js';
import {
  type AcceptedObjectType,
  type ClaimPayload,
  type DecisionPayload,
  payloadText,
} from './objects.js';
import { type AcceptanceConfig, defaultAcceptanceConfig, RECEIPT_POLICY } from './policy.js';
import type { Proposal, StoredProposal } from './proposal.js';
import { appendEvent, compareCursor } from './reduce.js';
import type { CoreState } from './state.js';

/**
 * The acceptance engine — #4's matrix, entire.
 *
 * The reducer holds the *floor* of this matrix (`authority.ts`): the rows that
 * are trust boundaries, enforced where nothing can route around them. This file
 * decides what a worker should emit at all, given inputs the reducer applies
 * more narrowly — the messages a reading was drawn from, who wrote them, what
 * the room has already accepted.
 *
 * The two read one θ table (`policy.ts`), so they cannot disagree about whether
 * a reading is strong enough, and `AcceptanceConfig` refuses to be configured
 * below the floor, so the engine can only ever be the stricter of the two.
 *
 * **The receipt is not optional, and an empty one is not a receipt.** In round 1
 * `messages` was an optional field whose absence produced an empty problem set,
 * so the caller that forgot it got auto-acceptance instead of a refusal — the
 * exact fail-open shape a trust boundary must not have. Round 2 made it required
 * and round 2's gauntlet walked through the door that was left: `messages: []`
 * satisfies "required" and satisfies nothing else. A model proposal judged with
 * no window *or an empty one* is discarded with `missing_message_context`.
 *
 * Everything here is pure. No clock: `answerBinding` takes its timestamp. No id
 * generation: it takes its ids. That is what makes an acceptance decision
 * reproducible from the log months later, which is the property the whole
 * correction story rests on.
 */

/* ─────────────────────────────────────────────────────────────────────────
 * The decision
 * ───────────────────────────────────────────────────────────────────────── */

/** Who a commitment's sentence came from. */
export type CommitmentAttribution =
  /** The owner wrote the message bearing it — "I'll finish it tomorrow". */
  | 'self'
  /** Somebody else did — "Justin will handle it". Nobody gets committed by it. */
  | 'third_party';

export type AcceptanceVerdict =
  /** Accept it now, as `~`. */
  | 'auto_accept'
  /** Keep it staged. `visibility` says where it shows. */
  | 'pending'
  /** Drop it. Never shown, never stored as a live proposal. */
  | 'discard';

export type AcceptanceVisibility =
  /** It became an object; nothing is pending. */
  | 'accepted'
  /** Current state, marked unconfirmed. Never in Needs-you. */
  | 'quiet'
  /** Needs-you: somebody has to act on it. */
  | 'needs_you'
  /** Nowhere. */
  | 'none';

/** Which cell of the matrix fired. One name per cell, so tests can pin them. */
export type AcceptanceRuleName =
  | 'missing_message_context'
  | 'provenance_failed'
  | 'duplicate_of_accepted'
  | 'below_theta_min'
  | 'theta_band'
  | 'auto_accept'
  /**
   * At or above θ_auto, for a type that never auto-accepts at any confidence.
   * Named for the *rule* rather than for the decision: it was
   * `decision_never_auto`, which misnamed every non-decision that reached it —
   * the table is data, and a fifth type could join the row tomorrow.
   */
  | 'never_auto_accepts'
  | 'third_party_commitment'
  | 'human_proposer';

export interface AcceptanceDecision {
  verdict: AcceptanceVerdict;
  visibility: AcceptanceVisibility;
  /** The named owner who must confirm, for a third-party commitment. */
  awaitingConfirmFrom: Id | null;
  /** The matrix cell. */
  rule: AcceptanceRuleName;
  /** Why, in words a room could be shown. */
  reason: string;
  /** The confident line for this type. */
  thetaAuto: number;
  /** Whether crossing it may accept, or only surface. */
  autoAcceptAvailable: boolean;
  thetaMin: number;
  /** Only set for commitments. */
  attribution: CommitmentAttribution | null;
  /** The accepted object this duplicates, when that is why it was discarded. */
  duplicateOf: Id | null;
}

/** An already-accepted object, as the deduplicator needs it. */
export interface AcceptedObjectRef {
  objectId: Id;
  type: AcceptedObjectType;
  /** `statement` / `question` / `title`, whichever the type carries. */
  text: string;
  /** The messages it was drawn from. */
  messageIds: readonly Id[];
}

export interface AcceptanceContext {
  config?: AcceptanceConfig;
  /**
   * The window's messages — **required, and non-empty**, and the reason is the
   * whole of round 1's second blocking finding. Commitment attribution and
   * provenance validation cannot be done without them, and in round 1 that meant
   * they silently were not done: no messages, no problems, auto-accept. A model
   * proposal judged with no window is discarded now.
   *
   * The type cannot say "non-empty", so the check does: `[]` is refused with the
   * same rule as `undefined`. Round 2's gauntlet found the version that only
   * asked about `undefined`, and an empty array is not a smaller window — it is
   * the same absence with a different spelling.
   *
   * A human-staged proposal does not go through θ at all, so it survives an
   * empty window; there is nothing to check when the person staging the reading
   * is the receipt.
   */
  messages: readonly ProvenanceMessage[];
  /**
   * What the room has already accepted, for deduplication.
   *
   * This is where dedup belongs. The spike tested the alternative directly —
   * putting a compressed accepted-state block in the extraction prompt — and it
   * dedups well (zero re-proposed objects) at a cost of collapsing recall from
   * 19 objects to 11, losing the dispute edge and the `disputed` flag, and
   * producing no cross-window relations at all. It is a de-duplication input,
   * not a comprehension aid. Doing it here costs nothing and is testable
   * without a model.
   */
  acceptedObjects?: readonly AcceptedObjectRef[];
  /** Fraction of content words two texts must share to be the same thing. */
  duplicateThreshold?: number;
}

/** The person a payload puts on the hook, if any. */
export function payloadAttributedTo(
  type: AcceptedObjectType,
  payload: Record<string, unknown>,
): Id | null {
  const key = type === 'claim' ? 'claimant' : type === 'commitment' ? 'owner' : null;
  if (key === null) return null;
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Did the owner of this commitment write the message it was read out of?
 *
 * **The message bearing the sentence, not any cited message.** Round 1's
 * gauntlet: an owner who authored *any* cited message counted as a
 * self-statement, so padding `provenance` with one unrelated message the owner
 * happened to write turned "Justin will handle it" into "Justin said he would
 * handle it" and auto-accepted an obligation nobody agreed to. The quote names
 * the bearing message; its author is the only authorship that answers the
 * question.
 *
 * With no quote, or no window, the answer is `third_party`, deliberately. #4's
 * rule is "nobody gets committed by someone else's sentence", and the only way
 * to honour it without evidence is to ask the named person. An unproven
 * self-statement is a third-party statement.
 */
export function commitmentAttribution(
  owner: Id,
  citedMessageIds: readonly Id[],
  messages: readonly ProvenanceMessage[] | undefined,
  quote: string | null | undefined,
): CommitmentAttribution {
  if (!messages || messages.length === 0) return 'third_party';
  if (!quote || quote.trim().length === 0) return 'third_party';
  const cited = new Set(citedMessageIds);
  const citedMessages = messages.filter((message) => cited.has(message.id));
  const bearing = bearingMessage(quote, citedMessages);
  return bearing !== null && bearing.authorId === owner ? 'self' : 'third_party';
}

/**
 * Is this reading something the room already accepted?
 *
 * Statement similarity **and** provenance overlap, both required. Either alone
 * is a bad matcher: two different decisions drawn from one message share
 * provenance completely, and two unrelated claims about the same subsystem
 * share most of their content words. Requiring both is what makes the matcher
 * safe enough to *discard* on.
 */
export function findDuplicate(
  type: AcceptedObjectType,
  text: string,
  messageIds: readonly Id[],
  accepted: readonly AcceptedObjectRef[],
  threshold = RECEIPT_POLICY.duplicateThreshold,
): AcceptedObjectRef | null {
  const wanted = contentTokens(text);
  if (wanted.size === 0) return null;
  const cited = new Set(messageIds);
  for (const candidate of accepted) {
    if (candidate.type !== type) continue;
    if (!candidate.messageIds.some((id) => cited.has(id))) continue;
    const have = contentTokens(candidate.text);
    if (have.size === 0) continue;
    let shared = 0;
    for (const token of wanted) if (have.has(token)) shared += 1;
    // Symmetric: neither "the new one restates the old" nor the reverse alone.
    const similarity = shared / Math.max(wanted.size, have.size);
    if (similarity >= threshold) return candidate;
  }
  return null;
}

/**
 * #4's matrix, applied to one staged reading.
 *
 * The table this implements, exactly — one row per cell, and
 * `acceptance.test.ts` has one test per row:
 *
 * | type                     | c < θ_min | θ_min ≤ c < θ_auto | c ≥ θ_auto            |
 * | ------------------------ | --------- | ------------------ | --------------------- |
 * | claim                    | discard   | pending, quiet     | auto-accept           |
 * | open_question            | discard   | pending, quiet     | auto-accept           |
 * | objective                | discard   | pending, quiet     | auto-accept           |
 * | commitment, self-stated  | discard   | pending, quiet     | auto-accept           |
 * | commitment, third-party  | discard   | pending, quiet     | pending, owner confirm|
 * | decision                 | discard   | pending, quiet     | pending, Needs-you    |
 *
 * …with one cell in front of all of them: **no window, no verdict**. A model
 * proposal judged without the messages it cites is discarded, because the
 * alternative — an empty problem set read as a clean receipt — is how a wrong
 * citation becomes an accepted fact.
 *
 * Two cells are worth defending.
 *
 * **Decision at c ≥ θ_auto is Needs-you, not quiet.** #4 says a pending
 * proposal shows quietly "never in Needs-you unless it blocks something", and #6
 * says `needs_decision` is "a decision proposal awaiting you". Both are right,
 * and the θ band is where they meet: a decision the pass is unsure about shows
 * quietly, and one it is confident about is exactly the thing a person should be
 * asked to confirm. A confident decision proposal *does* block something — the
 * room's current state is wrong until somebody rules on it.
 *
 * **Third-party commitment never auto-accepts, at any confidence.** Not a
 * threshold: a rule. The spike could not test it (one commitment in six runs,
 * self-attributed, on a public RFC thread where nobody says "Ryan will handle
 * it"), so it is implemented from #4's text and is the part of this file most
 * in need of the working-team corpus #24 asks for.
 */
export function decideAcceptance(
  proposal: Proposal | StoredProposal,
  context: AcceptanceContext,
): AcceptanceDecision {
  const config = context.config ?? defaultAcceptanceConfig;
  const rule = config[proposal.type];
  const payload = proposal.payload as unknown as Record<string, unknown>;
  const text = payloadText(proposal.type, payload);
  const attributedTo = payloadAttributedTo(proposal.type, payload);
  const messages = context.messages as readonly ProvenanceMessage[] | undefined;

  const base = {
    thetaAuto: rule.thetaAuto,
    thetaMin: rule.thetaMin,
    autoAcceptAvailable: rule.autoAccept,
    attribution: null,
    duplicateOf: null,
    awaitingConfirmFrom: null,
  } as const;

  // ── No window, no verdict ────────────────────────────────────────────────
  //
  // Fail-closed, and loudly: this is a caller bug, not a reading defect. The
  // failure it replaces was silent in the other direction.
  //
  // **Empty counts as absent.** Round 2's gauntlet found the `undefined`-only
  // form of this check: `messages: []` walked past the door marked "required",
  // and everything downstream then found nothing wrong because there was nothing
  // to look in. The two spellings describe the same state of the world — nobody
  // supplied the messages this reading cites — so they get the same answer.
  if (proposal.proposer.kind === 'model' && (messages === undefined || messages.length === 0)) {
    return {
      ...base,
      verdict: 'discard',
      visibility: 'none',
      rule: 'missing_message_context',
      reason:
        messages === undefined
          ? 'no message window was supplied, so the receipt could not be checked — a model reading is never accepted on trust; supply the messages it cites'
          : 'an empty message window was supplied, so the receipt could not be checked — an empty window is not a window; a model reading is never accepted on trust',
    };
  }

  // ── The receipt, before anything else ────────────────────────────────────
  //
  // A reading whose citation is wrong is worse than no reading: the citation is
  // what a person clicks to check it, and a wrong one survives casual review.
  // The spike's worst output — a claim at 0.98 confidence attributed to a man
  // who never said it — fails here and nowhere else.
  //
  // Only `reject`-severity problems discard. A `reclassify` one — an owner who
  // did not write the message bearing the sentence — is not a defect in the
  // reading, it *is* the third-party commitment case, and it routes below
  // rather than dying here.
  const problems: readonly ProvenanceProblem[] =
    messages && messages.length > 0
      ? validateProposalProvenance(
          {
            type: proposal.type,
            provenance: proposal.provenance,
            quote: proposal.quote,
            proposer: proposal.proposer,
            attributedTo,
            // The sentence being staged. Without it the quote can be verbatim,
            // correctly attributed, and about something else entirely — r2's
            // gauntlet, major 1.
            statement: text,
          },
          messages,
        )
      : [];
  const rejecting = rejectingProblems(problems);
  if (rejecting.length > 0) {
    return {
      ...base,
      verdict: 'discard',
      visibility: 'none',
      rule: 'provenance_failed',
      reason: `demoted below θ_min: ${rejecting.map((problem) => problem.detail).join('; ')}`,
    };
  }

  // ── Already in the room ──────────────────────────────────────────────────
  const duplicate = context.acceptedObjects
    ? findDuplicate(
        proposal.type,
        text,
        proposal.provenance,
        context.acceptedObjects,
        context.duplicateThreshold,
      )
    : null;
  if (duplicate) {
    return {
      ...base,
      verdict: 'discard',
      visibility: 'none',
      rule: 'duplicate_of_accepted',
      duplicateOf: duplicate.objectId,
      reason: `the room already accepted "${duplicate.objectId}" from the same messages, saying the same thing`,
    };
  }

  // ── A person staged this ─────────────────────────────────────────────────
  //
  // θ does not apply. #4's thresholds calibrate *extraction* confidence, and a
  // person's self-report is not that number — it is not a number at all. A
  // human-staged reading goes to the room to be judged, which is what staging
  // means. (A person writing a fact outright uses `answerBinding` or direct
  // acceptance; they do not need a proposal.)
  if (proposal.proposer.kind === 'human') {
    // …with one exception that is not about θ at all: a person naming *somebody
    // else* on a commitment is still somebody else's sentence, and #4's rule
    // does not care whether a machine or a colleague wrote it. The named owner
    // is the one asked, and that is what the attention panel reads to decide
    // whose confirm this is.
    const staged = proposal.proposer.userId;
    const namesAnother =
      proposal.type === 'commitment' && attributedTo !== null && attributedTo !== staged;
    return {
      ...base,
      verdict: 'pending',
      visibility: 'needs_you',
      attribution: proposal.type === 'commitment' ? (namesAnother ? 'third_party' : 'self') : null,
      awaitingConfirmFrom: namesAnother ? attributedTo : null,
      rule: 'human_proposer',
      reason: namesAnother
        ? `staged by user "${staged}", who named "${attributedTo}" as owner — it waits for "${attributedTo}" to confirm; nobody gets committed by someone else's sentence (#4), whoever wrote it`
        : `staged by user "${staged}" — a person's reading goes to the room to be accepted, not through θ`,
    };
  }

  // ── Below the discard line ───────────────────────────────────────────────
  if (proposal.confidence < rule.thetaMin) {
    return {
      ...base,
      verdict: 'discard',
      visibility: 'none',
      rule: 'below_theta_min',
      reason: `confidence ${proposal.confidence} is below θ_min ${rule.thetaMin} for ${proposal.type} — discarded rather than shown; an unconvincing "~" still costs someone's attention`,
    };
  }

  const attribution =
    proposal.type === 'commitment'
      ? commitmentAttribution(attributedTo ?? '', proposal.provenance, messages, proposal.quote)
      : null;

  // ── The band: θ_min ≤ c < θ_auto ─────────────────────────────────────────
  //
  // One cell for every type, decisions included. Shown quietly in current state
  // as unconfirmed, never in Needs-you — #4, and the reasoning is that an
  // uncertain reading is not worth a person's turn, only their glance.
  if (proposal.confidence < rule.thetaAuto) {
    return {
      ...base,
      attribution,
      verdict: 'pending',
      visibility: 'quiet',
      rule: 'theta_band',
      reason: `confidence ${proposal.confidence} is between θ_min ${rule.thetaMin} and θ_auto ${rule.thetaAuto} for ${proposal.type} — shown quietly in current state as unconfirmed, never in Needs-you unless it blocks something`,
    };
  }

  // ── At or above θ_auto, but this type never auto-accepts ─────────────────
  if (!rule.autoAccept) {
    return {
      ...base,
      attribution,
      verdict: 'pending',
      visibility: 'needs_you',
      rule: 'never_auto_accepts',
      reason: `a ${proposal.type} never auto-accepts at any confidence (#4) — at ${proposal.confidence} the pass is confident, so it goes to Needs-you for a person to accept or decline; the room's current state is unsettled until somebody rules on it`,
    };
  }

  // ── At or above θ_auto ───────────────────────────────────────────────────
  if (proposal.type === 'commitment' && attribution === 'third_party') {
    return {
      ...base,
      attribution,
      verdict: 'pending',
      visibility: 'needs_you',
      awaitingConfirmFrom: attributedTo,
      rule: 'third_party_commitment',
      reason: `"${attributedTo}" is named as owner but did not write the message this was read out of — surfaced to them to confirm, and accepted only on that confirm; nobody gets committed by someone else's sentence (#4)`,
    };
  }

  return {
    ...base,
    attribution,
    verdict: 'auto_accept',
    visibility: 'accepted',
    rule: 'auto_accept',
    reason: `confidence ${proposal.confidence} is at or above θ_auto ${rule.thetaAuto} for ${proposal.type} — accepted as "~"; nothing model-accepted renders as a fact`,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Answer-binding
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * "Your next message resolves it, nothing is inferred."
 *
 * The one path that reaches an accepted Decision without a model in it. A person
 * clicks an open question, writes a reply, and that reply *is* the answer — no
 * proposal is staged, no confidence is computed, nothing is extracted. #4 names
 * this as one of exactly two ways a decision is ever accepted.
 *
 * It is a **command**, not an interpretation: this turns the command into the
 * two events the reducer will fold, and both the object id and the event ids
 * come from the caller. No clock, no uuid, no randomness — hand it the same
 * command twice and you get byte-identical events, which is what makes the whole
 * path replayable.
 *
 * **The actor is not in here.** It is the same trusted argument the reducer
 * takes, for the same reason: a command that carried its own actor would be a
 * self-declared human, and this is the one path that mints an accepted decision.
 */
export interface AnswerBindingCommand {
  /** Event timestamp; also the objects' created/updated time. */
  at: Timestamp;
  roomId: Id;
  /** The open question being answered. */
  questionObjectId: Id;
  /** What the answer is. A decision or a claim — those are what `answers` targets. */
  answer:
    | { type: 'decision'; objectId: Id; payload: DecisionPayload }
    | { type: 'claim'; objectId: Id; payload: ClaimPayload };
  /** The message that carried the answer, and any others it rests on. */
  messageIds: readonly Id[];
  /** Caller-supplied ids: purity is the point. */
  ids: { acceptEventId: Id; relationEventId: Id; relationId: Id };
  /** Carried onto the created object. */
  objectiveId?: Id | null;
}

/**
 * Why this binding cannot be performed against this state, or `null`.
 *
 * Checked here so a caller can refuse before minting events, and checked again
 * by the reducer because a check that only runs upstream is not a check.
 *
 * The ordering rule is the one worth explaining. The two events share a
 * timestamp, so the canonical `(at, id)` order breaks the tie on the *ids the
 * caller chose* — and if the relation sorts first it arrives before the object
 * it points at, fails on an unknown target, and the question stays open with the
 * answer accepted next to it. Round 1's gauntlet found it; the fix is to refuse
 * the command rather than to hope, because ids are the caller's to pick and the
 * caller can pick again.
 */
export function answerBindingRefusal(
  state: CoreState,
  command: AnswerBindingCommand,
  actor: Actor,
): string | null {
  if (actor.kind !== 'human') {
    return 'answer-binding is a person answering a question — only a human may bind an answer, and a model must go through a proposal';
  }
  const record = state.objects[command.questionObjectId];
  if (!record) return `unknown open question "${command.questionObjectId}"`;
  if (record.object.type !== 'open_question') {
    return `object "${command.questionObjectId}" is a ${record.object.type}, not an open question — only a question can be answered`;
  }
  if (record.retractedAt !== null) {
    return `open question "${command.questionObjectId}" is retracted — restore it before answering`;
  }
  if (record.object.payload.status !== 'open') {
    return `open question "${command.questionObjectId}" is already answered — reopen it before binding a different answer, so the room can see that it was settled twice`;
  }
  if (record.object.roomId !== command.roomId) {
    return `open question "${command.questionObjectId}" is in room "${record.object.roomId}", not "${command.roomId}"`;
  }
  if (state.objects[command.answer.objectId]) {
    return `object "${command.answer.objectId}" already exists`;
  }
  const { acceptEventId, relationEventId } = command.ids;
  if (
    compareCursor({ at: command.at, id: acceptEventId }, { at: command.at, id: relationEventId }) >=
    0
  ) {
    return `answer-binding event ids are out of order: the acceptance "${acceptEventId}" must sort strictly before the relation "${relationEventId}" at ${command.at}, or the edge arrives before the object it points at and the question is left open beside its own answer — pick ids whose order matches`;
  }
  return null;
}

/**
 * The events an answer-binding produces: accept the answer, then point the
 * question at it. The `answers` edge is what flips the question to `answered`,
 * so the ordering is load-bearing and `answerBindingRefusal` enforces it.
 *
 * Each event comes back paired with the trusted actor, because that is the shape
 * the reducer folds — the caller passes the pairs straight through.
 */
export function answerBindingEvents(command: AnswerBindingCommand, actor: Actor): AuthoredEvent[] {
  const { answer } = command;
  const object = {
    id: answer.objectId,
    roomId: command.roomId,
    objectiveId: command.objectiveId ?? null,
    type: answer.type,
    payload: answer.payload,
    provenance: {
      messageIds: [...command.messageIds],
      // The whole point: no proposal. A person's word is not an interpretation
      // that needs accepting, and the reducer only lets a human do this.
      proposalId: null,
      interpretationId: null,
    },
    createdAt: command.at,
    updatedAt: command.at,
  };

  const events = [
    {
      id: command.ids.acceptEventId,
      at: command.at,
      type: 'object_accepted',
      object,
    },
    {
      id: command.ids.relationEventId,
      at: command.at,
      type: 'relation_added',
      relation: {
        id: command.ids.relationId,
        roomId: command.roomId,
        kind: 'answers',
        fromObjectId: command.questionObjectId,
        to: { kind: 'object', objectId: answer.objectId },
        note: null,
        createdAt: command.at,
      },
    },
  ] as CoreEvent[];

  return events.map((event) => authored(event, { actor }));
}

/** Refusal or events, in one call. */
export function bindAnswer(
  state: CoreState,
  command: AnswerBindingCommand,
  actor: Actor,
): { ok: true; events: AuthoredEvent[] } | { ok: false; refusal: string } {
  const refusal = answerBindingRefusal(state, command, actor);
  if (refusal !== null) return { ok: false, refusal };
  return { ok: true, events: answerBindingEvents(command, actor) };
}

/**
 * Bind an answer **as one command**: either both events land, or the state comes
 * back untouched.
 *
 * `bindAnswer` mints the pair and leaves applying them to the caller, which is
 * right for a command layer that has to persist them. But a caller that folds
 * them one at a time can land the acceptance, have the relation refused, and
 * leave the room with an answer nobody asked and a question nobody answered —
 * two events, one meaning, no transaction. So the atomic form exists, and it is
 * the one to reach for by default.
 *
 * Nothing is mutated: on refusal the *same state object* comes back, exactly as
 * `appendEvent` does for a rejection.
 */
export function applyAnswerBinding(
  state: CoreState,
  command: AnswerBindingCommand,
  actor: Actor,
):
  | { ok: true; state: CoreState; events: AuthoredEvent[] }
  | { ok: false; state: CoreState; refusal: string } {
  const bound = bindAnswer(state, command, actor);
  if (!bound.ok) return { ok: false, state, refusal: bound.refusal };

  let next = state;
  for (const entry of bound.events) {
    const result = appendEvent(next, entry.event, trustedContext({ actor: entry.actor }));
    if (result.outcome !== 'applied') {
      const why =
        result.outcome === 'rejected' || result.outcome === 'malformed'
          ? result.detail
          : result.issues.map((issue) => issue.reason).join('; ');
      return {
        ok: false,
        state,
        refusal: `answer-binding "${command.ids.acceptEventId}" was rolled back: event "${entry.event.id}" ${result.outcome} — ${why}`,
      };
    }
    next = result.state;
  }
  return { ok: true, state: next, events: bound.events };
}
