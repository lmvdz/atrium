import { z } from 'zod';
import { MODEL_ACCEPTANCE_FLOOR } from './authority.js';
import type { Actor, Id, Timestamp } from './common.js';
import {
  contentTokens,
  type ProvenanceMessage,
  type ProvenanceProblem,
  rejectingProblems,
  validateProposalProvenance,
} from './escalation.js';
import type { CoreEvent } from './events.js';
import { AcceptedObjectType, type ClaimPayload, type DecisionPayload } from './objects.js';
import type { Proposal, StoredProposal } from './proposal.js';
import type { CoreState } from './state.js';

/**
 * The acceptance engine — #4's matrix, entire.
 *
 * The reducer already holds the *floor* of this matrix (`authority.ts`): the
 * rows that are trust boundaries rather than policy, enforced where nothing can
 * route around them. This file holds the policy, and it is strictly stricter:
 * it decides what a worker should emit at all, given inputs the reducer does
 * not have — the messages a reading was drawn from, who wrote them, what the
 * room has already accepted.
 *
 * The two must never invert, so `AcceptanceConfig` refuses to be configured
 * below the reducer's floor. A config that could go under it would produce
 * events the reducer refuses, which is a room where acceptance silently stops
 * working and the only symptom is a growing `issues` list.
 *
 * Everything here is pure. No clock: `answerBinding` takes its timestamp. No id
 * generation: it takes its ids. That is what makes an acceptance decision
 * reproducible from the log months later, which is the property the whole
 * correction story rests on.
 */

/* ─────────────────────────────────────────────────────────────────────────
 * Configuration
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * One type's rule.
 *
 * θ_auto is the **confident** line, and `autoAccept` says what crossing it
 * buys. For four types it buys acceptance. For a decision it buys a place in
 * Needs-you and nothing else, because a decision cannot be auto-accepted at any
 * confidence (#4: "inference is banned at exactly this point").
 *
 * Encoding that as `thetaAuto: 1.01` instead would have been shorter and wrong
 * twice over: it would make the rule look tunable, and it would collapse "the
 * pass is sure about this decision" into "the pass is unsure about this
 * decision", which are the two cells #4 and #6 disagree about. Keeping the
 * threshold real and the permission separate is what lets a confident decision
 * proposal reach a person while an uncertain one stays quiet.
 */
export const AcceptanceRule = z.object({
  /** At or above this, the pass is "confident". */
  thetaAuto: z.number().min(0).max(1),
  /** Below this, the reading is discarded, not shown. */
  thetaMin: z.number().min(0).max(1),
  /** Whether crossing θ_auto may accept, rather than only surface. */
  autoAccept: z.boolean(),
});
export type AcceptanceRule = z.infer<typeof AcceptanceRule>;

/**
 * #4's thresholds, per type.
 *
 * The shape of the table is #4's argument, restated: acceptance thresholds
 * follow the **cost of being wrong**, not the model's confidence in being
 * right.
 *
 *  - **Claim** — "X said Y" with its truth carried separately in `verification`.
 *    Cheap to correct, so recall wins. θ_auto is low.
 *  - **OpenQuestion** — a spurious one is one click to dismiss and a missed one
 *    is a question nobody ever revisits. The cost asymmetry is the strongest
 *    here, so this is the lowest bar in the table.
 *  - **Commitment** — an obligation with a name on it. Higher bar, and the
 *    self/third-party split below matters more than the number.
 *  - **Objective** — a grouping noun; a wrong one mis-files things quietly,
 *    which is worse than a wrong claim because nobody notices.
 *  - **Decision** — never, at any confidence.
 *
 * θ_min is the discard line. Below it the reading is not shown at all, because
 * a `~` a person has to evaluate is not free: the product's scarcest resource
 * is the attention of the people in the room.
 */
export const DEFAULT_ACCEPTANCE_RULES: Readonly<Record<AcceptedObjectType, AcceptanceRule>> =
  Object.freeze({
    decision: Object.freeze({ thetaAuto: 0.7, thetaMin: 0.5, autoAccept: false }),
    commitment: Object.freeze({ thetaAuto: 0.75, thetaMin: 0.5, autoAccept: true }),
    open_question: Object.freeze({ thetaAuto: 0.6, thetaMin: 0.4, autoAccept: true }),
    claim: Object.freeze({ thetaAuto: 0.7, thetaMin: 0.5, autoAccept: true }),
    objective: Object.freeze({ thetaAuto: 0.75, thetaMin: 0.5, autoAccept: true }),
  });

/**
 * The whole config, with the three invariants that keep it coherent checked at
 * parse time rather than discovered in a room:
 *
 *  1. `thetaMin ≤ thetaAuto` — otherwise the pending band is inverted and a
 *     reading can be simultaneously too weak to show and strong enough to
 *     accept.
 *  2. `thetaAuto ≥ MODEL_ACCEPTANCE_FLOOR[type]` for any type that auto-accepts
 *     — the engine may be stricter than the reducer's floor and may never be
 *     looser, or it emits events the reducer refuses.
 *  3. `decision.autoAccept === false` — #4's one absolute, and the one a
 *     well-meaning config change would otherwise flip.
 */
export const AcceptanceConfig = z
  .record(AcceptedObjectType, AcceptanceRule)
  .superRefine((rules, ctx) => {
    for (const type of AcceptedObjectType.options) {
      const rule = rules[type];
      if (!rule) {
        ctx.addIssue({
          code: 'custom',
          path: [type],
          message: `acceptance config is missing a rule for "${type}" — the table must be total over the five object types`,
        });
        continue;
      }
      if (rule.thetaMin > rule.thetaAuto) {
        ctx.addIssue({
          code: 'custom',
          path: [type, 'thetaMin'],
          message: `θ_min (${rule.thetaMin}) is above θ_auto (${rule.thetaAuto}) for "${type}" — the pending band would be inverted`,
        });
      }
      if (type === 'decision' && rule.autoAccept) {
        ctx.addIssue({
          code: 'custom',
          path: [type, 'autoAccept'],
          message:
            'a decision may never auto-accept at any confidence (#4) — accepted only by a human, or by answer-binding',
        });
      }
      const floor = MODEL_ACCEPTANCE_FLOOR[type];
      if (rule.autoAccept && Number.isFinite(floor) && rule.thetaAuto < floor) {
        ctx.addIssue({
          code: 'custom',
          path: [type, 'thetaAuto'],
          message: `θ_auto (${rule.thetaAuto}) for "${type}" is below the reducer's acceptance floor (${floor}) — the engine may be stricter than the floor, never looser, or it emits acceptances the reducer refuses`,
        });
      }
    }
  });
export type AcceptanceConfig = Record<AcceptedObjectType, AcceptanceRule>;

/** The default table, parsed — so the defaults are held to their own invariants. */
export const defaultAcceptanceConfig: AcceptanceConfig = AcceptanceConfig.parse(
  DEFAULT_ACCEPTANCE_RULES,
) as AcceptanceConfig;

/** Merge per-type overrides onto the defaults and re-check the invariants. */
export function resolveAcceptanceConfig(
  overrides: Partial<Record<AcceptedObjectType, Partial<AcceptanceRule>>> = {},
): AcceptanceConfig {
  const merged: Record<string, AcceptanceRule> = {};
  for (const type of AcceptedObjectType.options) {
    merged[type] = { ...DEFAULT_ACCEPTANCE_RULES[type], ...(overrides[type] ?? {}) };
  }
  return AcceptanceConfig.parse(merged) as AcceptanceConfig;
}

/* ─────────────────────────────────────────────────────────────────────────
 * The decision
 * ───────────────────────────────────────────────────────────────────────── */

/** Who a commitment's sentence came from. */
export type CommitmentAttribution =
  /** The owner wrote one of the cited messages — "I'll finish it tomorrow". */
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
  | 'provenance_failed'
  | 'duplicate_of_accepted'
  | 'below_theta_min'
  | 'theta_band'
  | 'auto_accept'
  | 'decision_never_auto'
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
   * The window's messages. Supplying them turns on two checks that cannot be
   * done without them: commitment attribution (did the owner write any of
   * this?) and provenance validation.
   */
  messages?: readonly ProvenanceMessage[];
  /** Pre-computed provenance problems; derived from `messages` when absent. */
  provenanceProblems?: readonly ProvenanceProblem[];
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

/** The text field of a payload, whichever the type calls it. */
export function payloadText(type: AcceptedObjectType, payload: Record<string, unknown>): string {
  const key = type === 'open_question' ? 'question' : type === 'objective' ? 'title' : 'statement';
  const value = payload[key];
  return typeof value === 'string' ? value : '';
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
 * Did the owner of this commitment write any of the messages it was read out of?
 *
 * When the messages are not supplied the answer is `third_party`, deliberately.
 * #4's rule is "nobody gets committed by someone else's sentence", and the only
 * way to honour it without evidence is to ask the named person. An unproven
 * self-statement is a third-party statement.
 */
export function commitmentAttribution(
  owner: Id,
  citedMessageIds: readonly Id[],
  messages: readonly ProvenanceMessage[] | undefined,
): CommitmentAttribution {
  if (!messages || messages.length === 0) return 'third_party';
  const cited = new Set(citedMessageIds);
  for (const message of messages) {
    if (cited.has(message.id) && message.authorId === owner) return 'self';
  }
  return 'third_party';
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
  threshold = 0.8,
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
  context: AcceptanceContext = {},
): AcceptanceDecision {
  const config = context.config ?? defaultAcceptanceConfig;
  const rule = config[proposal.type];
  const payload = proposal.payload as unknown as Record<string, unknown>;
  const text = payloadText(proposal.type, payload);
  const attributedTo = payloadAttributedTo(proposal.type, payload);

  const base = {
    thetaAuto: rule.thetaAuto,
    thetaMin: rule.thetaMin,
    autoAcceptAvailable: rule.autoAccept,
    attribution: null,
    duplicateOf: null,
    awaitingConfirmFrom: null,
  } as const;

  // ── The receipt, before anything else ────────────────────────────────────
  //
  // A reading whose citation is wrong is worse than no reading: the citation is
  // what a person clicks to check it, and a wrong one survives casual review.
  // The spike's worst output — a claim at 0.98 confidence attributed to a man
  // who never said it — fails here and nowhere else.
  //
  // Only `reject`-severity problems discard. A `reclassify` one — an owner who
  // wrote none of the cited messages — is not a defect in the reading, it *is*
  // the third-party commitment case, and it routes below rather than dying here.
  const problems =
    context.provenanceProblems ??
    (context.messages
      ? validateProposalProvenance(
          {
            type: proposal.type,
            provenance: proposal.provenance,
            quote: proposal.quote,
            proposer: proposal.proposer,
            attributedTo,
          },
          context.messages,
        )
      : []);
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
    return {
      ...base,
      verdict: 'pending',
      visibility: 'needs_you',
      rule: 'human_proposer',
      reason: `staged by user "${proposal.proposer.userId}" — a person's reading goes to the room to be accepted, not through θ`,
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
      ? commitmentAttribution(attributedTo ?? '', proposal.provenance, context.messages)
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
      rule: 'decision_never_auto',
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
      reason: `"${attributedTo}" is named as owner but wrote none of the cited messages — surfaced to them to confirm, and accepted only on that confirm; nobody gets committed by someone else's sentence (#4)`,
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
 * Supersession
 * ───────────────────────────────────────────────────────────────────────── */

export type SupersessionAuthority =
  /** A model may land it. */
  | 'auto_accept'
  /** A person must. */
  | 'requires_human';

export interface SupersessionDecision {
  authority: SupersessionAuthority;
  reason: string;
}

/**
 * #4's supersession split, by what is being retired.
 *
 * "Auto-accept when it retires a claim or a question; requires human accept when
 * it retires an accepted Decision." The other two types are not in #4's sentence
 * and default to `requires_human`, which is the conservative reading and the
 * only one that is safe to be wrong about: a commitment is an obligation with a
 * name on it and an objective is what everything else is filed under. Retiring
 * either quietly is a change nobody sees.
 *
 * The reducer enforces only the decision row (`authority.ts`) — it is the trust
 * boundary. This is the policy over it, and it is stricter by two rows.
 */
export function decideSupersession(retiredType: AcceptedObjectType): SupersessionDecision {
  switch (retiredType) {
    case 'claim':
      return {
        authority: 'auto_accept',
        reason:
          'retiring a claim is a newer reading replacing an older one, and cheap to correct (#4)',
      };
    case 'open_question':
      return {
        authority: 'auto_accept',
        reason:
          'retiring an open question is cheap to correct, and a stale question costs recall (#4)',
      };
    case 'decision':
      return {
        authority: 'requires_human',
        reason:
          'retiring an accepted decision needs the same human hand that accepting one needed (#4) — otherwise the decision gate is a front door with the back door open',
      };
    case 'commitment':
      return {
        authority: 'requires_human',
        reason:
          "a commitment is an obligation with a name on it — #4 does not put it in the auto-accept row, and dropping someone's obligation quietly is not a cheap correction",
      };
    case 'objective':
      return {
        authority: 'requires_human',
        reason:
          'an objective is what everything else is filed under — #4 does not put it in the auto-accept row, and retiring one silently re-files the room',
      };
    default: {
      const exhaustive: never = retiredType;
      return { authority: 'requires_human', reason: `unknown type ${JSON.stringify(exhaustive)}` };
    }
  }
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
 * It is a **command**, not an interpretation: this function turns the command
 * into the two events the reducer will fold, and both the object id and the
 * event ids come from the caller. No clock, no uuid, no randomness — hand it the
 * same command twice and you get byte-identical events, which is what makes the
 * whole path replayable.
 */
export interface AnswerBindingCommand {
  /** Event timestamp; also the objects' created/updated time. */
  at: Timestamp;
  /** Must be a human — the reducer refuses a proposal-less acceptance otherwise. */
  actor: Actor;
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
 */
export function answerBindingRefusal(
  state: CoreState,
  command: AnswerBindingCommand,
): string | null {
  if (command.actor.kind !== 'human') {
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
  if (record.object.roomId !== command.roomId) {
    return `open question "${command.questionObjectId}" is in room "${record.object.roomId}", not "${command.roomId}"`;
  }
  if (state.objects[command.answer.objectId]) {
    return `object "${command.answer.objectId}" already exists`;
  }
  return null;
}

/**
 * The events an answer-binding produces: accept the answer, then point the
 * question at it. The `answers` edge is what flips the question to `answered`,
 * so the ordering is load-bearing and the timestamps reflect it.
 */
export function answerBindingEvents(command: AnswerBindingCommand): CoreEvent[] {
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

  return [
    {
      id: command.ids.acceptEventId,
      at: command.at,
      actor: command.actor,
      type: 'object_accepted',
      object,
    },
    {
      id: command.ids.relationEventId,
      at: command.at,
      actor: command.actor,
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
}

/** Refusal or events, in one call. */
export function bindAnswer(
  state: CoreState,
  command: AnswerBindingCommand,
): { ok: true; events: CoreEvent[] } | { ok: false; refusal: string } {
  const refusal = answerBindingRefusal(state, command);
  if (refusal !== null) return { ok: false, refusal };
  return { ok: true, events: answerBindingEvents(command) };
}
