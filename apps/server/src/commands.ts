import { createHash, randomUUID } from 'node:crypto';
import { advanceSeenSeq, roomMemberIds } from '@atrium/auth';
import {
  type AcceptedObject,
  AcceptedObjectType,
  type Actor,
  AttentionClass,
  ClaimPayload,
  CommitmentPayload,
  CorrectionAction,
  DecisionPayload,
  emptyProvenance,
  epistemicStateOf,
  Id,
  isHuman,
  ObjectivePayload,
  OpenQuestionPayload,
  type Proposal,
  Provenance,
  parseSemanticCommand,
  RationaleReason,
  type Relation,
} from '@atrium/core';
import type { Database } from '@atrium/db';
import {
  acceptedObjects,
  coreEvents,
  messages,
  objectSources,
  plans,
  proposalSources,
  proposals,
  sessions,
  users,
} from '@atrium/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { CommandError, type Ledger, type Tx } from './ledger.js';
import { type ProjectionHooks, projectRoomEvent } from './projections.js';
import {
  ExecutionArtifact,
  MessageAttachment,
  MessageReference,
  type RoomEvent,
} from './room-events.js';
import type { Authorizer, MembershipPair, Session } from './session.js';

/**
 * The command layer — #12's client→server verbs.
 *
 * Every command follows one shape, and the order of the steps is the contract:
 *
 *   1. **Membership.** Checked against the database, per command, before
 *      anything is built. Not once at connect: a socket outlives a membership.
 *   2. **Append.** The event is built at the position the ledger assigns it and
 *      folded through @atrium/core's `appendEvent` in the same transaction as
 *      the INSERT. A rejection aborts the transaction — no row, no `room_seq`,
 *      an error to the caller (#22's invariant; see `ledger.ts`). Membership is
 *      re-read **inside that transaction**, with the row locked: step 1 is a
 *      cheap early refusal, and this is the one that is actually load-bearing
 *      (r1, major 4 — a membership revoked between the two would otherwise
 *      still have written durable history).
 *   3. **Project.** The derived tables are written in that same transaction.
 *   4. **Broadcast.** Only after commit, tagged `(room, room_seq)`.
 *
 * Two commands deliberately skip steps 2–3 entirely:
 *
 *  - `set_presence` / `set_typing` are ephemeral. #14: presence churn is
 *    exactly the routine noise the compression model exists to exclude, so it
 *    is broadcast and never written. An integration test floods presence and
 *    asserts the ledger gained zero rows — the assertion, not the intention, is
 *    what keeps this true.
 *  - `advance_seen` moves a per-user read cursor. It is *not* room history: it
 *    says where one person got to, nobody else's replay depends on it, and
 *    putting it in the log would make every room's history proportional to how
 *    often people scrolled.
 *
 * `record_proposal` and `reject_proposal` are not in #12's six. They are here
 * because `accept_proposal` is otherwise unreachable — a proposal has to exist
 * before it can be accepted, and the interpretation pipeline that will mint
 * them is #21's. Nothing in them interprets anything: the caller supplies the
 * reading, the reducer still refuses to let it arrive pre-accepted.
 *
 * They are **not** the seam #21's pipeline will call. r8 said they were, and r9
 * found what that sentence cost: a participant socket that can describe its own
 * sentence as a machine's reading (see `draftBase`). A proposal staged here is
 * staged by the session's own principal — a human proposal for a person, an
 * agent proposal for an agent (#117) — never a proposer the caller chose; #21
 * will need a seam of its own, and whatever it is, `stagedBy` will record which
 * one was used.
 *
 * The proposer is derived from the session rather than taken from the wire: an
 * agent session's reading is recorded as `proposer_kind='agent'` under its own
 * user id, a machine reading held to the receipt gate exactly as a model's is.
 * Staging is participation and open to an agent; certifying is not, and stays
 * refused for every non-human by the covenant gate. See `draftToProposal`.
 */

const AttachmentList = z
  .array(MessageAttachment.extend({ capability: z.string().min(1) }))
  .max(20)
  .default([]);

function answerMessageFingerprint(input: {
  roomId: string;
  questionId: string;
  body: string;
  attachments: readonly {
    id: string;
    key: string;
    name: string;
    contentType: string;
    size: number;
  }[];
}): string {
  // Arrays make the encoding unambiguous and preserve attachment order. The
  // version is part of the hash so a future semantic change cannot silently
  // reinterpret an old retry key. Upload capabilities are intentionally absent:
  // they authorize a fresh write, but are not part of the durable meaning.
  const canonical = JSON.stringify([
    'answer_message/v2',
    input.roomId,
    input.questionId,
    input.body,
    input.attachments.map((attachment) => [
      attachment.id,
      attachment.key,
      attachment.name,
      attachment.contentType,
      attachment.size,
    ]),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function sendMessageFingerprint(input: {
  roomId: string;
  body: string;
  replyToId: string | null;
  attachments: readonly {
    id: string;
    key: string;
    name: string;
    contentType: string;
    size: number;
  }[];
  references: readonly z.infer<typeof MessageReference>[];
}): string {
  const canonical = JSON.stringify([
    'send_message/v2',
    input.roomId,
    input.body,
    input.replyToId,
    input.attachments.map((attachment) => [
      attachment.id,
      attachment.key,
      attachment.name,
      attachment.contentType,
      attachment.size,
    ]),
    input.references.map((reference) => [
      reference.ordinal,
      reference.kind,
      reference.targetId,
      reference.start,
      reference.end,
      reference.surface,
    ]),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function semanticCommandFingerprint(roomId: string, messageId: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['stage_semantic_command/v1', roomId, messageId]), 'utf8')
    .digest('hex');
}

function supersessionFingerprint(input: {
  roomId: string;
  replacementObjectId: string;
  retiredObjectId: string;
  note: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'supersede_object/v1',
        input.roomId,
        input.replacementObjectId,
        input.retiredObjectId,
        input.note,
      ]),
      'utf8',
    )
    .digest('hex');
}

/**
 * A proposal as a caller submits it: the reading, without a position or an id.
 *
 * **`proposer` is not here.** It is derived from the session in
 * `draftToProposal`, and a socket has no way to write it (#22 r9, D1). r8
 * overwrote a *human* proposer with the session user and passed a **model**
 * proposer through as written, on the grounds that this is the seam #21's
 * pipeline will call — but the pipeline does not exist and the seam is on the
 * participant socket, so the only thing that ever reached the model branch was a
 * participant typing it. That is how a member minted a commitment against a
 * colleague under `proposer_kind='model'`. Removed rather than validated, for the
 * same reason `status` is not taken from the caller: a field whose value is
 * always overridden invites someone to believe it, and there is no legitimate
 * value for a socket to send. See `draftToProposal`.
 */
const draftBase = {
  confidence: z.number().min(0).max(1),
  /** Message ids this reading was drawn from. */
  provenance: z.array(Id).default([]),
  /**
   * The verbatim span of a cited message this reading rests on.
   *
   * Optional here because a person staging their own reading quotes nobody, and
   * required by @atrium/core for a model claim or commitment — the two types
   * that put a name on somebody. #21's r3 binds attribution to the message that
   * *bears* the sentence, and the quote is the only thing that identifies it.
   * Passed straight through: the command layer neither invents one nor checks
   * one, because the check is the reducer's and duplicating it here would be a
   * second copy free to disagree.
   */
  quote: z.string().nullable().default(null),
  interpretationId: Id.nullable().default(null),
};

export const ProposalDraft = z.discriminatedUnion('type', [
  z.object({ ...draftBase, type: z.literal('decision'), payload: DecisionPayload }),
  z.object({ ...draftBase, type: z.literal('commitment'), payload: CommitmentPayload }),
  z.object({ ...draftBase, type: z.literal('open_question'), payload: OpenQuestionPayload }),
  z.object({ ...draftBase, type: z.literal('claim'), payload: ClaimPayload }),
  z.object({ ...draftBase, type: z.literal('objective'), payload: ObjectivePayload }),
]);
export type ProposalDraft = z.infer<typeof ProposalDraft>;

export const PresenceState = z.enum(['online', 'away', 'offline']);
export type PresenceState = z.infer<typeof PresenceState>;

export const Command = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('send_message'),
    roomId: Id,
    body: z.string().min(1).max(20_000),
    /** Idempotency key; also what the sender's own optimistic echo matches on. */
    clientMessageId: z.string().min(1).max(128).nullable().default(null),
    replyToId: Id.nullable().default(null),
    attachments: AttachmentList,
    references: z.array(MessageReference).max(100).default([]),
  }),
  z.object({ name: z.literal('record_proposal'), roomId: Id, proposal: ProposalDraft }),
  z.object({
    name: z.literal('stage_semantic_command'),
    roomId: Id,
    messageId: Id,
    idempotencyKey: z.string().min(1).max(128),
  }),
  z.object({
    name: z.literal('answer_message'),
    roomId: Id,
    questionId: Id,
    body: z.string().min(1).max(20_000),
    clientMessageId: z.string().min(1).max(128),
    attachments: AttachmentList,
  }),
  z.object({
    name: z.literal('accept_proposal'),
    roomId: Id,
    proposalId: Id,
    objectiveId: Id.nullable().default(null),
  }),
  z.object({
    name: z.literal('reject_proposal'),
    roomId: Id,
    proposalId: Id,
    reason: z.string().max(2000).nullable().default(null),
  }),
  z.object({
    name: z.literal('correct'),
    roomId: Id,
    objectId: Id,
    action: CorrectionAction,
    patch: z.record(z.string(), z.unknown()).default({}),
    /**
     * `retype` only: the type the object becomes (#21's resolution of #5).
     *
     * Its own field rather than a key inside `patch`, because the type is not
     * part of any payload schema — a patch key that silently means something
     * structural is how a payload edit becomes a type change by accident.
     */
    toType: AcceptedObjectType.nullable().default(null),
    /**
     * The messages that motivated the correction. #19 r1: a correction with a
     * receipt can be shown next to the thing it corrected; one without is an
     * unexplained edit, and #5's counterexample extractor has nothing to point
     * at. Attribution is the trusted actor and rides beside the payload; this is
     * the other half.
     */
    provenance: Provenance.default(emptyProvenance),
    note: z.string().max(2000).nullable().default(null),
  }),
  z.object({
    name: z.literal('answer_bind'),
    roomId: Id,
    /** The open question being answered. */
    questionId: Id,
    /** The decision or claim that answers it. */
    answerObjectId: Id,
    note: z.string().max(2000).nullable().default(null),
  }),
  z.object({
    name: z.literal('supersede_object'),
    roomId: Id,
    /** The newer accepted object that remains active. */
    replacementObjectId: Id,
    /** The older accepted object retired by the newer one. */
    retiredObjectId: Id,
    /** Stable across a lost-ack retry and scoped to this actor and room. */
    clientSupersessionId: z.string().min(1).max(128),
    note: z.string().max(2000).nullable().default(null),
  }),
  z.object({
    name: z.literal('resolve_attention'),
    roomId: Id,
    attentionId: Id,
    status: z.enum(['resolved', 'dismissed']).default('resolved'),
  }),
  z.object({ name: z.literal('set_presence'), roomId: Id, state: PresenceState }),
  z.object({ name: z.literal('set_typing'), roomId: Id, typing: z.boolean() }),
  z.object({ name: z.literal('advance_seen'), roomId: Id, roomSeq: z.number().int().min(0) }),

  // ── the agent/plan/session lifecycle (#116) ───────────────────────────────
  //
  // Five verbs producing the six ledger-only lifecycle events. They are `open`
  // in `certificationClassOf` — process operations, not covenant certifications:
  // opening or settling a plan/session and raising a signal put no word on the
  // room's record, and settling a session is explicitly non-epistemic (#114 T3).
  // So they are refused to no member, agent or person. This is the trunk: a
  // session cannot yet DRAFT (that is #117), so nothing here mints a `~`.
  z.object({
    name: z.literal('open_plan'),
    roomId: Id,
    /** The agent whose channel this room is — a `users` id of an agent principal. */
    agentUserId: Id,
    title: z.string().min(1).max(200),
    budgetLimitMicros: z.number().int().nonnegative().nullable().default(null),
  }),
  z.object({ name: z.literal('settle_plan'), roomId: Id, planId: Id }),
  z.object({
    name: z.literal('open_session'),
    roomId: Id,
    /** The plan that is this session's ONE parent (the pstree edge). */
    planId: Id,
    harness: z.string().min(1).max(120),
    model: z.string().min(1).max(120),
  }),
  z.object({
    name: z.literal('settle_session'),
    roomId: Id,
    sessionId: Id,
    /** Which exit this is — a clean settle or a failure owed triage (§9.5). */
    outcome: z.enum(['settled', 'failed']),
    exitSummary: z.string().max(4000).nullable().default(null),
    spendMicros: z.number().int().nonnegative().nullable().default(null),
    contextPct: z.number().min(0).max(1).nullable().default(null),
    /**
     * The verified artifact the ExecutionProvider produced (#120), or `null`.
     * A branch/commit reference, non-epistemic — it rides the exit event's
     * payload and is the durable, receipt-indexed pointer to the session's work.
     */
    artifact: ExecutionArtifact.nullable().default(null),
  }),
  z.object({
    name: z.literal('raise_signal'),
    roomId: Id,
    /** Whom to escalate to — a participant `users` id. */
    targetUserId: Id,
    subjectKind: z.enum(['object', 'proposal', 'message']),
    subjectId: Id,
    class: AttentionClass,
    reason: RationaleReason,
  }),

  // ── the budget/rlimit enforcement boundary (#118) ──────────────────────────
  //
  // The human-only spend-authorization: setting or raising a plan's rlimit slice.
  // Unlike the five lifecycle verbs above (which are `open` — a machine may
  // perform them as itself), this is `authorizes-spend` in `certificationClassOf`
  // and is refused to a non-human BEFORE the append, exactly as a machine trying
  // to certify is. A spend-authorization is a human-only class (#115 decision 4):
  // human = init sets the ceiling, and no machine-authored path raises its own.
  z.object({
    name: z.literal('set_plan_rlimit'),
    roomId: Id,
    /** The plan whose slice is being set or raised. */
    planId: Id,
    /** The new ceiling on authorized draws (spawns/continues). Non-negative. */
    slice: z.number().int().nonnegative(),
  }),
]);
export type Command = z.infer<typeof Command>;

/**
 * What a command does to the room's certified record, per command name.
 *
 * ## The hole this closes
 *
 * `@atrium/core`'s gates are folds: a non-human `accept_proposal` reaches the
 * reducer, the reducer refuses it, and `appendAndProject` reports
 * `applied_with_issue`. That is a correct verdict and an **incorrect shape** —
 * the `core_events` row is still inserted, the ack still comes back `ack` with a
 * populated `issues` array, and a client that renders acks and ignores `issues`
 * shows the room a certification that did not happen. #96's gauntlet:
 * *"'writes nothing' is overstated"*. It is not the ✓ (no object lands) and it
 * is durable history saying a machine tried to mint one, dressed as a success.
 *
 * `draftToProposal` already had the right shape — a non-human staging a proposal
 * throws before anything is appended — and this generalises it to the rest of
 * the certification class.
 *
 * ## Why a total classification rather than a list of the bad ones
 *
 * A denylist of certifying commands fails **open** for the fourteenth command,
 * which is the exact defect shape #96 finding 4 is about one layer down. This
 * switch is exhaustive over `CommandName`, so a new verb does not compile until
 * somebody has said which of the three it is, and "I forgot" is a build error
 * rather than an open gate.
 *
 * ## The three classes, and the line between them
 *
 * The line is **the covenant** (init.md, AGENTS.md): a machine may draft (`~`),
 * never certify (`✓`). So the question for each verb is *does performing this
 * put the room's word on something, or move something that already carries it?*
 *
 *  - `accept_proposal` mints an accepted object. That is the ✓ itself.
 *  - `answer_message` mints a `decision` carrying `decidedBy: <the actor>` and
 *    binds it as the answer to an open question — a certification and a
 *    settlement in one batch. (It also posts a message, which an agent may do;
 *    the message is not separable from the decision here, and the command as a
 *    whole is the certifying one. An agent with something to say posts it.)
 *  - `answer_bind` declares a question settled. #4 gives a decision exactly two
 *    doors and this is one of them.
 *  - `correct` rewrites what the room already accepted — human-only for every
 *    verb, and the act that promotes a `~` to `✓` by touching it.
 *  - `reject_proposal` retires **somebody else's** staged reading, always: a
 *    non-human owns no proposal to withdraw, because `Proposer` has no agent
 *    variant and `draftToProposal` refuses to mint one. So every non-human
 *    rejection reachable from this socket is a judgement on another's reading,
 *    which is authority. If `Proposer` ever gains an agent variant, this row
 *    moves to `conditional` and the condition is `actorMatchesProposer`.
 *
 * `supersede_object` is classified `conditional` because it retires an object,
 * and retirement is human-only — but a non-human is refused it outright: #95
 * says a machine may never retire an accepted object at all (confirmed or not),
 * only draft a superseding reading. The `prepare` guard therefore refuses every
 * non-human; `epistemicStateOf` is read there only to name *which* rule refused
 * (`confirmed_supersession` vs `unconfirmed_supersession`) so the room hears the
 * reason, not to decide *whether* to refuse. (The earlier interim keyed the
 * refusal on `confirmed` alone; #96 round 3 broadened it after a blind critic
 * found a non-human could retire another machine's unconfirmed `~`.) A human
 * still supersedes freely, subject to #4's type rules.
 *
 * Everything else is participation, and an agent is a participant: posting,
 * resolving **its own** attention (scoped in `projections.ts`, #96 finding 2),
 * presence, typing, its own seen cursor. `record_proposal` and
 * `stage_semantic_command` are `open` here **on purpose** — staging is the
 * covenant's left-hand side and open to every member — and today they are
 * refused for a non-human one layer in, by `draftToProposal`, for a narrower
 * reason that is about the proposer vocabulary rather than about authority. Two
 * different rules; classifying them as certifying here would hide the day the
 * vocabulary grows and staging legitimately opens.
 */
export type CertificationClass =
  /** Puts the room's word on something. Human-only, refused before the append. */
  | 'certifies'
  /**
   * Authorizes SPEND — sets or raises a plan's rlimit slice (#118, #115's
   * resolution). Human-only for the same reason `certifies` is, and refused the
   * same way, before the append: a spend-authorization is a human-only
   * certification class, `human = init` sets the ceiling, and no machine-authored
   * path raises its own budget. Kept distinct from `certifies` because the two
   * refuse for different reasons and say so differently — one is "a machine may
   * not certify a `✓`", the other "a machine may not authorize its own spend".
   */
  | 'authorizes-spend'
  /** May or may not, depending on the object. Refused at the command's own site. */
  | 'conditional'
  /** Participation. Open to any member, of any kind. */
  | 'open';

export function certificationClassOf(name: CommandName): CertificationClass {
  switch (name) {
    case 'accept_proposal':
    case 'answer_message':
    case 'answer_bind':
    case 'correct':
    case 'reject_proposal':
      return 'certifies';
    case 'supersede_object':
      return 'conditional';
    case 'send_message':
    case 'record_proposal':
    case 'stage_semantic_command':
    case 'resolve_attention':
    case 'set_presence':
    case 'set_typing':
    case 'advance_seen':
    // The lifecycle verbs (#116). Participation, not certification: none of them
    // mints or moves a `✓`. A session settling is process state, non-epistemic
    // by #114 T3 — the loudest reason this row is `open` and not `certifies`. An
    // agent's loop performs these as itself, which a machine may do.
    case 'open_plan':
    case 'settle_plan':
    case 'open_session':
    case 'settle_session':
    case 'raise_signal':
      return 'open';
    // The spend-authorization (#118). NOT `open`: setting or raising a plan's
    // rlimit slice is `human = init`'s act, refused to a machine before the
    // append exactly as certifying is. A machine raising its own budget is
    // campaign-stopping, and this is the single classification that stops it.
    case 'set_plan_rlimit':
      return 'authorizes-spend';
    default: {
      // A verb nobody has classified is not a verb a machine may perform.
      const exhaustive: never = name;
      return JSON.stringify(exhaustive) === '' ? 'open' : 'certifies';
    }
  }
}

/**
 * What a room is told when a machine tries to certify. Names the act, the kind,
 * and the route that stays open — a refusal that does not say what to do instead
 * is a dead end (`RETRO.md`).
 */
export function nonHumanCertificationRefusal(name: CommandName, kind: string): string {
  return `"${name}" is a certification and this session is a ${kind} principal — a machine may draft a reading (~) and may never certify one (✓); nothing was appended. Stage the reading and let a person in the room accept it`;
}

/**
 * What a room is told when a machine tries to authorize spend (#118). The parallel
 * of `nonHumanCertificationRefusal` for the SPEND syscall: `human = init` sets a
 * plan's rlimit slice, and a machine raising its own (or any) budget is
 * campaign-stopping (#115 decision 4). Names the act and the route that stays
 * open — a person in the room funds the plan.
 */
export function nonHumanSpendAuthorizationRefusal(name: CommandName, kind: string): string {
  return `"${name}" authorizes spend — it sets a plan's rlimit slice — and this session is a ${kind} principal; a plan's budget is set by a person (human = init), and no machine may raise its own or any plan's ceiling. Nothing was appended. Ask a person in the room to fund the plan`;
}

/**
 * What a member is told when they try to settle somebody else's session (#120
 * round-3 F3). Names the act, why it is not theirs, and the route that stays
 * open — the party that opened it settles it, and a wedged one is reconciled at
 * startup rather than fabricated by a bystander.
 */
export function sessionSettleRefusal(sessionId: string): string {
  return `"settle_session" writes session "${sessionId}"'s exit receipt, and only the party that OPENED that session may write it — a session's exit is a fact about a process you are not running, and a member fabricating one would stand in the ledger as that process's receipt. Nothing was appended. If the session is wedged, it is reconciled at startup, not settled from the outside`;
}

/**
 * #102 finding 1 — the refusal a self-verifying source author gets.
 *
 * Names the *act* (verifying a claim drawn from your own message) and the route
 * that stays open (another member), and says outright that the payload
 * `claimant` is not what this is about — because the whole point of this gate is
 * that `claimant` is a spoofable stand-in the reducer trusts and this layer does
 * not.
 */
export function selfVerificationAuthorRefusal(userId: string): string {
  return `user "${userId}" would verify a claim drawn from a message they wrote — verification is a second pair of eyes (#68, #95): the author of the source a claim rests on may not be the one who vouches it is true, whatever the claim's \`claimant\` field says. It waits for another member to verify it`;
}

/**
 * The authoritative half of the self-verification rule (#102 finding 1), and the
 * half the reducer structurally cannot enforce.
 *
 * `@atrium/core`'s `selfVerificationRefusal` compares the actor to the claim's
 * payload `claimant` — but nothing holds `claimant` equal to the author of the
 * source message the claim was read out of (for a claim the acceptance receipt
 * resolves attribution to `null`), and on the human path the reducer has no
 * message window at all (`atrium_receipt_window` is NULL for humans). So a claim
 * with `claimant: Bob` drawn from a message Alice wrote lets Alice verify her own
 * sentence: the reducer sees actor Alice ≠ claimant Bob and waves it through.
 *
 * Only this layer holds the messages, so only this layer can anchor the rule to
 * the *real* author. It refuses a human whose id matches the author of any
 * message in the claim's provenance (`object_sources` / `proposal_sources` →
 * `messages.author_id`), read under the append lock on the transaction about to
 * write — the same place and the same trust boundary as `requireMembership`.
 *
 * **Conservative on purpose.** The machine path narrows to the single *bearing*
 * message (the one containing the quote) because padding provenance could flip a
 * third-party statement into a self-statement to *auto-accept* it — a
 * fail-*open*. This gate runs the other direction: it *refuses*, so widening the
 * net to every provenance message can only refuse a verification that would
 * otherwise stand, never admit one that should not. A member who wrote any of
 * the source a claim rests on is not the disinterested second reader #68 wants.
 * (An accepted object does not carry the quote — see core's `Provenance` — so the
 * bearing-message narrowing is not available here even if it were wanted.)
 */
/** Does this stored payload carry `verification: 'verified'`? */
function isVerifiedClaimPayload(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { verification?: unknown }).verification === 'verified'
  );
}

/**
 * The stored object's current type and verification — enough to key the
 * self-verification guard on the reducer's `becomesVerified` *transition* rather
 * than on the mere presence of `verification: 'verified'` in a patch (#102
 * finding 3). An `amend {…, verification:'verified'}` on a claim that is ALREADY
 * verified mints no new ✓ (and a materially-changed one lapses back to
 * `unverified` inside the reducer) — neither is a verification act, so a
 * legitimate full-form amendment like `{statement:'corrected wording',
 * verification:'verified'}` by the claim's own author must NOT be refused here.
 */
async function currentClaimState(
  tx: Tx,
  roomId: string,
  objectId: string,
): Promise<{ isClaim: boolean; verified: boolean }> {
  const [row] = await tx
    .select({ type: acceptedObjects.type, payload: acceptedObjects.payload })
    .from(acceptedObjects)
    .where(and(eq(acceptedObjects.id, objectId), eq(acceptedObjects.roomId, roomId)))
    .limit(1);
  const isClaim = row?.type === 'claim';
  return { isClaim, verified: isClaim && isVerifiedClaimPayload(row.payload) };
}

async function refuseSelfVerificationByAuthor(
  tx: Tx,
  session: Session,
  roomId: string,
  source: { proposalId: string } | { objectId: string },
): Promise<void> {
  // A machine cannot certify at all — refused by the covenant one door up. This
  // is the relation gate for the humans it admits.
  if (session.principalKind !== 'human') return;
  const authorRows =
    'proposalId' in source
      ? await tx
          .select({ authorId: messages.authorId })
          .from(proposalSources)
          .innerJoin(
            messages,
            and(
              eq(messages.id, proposalSources.messageId),
              eq(messages.roomId, proposalSources.roomId),
            ),
          )
          .where(
            and(
              eq(proposalSources.proposalId, source.proposalId),
              eq(proposalSources.roomId, roomId),
            ),
          )
      : await tx
          .select({ authorId: messages.authorId })
          .from(objectSources)
          .innerJoin(
            messages,
            and(
              eq(messages.id, objectSources.messageId),
              eq(messages.roomId, objectSources.roomId),
            ),
          )
          .where(
            and(eq(objectSources.objectId, source.objectId), eq(objectSources.roomId, roomId)),
          );
  if (authorRows.some((row) => row.authorId === session.userId)) {
    throw new CommandError('invalid', selfVerificationAuthorRefusal(session.userId));
  }
}
/**
 * A command as a *caller* writes it — defaults not yet applied.
 *
 * The difference is not cosmetic. `Command` is the parsed shape, in which every
 * `.default()` field is present; a real client sends JSON without them and zod
 * fills them in. Test harnesses and any in-process caller should speak this
 * type, because demanding `toType: null, provenance: {…}` from every caller is
 * demanding a shape no socket ever sends.
 */
export type CommandInput = z.input<typeof Command>;
export type CommandName = Command['name'];

/** What a command did, and therefore what the socket layer should fan out. */
export type CommandResult =
  | {
      kind: 'appended';
      roomId: string;
      seq: number;
      roomSeq: number;
      /** The trusted actor this row was appended under — what the wire carries. */
      actor: Actor;
      event: RoomEvent;
      /** Business problems the reducer recorded. The event still happened. */
      issues: string[];
      /**
       * `open_session` only: the authorized-draw outcome (#118 fix r2, HIGH-3). A
       * draw either GRANTED a session (`session_opened`, carrying the id) or was
       * REFUSED against the plan's budget (`draw_refused`, `reason=budget`, with the
       * slice and committed count). Both append and both ack with empty `issues`, so
       * the append shape alone cannot tell them apart — this field is what lets a
       * caller/adapter know whether it actually got a session. Absent on every other
       * command.
       */
      draw?:
        | { outcome: 'granted'; sessionId: string }
        | { outcome: 'refused'; reason: 'budget'; slice: number; authorizedDraws: number };
    }
  | {
      kind: 'appended_many';
      roomId: string;
      entries: readonly import('./ledger.js').AppendResult[];
      replayed: boolean;
    }
  | { kind: 'presence'; roomId: string; userId: string; state: PresenceState; at: string }
  | { kind: 'typing'; roomId: string; userId: string; typing: boolean; at: string }
  | { kind: 'seen'; roomId: string; userId: string; seenSeq: number };

export interface CommandServiceOptions {
  db: Database;
  ledger: Ledger;
  authorizer: Authorizer;
  /**
   * Work that must commit with the append — today, only the interpretation
   * enqueue (#23). Wired from `index.ts` with the queue handle; absent, a
   * message is still appended and broadcast and simply never interpreted.
   *
   * It is deliberately *not* defaulted to a no-op inside `projectRoomEvent`:
   * "nothing schedules interpretation" is a real deployment state (a process
   * running with the worker disabled) and should be a visible piece of wiring
   * rather than an omission nobody can see.
   */
  projectionHooks?: ProjectionHooks;
  /** Verifies that each persisted metadata tuple came from this server's upload grant. */
  attachmentCapabilities?: Pick<import('./attachments.js').AttachmentSigner, 'verify'>;
  /**
   * Verifies a `settle_session` artifact against the execution provider's own
   * durable remote (#120 F2). A `settle_session` carries a `{branch,commit,remote}`
   * that a caller could FABRICATE — a member claiming `{branch:"main",
   * commit:"…",remote:"/real/repo"}` would otherwise plant a false "verified
   * artifact" pointer in the ledger. The verifier is closed over the provider's
   * controlled remote and returns `true` ONLY when the artifact names a git
   * object the provider actually produced (right session branch, right remote,
   * commit resolves there). When it returns `false` — or is ABSENT, which is the
   * state when execution is disabled and no artifact has a legitimate source —
   * the artifact is dropped to `null` before the exit event is written. A settled
   * session's artifact therefore always corresponds to a real provider object,
   * never a caller assertion.
   */
  verifyArtifact?: ArtifactVerifier;
}

/** Confirms a settle artifact names a git object the execution provider produced (#120 F2). */
export type ArtifactVerifier = (input: {
  readonly sessionId: string;
  readonly artifact: z.infer<typeof ExecutionArtifact>;
}) => Promise<boolean>;

export interface CommandService {
  execute: (session: Session, command: Command) => Promise<CommandResult>;
  /** Membership check for the plain reads — subscribe and since. */
  requireMembership: (session: Session, roomId: string) => Promise<{ seenSeq: number }>;
  /**
   * Which of these subscriptions are still backed by a membership.
   *
   * The fan-out set's re-check, in one statement — see `Authorizer.present` and
   * `ws-server.ts`. Not `execute`'s business and not a command: nothing is
   * appended, nothing is authorized *for*, and the caller is a timer.
   */
  stillMembers: (pairs: readonly MembershipPair[]) => Promise<Set<string>>;
}

const REFERENCE_UNAVAILABLE = 'reference is unavailable';

async function validateMessageReferences(input: {
  tx: Pick<Database, 'select'>;
  roomId: string;
  body: string;
  attachments: readonly z.infer<typeof MessageAttachment>[];
  references: readonly z.infer<typeof MessageReference>[];
}): Promise<void> {
  const { tx, roomId, body, references } = input;
  const ordinals = new Set<number>();
  const ordered = [...references].sort((a, b) => a.start - b.start || a.end - b.end);
  let priorEnd = -1;
  for (const [index, reference] of ordered.entries()) {
    if (
      ordinals.has(reference.ordinal) ||
      reference.ordinal !== index ||
      reference.end > body.length ||
      reference.start >= reference.end ||
      reference.start < priorEnd ||
      !reference.surface.startsWith('@') ||
      body.slice(reference.start, reference.end) !== reference.surface
    ) {
      throw new CommandError('invalid', REFERENCE_UNAVAILABLE);
    }
    ordinals.add(reference.ordinal);
    priorEnd = reference.end;
  }

  const ids = (kind: z.infer<typeof MessageReference>['kind']) => [
    ...new Set(references.filter((reference) => reference.kind === kind).map((r) => r.targetId)),
  ];
  const humanIds = ids('human');
  const agentIds = ids('agent');
  const attachmentIds = ids('attachment');
  const proposalIds = ids('proposal');
  const objectIds = ids('object');
  // A `human` and an `agent` reference name the same sort of thing — a
  // participant with a `users` row and a room membership — so both are checked
  // together, and the target's own `principal_kind` must MATCH the kind the
  // author claimed. That agreement is what stops a `human` reference from
  // silently naming an agent (or the reverse) now that both are members; the
  // append-boundary trigger (drizzle/0016, replaced in 0019) is the authority,
  // this is the clean pre-check that turns a mislabel into REFERENCE_UNAVAILABLE
  // instead of a raw constraint error.
  const participantIds = [...new Set([...humanIds, ...agentIds])];

  const [effectiveMemberIds, principalRows, proposalRows, objectRows] = await Promise.all([
    participantIds.length === 0
      ? ([] as string[])
      : roomMemberIds(tx as unknown as Database, roomId),
    participantIds.length === 0
      ? ([] as { id: string; principalKind: 'human' | 'agent' }[])
      : tx
          .select({ id: users.id, principalKind: users.principalKind })
          .from(users)
          .where(inArray(users.id, participantIds)),
    proposalIds.length === 0
      ? []
      : tx
          .select({ id: proposals.id })
          .from(proposals)
          .where(and(eq(proposals.roomId, roomId), inArray(proposals.id, proposalIds))),
    objectIds.length === 0
      ? []
      : tx
          .select({ id: acceptedObjects.id })
          .from(acceptedObjects)
          .where(and(eq(acceptedObjects.roomId, roomId), inArray(acceptedObjects.id, objectIds))),
  ]);
  const members = new Set(effectiveMemberIds);
  const principalOf = new Map(principalRows.map((row) => [row.id, row.principalKind]));
  const namesMember = (id: string, kind: 'human' | 'agent') =>
    members.has(id) && principalOf.get(id) === kind;
  const uploaded = new Set(input.attachments.map((attachment) => attachment.id));
  if (
    humanIds.some((id) => !namesMember(id, 'human')) ||
    agentIds.some((id) => !namesMember(id, 'agent')) ||
    proposalRows.length !== proposalIds.length ||
    objectRows.length !== objectIds.length ||
    attachmentIds.some((id) => !uploaded.has(id))
  ) {
    throw new CommandError('invalid', REFERENCE_UNAVAILABLE);
  }
}

export function createCommandService({
  db,
  ledger,
  authorizer,
  projectionHooks = {},
  attachmentCapabilities,
  verifyArtifact,
}: CommandServiceOptions): CommandService {
  async function requireMembership(session: Session, roomId: string, runner?: Tx) {
    const membership = await authorizer.authorize(session, roomId, runner);
    if (!membership) {
      // Same message whether the room is missing or merely not yours. A
      // membership check that distinguishes the two is a room-existence oracle.
      throw new CommandError('not_a_member', `no membership for room "${roomId}"`);
    }
    return membership;
  }

  /**
   * The session, as the actor core will fold under. The one derivation.
   *
   * It returned the literal `{ kind: 'human', userId }` until agents existed,
   * which was correct for exactly as long as holding an account implied being a
   * person. It does not any more, and the substitution is not cosmetic: `kind`
   * is what every certification gate in `@atrium/core` reads, so a seam that
   * keeps answering `'human'` for an agent's session does not fail a test — it
   * quietly certifies on a machine's behalf while every gate reports green.
   *
   * `session.principalKind` is required (`session.ts`), so there is no absent
   * case to default and no `?? 'human'` anywhere on this path. The switch is
   * exhaustive over `PrincipalKind`, so a third kind of principal does not
   * compile until somebody has said what actor it makes.
   *
   * Both branches carry `userId`, and that is the shape the rest of the system
   * needs: an agent that is a room member, an attention target and an author has
   * to be nameable by the same id `memberships` and `attention_items` use. What
   * separates the two branches downstream is `isHuman`, and nothing else.
   */
  function actorOf(session: Session): Actor {
    switch (session.principalKind) {
      case 'human':
        return { kind: 'human', userId: session.userId };
      case 'agent':
        return { kind: 'agent', userId: session.userId };
      default: {
        const exhaustive: never = session.principalKind;
        throw new CommandError(
          'invalid',
          `session carries an unknown principal kind ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }

  /**
   * The append path every non-ephemeral command funnels through.
   *
   * `actor` is derived here, from the session the socket authenticated, and
   * handed to the ledger as a *trusted argument* rather than built into the
   * event. That is #21's contract and it is the whole of this layer's part in
   * it: core cannot check that an actor came from an authenticated session — it
   * has no session — so the guarantee is exactly as good as this one derivation,
   * which is why there is one of them and it is three lines from the session.
   */
  async function appendAndProject(
    session: Session,
    roomId: string,
    build: (assigned: { id: string; at: string }) => RoomEvent,
    /**
     * An extra hard refusal to run under the append lock, after membership and
     * before the build — for a rule that needs DB reads the reducer cannot do
     * (today: #102 finding 1's source-author self-verification check). Throwing
     * aborts the transaction: no row, an error to the caller, same shape as a
     * membership failure.
     */
    guard?: (tx: Tx) => Promise<void>,
  ): Promise<CommandResult> {
    const appended = await ledger.append({
      roomId,
      actor: actorOf(session),
      // The authorization that counts: same question, asked again under the
      // append lock, on the transaction that is about to write.
      authorize: async (tx) => {
        await requireMembership(session, roomId, tx);
        if (guard) await guard(tx);
      },
      build,
      project: (context) => projectRoomEvent(context, projectionHooks),
    });
    const issues =
      appended.outcome?.outcome === 'applied_with_issue'
        ? appended.outcome.issues.map((issue) => issue.reason)
        : [];
    return {
      kind: 'appended',
      roomId: appended.roomId,
      seq: appended.seq,
      roomSeq: appended.roomSeq,
      actor: appended.actor,
      event: appended.event,
      issues,
    };
  }

  async function execute(session: Session, command: Command): Promise<CommandResult> {
    // The cheap early refusal. The one that decides whether an append is
    // allowed to become durable is inside the append transaction — see
    // `appendAndProject`.
    await requireMembership(session, command.roomId);

    // ── The covenant, before the append rather than during the fold ──────────
    //
    // #96 r2, finding 3. The reducer already refuses every one of these, and it
    // refuses them *as a fold*: the row lands, the outcome is
    // `applied_with_issue`, and the caller gets an `ack` carrying `issues`. A
    // hard refusal here is the honest shape — nothing durable, a `nack`, and no
    // client left to work out that an ack it was given did not happen.
    //
    // Note this does not replace the reducer's gates and must not: this binds
    // one door and the reducer binds the fold itself, which is what a replay, a
    // second writer or the interpretation worker goes through. Two layers, the
    // same rule, and `certificationClassOf` is the only place the *list* lives.
    if (!isHuman(actorOf(session))) {
      const klass = certificationClassOf(command.name);
      if (klass === 'certifies') {
        throw new CommandError(
          'invalid',
          nonHumanCertificationRefusal(command.name, session.principalKind),
        );
      }
      // The SPEND syscall (#118), refused the same way and in the same place as a
      // machine trying to certify: `human = init` sets a plan's rlimit slice, and
      // no machine-authored path raises its own budget. Nothing durable, a `nack`.
      if (klass === 'authorizes-spend') {
        throw new CommandError(
          'invalid',
          nonHumanSpendAuthorizationRefusal(command.name, session.principalKind),
        );
      }
    }

    switch (command.name) {
      case 'send_message': {
        const persistedAttachments = command.attachments.map(
          ({ capability: _capability, ...attachment }) => MessageAttachment.parse(attachment),
        );
        const prepare = async (tx: Tx) => {
          if (command.attachments.length > 0 && !attachmentCapabilities) {
            throw new CommandError('invalid', 'attachments are not configured');
          }
          if (
            command.attachments.some(
              (attachment) =>
                attachmentCapabilities?.verify({ ...attachment, roomId: command.roomId }) !== true,
            )
          ) {
            throw new CommandError(
              'invalid',
              command.references.some((reference) => reference.kind === 'attachment')
                ? REFERENCE_UNAVAILABLE
                : 'an attachment capability is invalid or expired',
            );
          }
          if (
            new Set(persistedAttachments.map((attachment) => attachment.id)).size !==
            persistedAttachments.length
          ) {
            throw new CommandError(
              'invalid',
              command.references.some((reference) => reference.kind === 'attachment')
                ? REFERENCE_UNAVAILABLE
                : 'an attachment capability is invalid or expired',
            );
          }
          await validateMessageReferences({
            tx,
            roomId: command.roomId,
            body: command.body,
            attachments: persistedAttachments,
            references: command.references,
          });
        };
        const build = ({ id, at }: { id: string; at: string }): RoomEvent => ({
          id,
          at,
          type: 'message_posted',
          roomId: command.roomId,
          messageId: randomUUID(),
          body: command.body,
          replyToId: command.replyToId,
          clientMessageId: command.clientMessageId,
          attachments: persistedAttachments,
          references: command.references,
        });
        if (command.clientMessageId === null) {
          const batch = await ledger.appendBatch({
            roomId: command.roomId,
            actor: actorOf(session),
            requireClean: true,
            authorize: async (tx) => {
              await requireMembership(session, command.roomId, tx);
            },
            prepare,
            builds: [build],
            project: (context) => projectRoomEvent(context, projectionHooks),
          });
          const entry = batch.entries[0];
          if (!entry) throw new Error('send_message batch committed without an entry');
          return { kind: 'appended', ...entry, issues: [...entry.issues] };
        }
        const batch = await ledger.appendBatch({
          roomId: command.roomId,
          actor: actorOf(session),
          requireClean: true,
          authorize: async (tx) => {
            await requireMembership(session, command.roomId, tx);
          },
          prepare,
          idempotency: {
            commandName: 'send_message',
            key: command.clientMessageId,
            fingerprint: sendMessageFingerprint({
              roomId: command.roomId,
              body: command.body,
              replyToId: command.replyToId,
              attachments: persistedAttachments,
              references: command.references,
            }),
            expectedEventTypes: ['message_posted'],
          },
          builds: [build],
          project: (context) => projectRoomEvent(context, projectionHooks),
        });
        return {
          kind: 'appended_many',
          roomId: command.roomId,
          entries: batch.entries,
          replayed: batch.replayed,
        };
      }

      case 'answer_message': {
        const messageId = randomUUID();
        const answerObjectId = randomUUID();
        const relationId = randomUUID();
        const persistedAttachments = command.attachments.map(
          ({ capability: _capability, ...attachment }) => MessageAttachment.parse(attachment),
        );
        const batch = await ledger.appendBatch({
          roomId: command.roomId,
          actor: actorOf(session),
          requireClean: true,
          authorize: async (tx) => {
            await requireMembership(session, command.roomId, tx);
          },
          prepare: async () => {
            if (command.attachments.length > 0 && !attachmentCapabilities) {
              throw new CommandError('invalid', 'attachments are not configured');
            }
            if (
              command.attachments.some(
                (attachment) =>
                  attachmentCapabilities?.verify({ ...attachment, roomId: command.roomId }) !==
                  true,
              )
            ) {
              throw new CommandError('invalid', 'an attachment capability is invalid or expired');
            }
          },
          idempotency: {
            commandName: 'answer_message',
            key: command.clientMessageId,
            fingerprint: answerMessageFingerprint({
              roomId: command.roomId,
              questionId: command.questionId,
              body: command.body,
              attachments: persistedAttachments,
            }),
            expectedEventTypes: ['message_posted', 'object_accepted', 'relation_added'],
          },
          builds: [
            ({ id, at }) => ({
              id,
              at,
              type: 'message_posted',
              roomId: command.roomId,
              messageId,
              body: command.body,
              replyToId: null,
              clientMessageId: command.clientMessageId,
              attachments: persistedAttachments,
              references: [],
            }),
            ({ id, at }) => {
              const question = ledger.coreState().objects[command.questionId];
              if (question?.object.type !== 'open_question') {
                throw new CommandError('invalid', 'the bound subject is not an open question');
              }
              if (
                question.object.roomId !== command.roomId ||
                question.retractedAt !== null ||
                question.object.payload.status !== 'open'
              ) {
                throw new CommandError('invalid', 'the bound question is not open in this room');
              }
              return {
                id,
                at,
                type: 'object_accepted',
                object: {
                  id: answerObjectId,
                  roomId: command.roomId,
                  objectiveId: question.object.objectiveId,
                  type: 'decision',
                  payload: { statement: command.body, decidedBy: session.userId, status: 'active' },
                  provenance: {
                    messageIds: [messageId],
                    proposalId: null,
                    interpretationId: null,
                  },
                  createdAt: at,
                  updatedAt: at,
                },
              };
            },
            ({ id, at }) => ({
              id,
              at,
              type: 'relation_added',
              relation: {
                id: relationId,
                roomId: command.roomId,
                kind: 'answers',
                fromObjectId: command.questionId,
                to: { kind: 'object', objectId: answerObjectId },
                note: null,
                createdAt: at,
              },
            }),
          ],
          // Explicit answer-binding is a person's command, not an inference.
          // Project the message but do not enqueue it for interpretation.
          project: (context) => projectRoomEvent(context, {}),
        });
        return {
          kind: 'appended_many',
          roomId: command.roomId,
          entries: batch.entries,
          replayed: batch.replayed,
        };
      }

      case 'record_proposal':
        return appendAndProject(session, command.roomId, ({ id, at }) => ({
          id,
          at,
          type: 'proposal_recorded',
          proposal: draftToProposal(command.proposal, command.roomId, at, session),
        }));

      case 'stage_semantic_command': {
        let source: { body: string } | undefined;
        const batch = await ledger.appendBatch({
          roomId: command.roomId,
          actor: actorOf(session),
          requireClean: true,
          authorize: async (tx) => {
            await requireMembership(session, command.roomId, tx);
          },
          prepare: async (tx) => {
            [source] = await tx
              .select({ body: messages.body })
              .from(messages)
              .where(
                and(
                  eq(messages.id, command.messageId),
                  eq(messages.roomId, command.roomId),
                  eq(messages.authorId, session.userId),
                ),
              )
              .limit(1);
            if (!source || !parseSemanticCommand(source.body, session.userId)) {
              throw new CommandError(
                'invalid',
                'that message is not your semantic command in this room',
              );
            }
          },
          idempotency: {
            commandName: 'stage_semantic_command',
            key: command.idempotencyKey,
            fingerprint: semanticCommandFingerprint(command.roomId, command.messageId),
            expectedEventTypes: ['proposal_recorded'],
          },
          builds: [
            ({ id, at }) => {
              const parsed = source && parseSemanticCommand(source.body, session.userId);
              if (!source || !parsed)
                throw new CommandError('invalid', 'semantic source was not prepared');
              return {
                id,
                at,
                type: 'proposal_recorded',
                proposal: draftToProposal(
                  {
                    type: parsed.type,
                    payload: parsed.payload,
                    confidence: 1,
                    provenance: [command.messageId],
                    quote: source.body,
                    interpretationId: null,
                  } as ProposalDraft,
                  command.roomId,
                  at,
                  session,
                ),
              };
            },
          ],
          project: (context) => projectRoomEvent(context, projectionHooks),
        });
        return {
          kind: 'appended_many',
          roomId: command.roomId,
          entries: batch.entries,
          replayed: batch.replayed,
        };
      }

      case 'reject_proposal':
        return appendAndProject(session, command.roomId, ({ id, at }) => ({
          id,
          at,
          type: 'proposal_rejected',
          proposalId: command.proposalId,
          reason: command.reason,
        }));

      case 'accept_proposal': {
        return appendAndProject(
          session,
          command.roomId,
          ({ id, at }) => {
            // Read inside `build`, which the ledger calls after catching up under
            // the append lock: the proposal this cites must be the one the state
            // holds *now*, not the one it held when the socket frame arrived.
            const record = ledger.coreState().proposals[command.proposalId];
            if (!record) {
              throw new CommandError('invalid', `unknown proposal "${command.proposalId}"`);
            }
            if (record.proposal.roomId !== command.roomId) {
              throw new CommandError(
                'invalid',
                `proposal "${command.proposalId}" belongs to another room`,
              );
            }
            const object = objectFromProposal(record.proposal, command.objectiveId, at);
            return { id, at, type: 'object_accepted', object };
          },
          // #102 finding 1: accepting a proposal that mints a `✓ verified` claim
          // is a verification act, and the verifier may not be the author of the
          // claim's source. Read the proposal's committed shape under the lock.
          async (tx) => {
            const [row] = await tx
              .select({ type: proposals.type, payload: proposals.payload })
              .from(proposals)
              .where(
                and(eq(proposals.id, command.proposalId), eq(proposals.roomId, command.roomId)),
              )
              .limit(1);
            if (row?.type === 'claim' && isVerifiedClaimPayload(row.payload)) {
              await refuseSelfVerificationByAuthor(tx, session, command.roomId, {
                proposalId: command.proposalId,
              });
            }
          },
        );
      }

      case 'correct':
        return appendAndProject(
          session,
          command.roomId,
          ({ id, at }) => ({
            id,
            at,
            type: 'object_corrected',
            objectId: command.objectId,
            action: command.action,
            patch: command.patch,
            toType: command.toType,
            provenance: command.provenance,
            note: command.note,
          }),
          // #102 finding 1: a correction that mints a `✓ verified` claim (an
          // `amend`, or a `retype` into a claim) is a verification act, anchored to
          // the real source author the reducer cannot see. #102 finding 3: key it
          // on the reducer's `becomesVerified` *transition*, not the bare presence
          // of `verification:'verified'`. A claim already verified re-asserting it
          // mints no new ✓, and a material edit lapses it back to `unverified` in
          // the reducer — neither is a verification act, so the author's own
          // full-form amendment must not be nacked as self-verification.
          async (tx) => {
            if (command.patch.verification !== 'verified') return;
            const { isClaim, verified } = await currentClaimState(
              tx,
              command.roomId,
              command.objectId,
            );
            const willBeClaim = command.action === 'retype' ? command.toType === 'claim' : isClaim;
            if (!willBeClaim) return;
            // Already a verified claim → the reducer's `becomesVerified` is false,
            // so no new certification is happening: nothing to refuse.
            if (isClaim && verified) return;
            await refuseSelfVerificationByAuthor(tx, session, command.roomId, {
              objectId: command.objectId,
            });
          },
        );

      case 'answer_bind':
        return appendAndProject(session, command.roomId, ({ id, at }) => {
          const relation: Relation = {
            id: randomUUID(),
            roomId: command.roomId,
            kind: 'answers',
            fromObjectId: command.questionId,
            to: { kind: 'object', objectId: command.answerObjectId },
            note: command.note,
            createdAt: at,
          };
          return { id, at, type: 'relation_added', relation };
        });

      case 'supersede_object': {
        const relationId = randomUUID();
        const batch = await ledger.appendBatch({
          roomId: command.roomId,
          actor: actorOf(session),
          requireClean: true,
          authorize: async (tx) => {
            await requireMembership(session, command.roomId, tx);
          },
          prepare: async () => {
            const state = ledger.coreState();
            const replacement = state.objects[command.replacementObjectId];
            const retired = state.objects[command.retiredObjectId];
            if (!replacement || replacement.object.roomId !== command.roomId) {
              throw new CommandError('invalid', 'the replacement is not an object in this room');
            }
            if (!retired || retired.object.roomId !== command.roomId) {
              throw new CommandError(
                'invalid',
                'the retired subject is not an object in this room',
              );
            }
            if (replacement.retractedAt !== null || replacement.supersededById !== null) {
              throw new CommandError('invalid', 'the replacement object is not active');
            }
            if (retired.retractedAt !== null || retired.supersededById !== null) {
              throw new CommandError('invalid', 'the object being retired is not active');
            }
            // ── The `conditional` half of `certificationClassOf` ─────────────
            //
            // #95: a non-human may never retire an accepted object by
            // superseding it — confirmed or not — it may only draft a
            // superseding reading (~). It is a fact about *this object* and the
            // actor's relation to it, not about the verb, which is why it is
            // answered here where the object is in hand and not in the table up
            // top.
            //
            // #96 r3 broadened it from the confirmed subset: keying on
            // `epistemicStateOf(retired) === 'confirmed'` left a machine free to
            // retire another machine's unconfirmed `~`, which #95 also reserves
            // to a person. `epistemicStateOf` now decides only which reason the
            // room hears — the predicate the ✓ is rendered from, and the
            // reducer's gate asks the same function, so a gate and a glyph never
            // disagree in front of a user.
            //
            // The reducer refuses this too, and its refusal is the one that
            // binds a replay. This one is what makes the refusal *hard* — with
            // `requireClean: true` above, the reducer's issue already aborts the
            // batch, so what this adds is the reason: a room hears which rule
            // refused it instead of an atomic-command summary.
            if (!isHuman(actorOf(session))) {
              const confirmed = epistemicStateOf(retired) === 'confirmed';
              throw new CommandError(
                'invalid',
                confirmed
                  ? `object "${command.retiredObjectId}" has been confirmed by a person and this session is a ${session.principalKind} principal — a machine may never retire what the room has confirmed (#95); draft a superseding reading (~) and let a person retire the old one`
                  : `object "${command.retiredObjectId}" is an accepted reading and this session is a ${session.principalKind} principal — a machine may never retire an accepted object by superseding it (#95), even an unconfirmed one; draft a superseding reading (~) and let a person retire the old one`,
              );
            }
          },
          idempotency: {
            commandName: 'supersede_object',
            key: command.clientSupersessionId,
            fingerprint: supersessionFingerprint(command),
            expectedEventTypes: ['relation_added'],
          },
          builds: [
            ({ id, at }) => {
              const relation: Relation = {
                id: relationId,
                roomId: command.roomId,
                kind: 'supersedes',
                fromObjectId: command.replacementObjectId,
                to: { kind: 'object', objectId: command.retiredObjectId },
                note: command.note,
                createdAt: at,
              };
              return { id, at, type: 'relation_added', relation };
            },
          ],
          project: (context) => projectRoomEvent(context, projectionHooks),
        });
        return {
          kind: 'appended_many',
          roomId: command.roomId,
          entries: batch.entries,
          replayed: batch.replayed,
        };
      }

      case 'resolve_attention':
        return appendAndProject(session, command.roomId, ({ id, at }) => ({
          id,
          at,
          type: 'attention_resolved',
          roomId: command.roomId,
          attentionId: command.attentionId,
          status: command.status,
        }));

      // ── the agent/plan/session lifecycle (#116) ────────────────────────────
      //
      // Each is a single ledger-only event through the same `appendAndProject`
      // path `resolve_attention` uses. The entity ids for the two `open` verbs
      // are minted server-side inside the build — like `send_message`'s
      // `messageId` — and read back off the appended event; the settle/raise
      // verbs name an existing entity the caller already holds.
      case 'open_plan':
        return appendAndProject(session, command.roomId, ({ id, at }) => ({
          id,
          at,
          type: 'plan_opened',
          roomId: command.roomId,
          planId: randomUUID(),
          agentUserId: command.agentUserId,
          title: command.title,
          budgetLimitMicros: command.budgetLimitMicros,
        }));

      case 'settle_plan':
        return appendAndProject(session, command.roomId, ({ id, at }) => ({
          id,
          at,
          type: 'plan_settled',
          roomId: command.roomId,
          planId: command.planId,
        }));

      // A spawn is an AUTHORIZED DRAW (#118, #115's resolution). The draw check
      // runs UNDER THE APPEND LOCK — in `authorize`, which the ledger runs after
      // it takes the global lock and before `build` — mirroring #102's certify
      // gate under the ledger lock. It reads the plan's committed
      // `authorized_draws` (the count Atrium granted, which a session cannot lie
      // to it about) against the human-set `rlimit_slice`, and decides which event
      // this append is: a `session_opened` that grants the draw, or a
      // `draw_refused` receipt when the slice is spent. The decision is made once,
      // under the lock, and read by `build`; the two run in that order inside one
      // transaction, so no second writer can move the count between them.
      case 'open_session': {
        const roomId = command.roomId;
        const sessionId = randomUUID();
        // Set in `authorize`, read in `build`. Non-null whenever the draw is
        // REFUSED — carrying the slice and committed count it was checked against.
        // An absent/settled plan is left to `projectSessionOpened`'s existing
        // guard to nack.
        let refusal: { slice: number; authorizedDraws: number } | null = null;
        const appended = await ledger.append({
          roomId,
          actor: actorOf(session),
          authorize: async (tx) => {
            await requireMembership(session, roomId, tx);
            const [plan] = await tx
              .select({
                status: plans.status,
                slice: plans.rlimitSlice,
                authorizedDraws: plans.authorizedDraws,
              })
              .from(plans)
              .where(and(eq(plans.id, command.planId), eq(plans.roomId, roomId)))
              .for('share');
            // An UNFUNDED plan (NULL slice) authorizes ZERO draws — fail CLOSED
            // (#118 fix r2, CS-1). The covenant is that only a HUMAN may authorize
            // spend; a machine drawing against a budget no person set — or none at
            // all — is the campaign-stopping default this closes. So a NULL slice is
            // read as a ceiling of zero: every draw is refused (a `draw_refused`,
            // `reason=budget` — the same durable receipt an over-slice draw takes)
            // until a human sets a finite slice via `set_plan_rlimit`. `open_plan`
            // is `open`-class, so an agent can open a plan; it cannot fund it. The
            // rule is one line — `authorized_draws + this one > slice` — and it is
            // checked against the count Atrium granted, never the session's reported
            // spend, so a 4th draw against a slice that funds 3 (or a 1st against an
            // unfunded plan) is refused regardless of what the session claims spent.
            if (plan && plan.status === 'open') {
              const slice = plan.slice ?? 0;
              if (plan.authorizedDraws + 1 > slice) {
                refusal = { slice, authorizedDraws: plan.authorizedDraws };
              }
            }
          },
          build: ({ id, at }): RoomEvent =>
            refusal
              ? {
                  id,
                  at,
                  type: 'draw_refused',
                  roomId,
                  planId: command.planId,
                  reason: 'budget',
                  slice: refusal.slice,
                  authorizedDraws: refusal.authorizedDraws,
                  harness: command.harness,
                  model: command.model,
                }
              : {
                  id,
                  at,
                  type: 'session_opened',
                  roomId,
                  sessionId,
                  planId: command.planId,
                  harness: command.harness,
                  model: command.model,
                },
          project: (context) => projectRoomEvent(context, projectionHooks),
        });
        return {
          kind: 'appended',
          roomId: appended.roomId,
          seq: appended.seq,
          roomSeq: appended.roomSeq,
          actor: appended.actor,
          event: appended.event,
          issues:
            appended.outcome?.outcome === 'applied_with_issue'
              ? appended.outcome.issues.map((issue) => issue.reason)
              : [],
          // The draw's outcome, carried in the RESULT so a caller/adapter can tell
          // a GRANTED session from a REFUSED draw (#118 fix r2, HIGH-3). Both append
          // and both ack with empty issues — a `session_opened` vs a durable
          // `draw_refused` — so the append shape alone cannot distinguish them, and
          // an adapter must never proceed as if a refused session opened. The
          // durable `draw_refused` row is still the receipt; this is the synchronous
          // signal to its caller. Derived from the event actually built (never the
          // `refusal` closure variable, which TS narrows to null after the append).
          draw:
            appended.event.type === 'draw_refused'
              ? {
                  outcome: 'refused',
                  reason: 'budget',
                  slice: appended.event.slice,
                  authorizedDraws: appended.event.authorizedDraws,
                }
              : { outcome: 'granted', sessionId },
        };
      }

      case 'settle_session': {
        // Set in the guard, read in `build` — the `open_session` pattern, and for
        // the same reason: both must happen under the ONE append lock.
        let verifiedArtifact: z.infer<typeof ExecutionArtifact> | null = null;
        return appendAndProject(
          session,
          command.roomId,
          ({ id, at }) => ({
            id,
            at,
            // One command, two exit spellings (§9.5): a clean settle or a failure
            // owed triage. Both are non-epistemic — the projection writes only the
            // `sessions` row and can flip no `~` to a `✓`.
            type: command.outcome === 'failed' ? 'session_failed' : 'session_settled',
            roomId: command.roomId,
            sessionId: command.sessionId,
            exitSummary: command.exitSummary,
            spendMicros: command.spendMicros,
            contextPct: command.contextPct,
            artifact: verifiedArtifact,
          }),
          async (tx) => {
            // ── A SESSION'S EXIT IS ITS OWNER'S TO WRITE (#120 round-3 F3) ────
            //
            // `settle_session` is `open`-class, which decides whether a MACHINE
            // may perform it (#114 T3: it is non-epistemic, so yes). It never
            // decided WHICH member may perform it, and the answer was "any of
            // them". So while a granted harness was still running, any bystander
            // in the room could append `settle_session {outcome:'settled',
            // artifact:null}`; the one-exit predicate in `projectSessionExit`
            // would honour the fabricated clean exit, the provider's real settle
            // would then find no `open` session and throw, and the ledger would
            // index a caller-chosen outcome with the real artifact unindexed. A
            // false green on the covenant surface: a machine's — or a
            // bystander's — assertion standing as a session's receipt.
            //
            // The mechanism is an OWNER check against the row the open already
            // wrote, deliberately in preference to the two alternatives:
            //
            //  • A coordinator-only command would mean the exit could only ever
            //    be written by this process. A session whose coordinator died
            //    could then never be settled by anything, which is the wedge F2
            //    and F5 exist to prevent.
            //  • An opener TOKEN (minted at open, presented at settle) is
            //    strictly stronger and needs a column to hold its hash plus a
            //    channel to carry it. It buys protection against a compromised
            //    opener, which is not the threat here — the opener is the party
            //    the covenant already trusts with this session.
            //
            // So: the settler must be the actor that opened it. That fact is
            // already durable and needs no migration — `sessions.opened_by_event_id`
            // names the `session_opened` row, and `core_events.actor_id` is the
            // trusted actor it was appended under (never a client-supplied
            // field). Read under the append lock, `for('share')` on the session
            // row so it cannot exit underneath the check.
            const [owned] = await tx
              .select({
                status: sessions.status,
                openerId: coreEvents.actorId,
                openedByEventId: sessions.openedByEventId,
              })
              .from(sessions)
              .leftJoin(coreEvents, eq(coreEvents.id, sessions.openedByEventId))
              .where(and(eq(sessions.id, command.sessionId), eq(sessions.roomId, command.roomId)))
              .for('share', { of: sessions });
            if (!owned) {
              // Same shape `projectSessionExit` would produce, said earlier. A
              // settle of a session that is not here writes nothing either way.
              throw new CommandError(
                'invalid',
                `no session "${command.sessionId}" to settle in room "${command.roomId}" — it does not exist here`,
              );
            }
            if (owned.openedByEventId === null || owned.openerId === null) {
              // A session with no recorded opener has no party authorized to
              // settle it. Fail CLOSED: the alternative is that the one row that
              // cannot name its owner is settleable by anybody.
              throw new CommandError('invalid', sessionSettleRefusal(command.sessionId));
            }
            if (owned.openerId !== session.userId) {
              throw new CommandError('invalid', sessionSettleRefusal(command.sessionId));
            }

            // ── THE VERIFIED TUPLE IS THE APPENDED TUPLE (#120 round-3 F4) ────
            //
            // The verification used to run BEFORE `appendAndProject`, outside the
            // lock. A durable branch ref is mutable: between `verifyArtifact`
            // resolving the branch to commit C and the event being written, the
            // ref could be swapped to D or deleted, and the ledger would persist
            // a `{branch,commit}` tuple that no longer resolves — a receipt
            // pointing at nothing, indefinitely. Running it here closes that
            // window: the check and the append are the same critical section, so
            // what was verified is what is written.
            //
            // The verifier ALSO pins the commit behind an immutable
            // `refs/atrium/settled/<sessionId>` ref in the durable repo (see
            // `configure.ts`), which is the other half of F4: a later force-push
            // or branch delete can move the branch, but the object a receipt
            // indexes stays reachable and un-GC-able.
            //
            // Everything the previous round guaranteed still holds: the
            // caller-supplied `{branch,commit,remote}` is trusted ONLY if the
            // verifier — closed over the provider's own durable remote — confirms
            // it names an object the provider produced. Absent a verifier
            // (execution disabled: no artifact has a legitimate source) or on a
            // failed check, it is dropped to `null`.
            verifiedArtifact =
              command.artifact !== null &&
              verifyArtifact !== undefined &&
              (await verifyArtifact({ sessionId: command.sessionId, artifact: command.artifact }))
                ? command.artifact
                : null;
          },
        );
      }

      case 'raise_signal':
        return appendAndProject(session, command.roomId, ({ id, at }) => ({
          id,
          at,
          type: 'signal_raised',
          roomId: command.roomId,
          targetUserId: command.targetUserId,
          subjectKind: command.subjectKind,
          subjectId: command.subjectId,
          class: command.class,
          reason: command.reason,
        }));

      // The human-only spend-authorization (#118). The non-human refusal already
      // happened above, before the switch, in the same place a machine's certify
      // is refused. `projectPlanRlimitSet` is the only writer of `rlimit_slice`,
      // and it guards for an open plan in this room.
      case 'set_plan_rlimit':
        return appendAndProject(session, command.roomId, ({ id, at }) => ({
          id,
          at,
          type: 'plan_rlimit_set',
          roomId: command.roomId,
          planId: command.planId,
          slice: command.slice,
        }));

      // ── ephemeral: broadcast, never appended (#14) ─────────────────────────
      case 'set_presence':
        return {
          kind: 'presence',
          roomId: command.roomId,
          userId: session.userId,
          state: command.state,
          at: new Date().toISOString(),
        };

      case 'set_typing':
        return {
          kind: 'typing',
          roomId: command.roomId,
          userId: session.userId,
          typing: command.typing,
          at: new Date().toISOString(),
        };

      // ── per-user cursor: a row, but not room history ───────────────────────
      case 'advance_seen': {
        const head = await ledger.head(command.roomId);
        if (command.roomSeq > head) {
          throw new CommandError(
            'invalid',
            `cannot mark seen up to ${command.roomSeq}: room "${command.roomId}" is only at ${head}`,
          );
        }
        // GREATEST, so a cursor never goes backwards — two tabs racing must not
        // let the slower one un-read what the faster one read.
        //
        // The head check above is a courtesy that produces a good error message;
        // the database enforces the same bound with a trigger, which is what
        // holds if the room's head moves between the two statements or if the
        // writer is not this code path at all.
        //
        // The statement itself is `@atrium/auth`'s `advanceSeenSeq`. It used to
        // be written out here over `memberships`, which made this file one of
        // the two places under `apps/` that could reach room membership
        // directly — the boundary `packages/auth/test/room-access.test.ts`
        // asserts and the merge re-opened. The clamp and the error mapping are
        // this command's business and stay here; the table is not.
        const updated = await advanceSeenSeq(db, command.roomId, session.userId, command.roomSeq)
          .then((row) => (row ? [row] : []))
          .catch((error: unknown) => {
            if (describeCause(error).includes('memberships_seen_seq_within_room_head')) {
              throw new CommandError(
                'invalid',
                `cannot mark seen up to ${command.roomSeq}: room "${command.roomId}" does not have that many events`,
              );
            }
            throw error;
          });
        const row = updated[0];
        if (!row) {
          // Nothing matched, so nothing moved (r1, major 5). Round 1 fell back
          // to the membership row read at the top of this function and reported
          // success, which tells the client its cursor advanced when the
          // database says otherwise — and the client then renders a "since you
          // left" divider that will jump backwards on its next reconnect. The
          // only way to match nothing here is for the membership to have been
          // revoked since the check above, so that is what this says.
          throw new CommandError(
            'not_a_member',
            `the read cursor for room "${command.roomId}" was not advanced: no membership row to advance (it was revoked while this command was in flight)`,
          );
        }
        return {
          kind: 'seen',
          roomId: command.roomId,
          userId: session.userId,
          seenSeq: Number(row.seenSeq),
        };
      }

      default: {
        const exhaustive: never = command;
        throw new CommandError('invalid', `unknown command ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return {
    execute,
    requireMembership,
    stillMembers: (pairs) => authorizer.present(pairs),
  };
}

/**
 * Every message and constraint name down a driver error's cause chain.
 *
 * Drizzle wraps the postgres-js error, so the constraint name that says *which*
 * rule refused the statement is two levels down. Matching on the wrapper's text
 * would match any failure at all.
 */
function describeCause(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const pg = current as Error & { constraint_name?: string; constraint?: string };
    parts.push(current.message, pg.constraint_name ?? '', pg.constraint ?? '');
    current = current.cause;
  }
  return parts.join(' | ');
}

/**
 * A draft becomes a proposal at the position the ledger assigned it: the server
 * mints the id and the timestamp, so a client cannot choose either. `status` is
 * not taken from the caller at all — the reducer would coerce it back to
 * `proposed` and record the coercion, and offering a field whose value is
 * always overridden invites someone to believe it.
 *
 * ## The proposer is the session, not a parameter (#22 r8, completed by r9)
 *
 * `proposer` looked like part of "the reading", which the caller supplies. It is
 * not: `acceptance.ts:381-399` reads `proposal.proposer.userId` to decide whether
 * a commitment is `self` or `third_party`, and therefore whether it waits for the
 * named owner to confirm. The rule that check exists for is #4's — *nobody gets
 * committed by someone else's sentence* — and until r8 its input was a field the
 * sentence's author wrote. A member could stage `proposer: {kind:'human', userId:
 * <victim>}` on a commitment owned by that victim: `staged === attributedTo`, so
 * it classified as `self`, and the confirmation the rule exists to demand was
 * never asked for.
 *
 * r8 fixed the human branch and left the model branch passing through as written,
 * because "`record_proposal` is the seam #21's interpretation pipeline calls".
 * **That justification named a caller that does not exist.** The seam is exposed
 * on the participant socket, so the only thing that ever reached the model branch
 * was a participant writing it by hand — and r9's gauntlet did: a member staged a
 * `commitment` naming a colleague as owner, marked `proposer: {kind:'model',
 * model:'claude-opus-4.6'}, confidence: 1`, with a quote that appears in no cited
 * message, then accepted it himself. Both commands acked with `issues: []`.
 * `@atrium/core`'s "a model reading must cite messages and quote them" bounded
 * nothing, because *citing* is not *matching* and the only thing that matches a
 * quote against a message is the receipt gate — which a human acceptance skips.
 *
 * So the field is gone. Every proposal staged over a socket is a human proposal
 * by the session's own user, derived exactly as `actorOf` derives the trusted
 * actor. There is no value for a client to send, so there is nothing to refuse
 * and nothing for a mismatch message to leak.
 *
 * That closes today's door and not the class — a member could no longer *write*
 * the model attribution, but the day #21's pipeline lands and this seam has a
 * legitimate model-staging caller again, the same acceptance would be available
 * to whoever can reach it. The class is closed one layer down, by
 * `selfStagedReadingRefusal` in `@atrium/core`: a machine-attributed reading
 * needs a human other than its stager to accept it, and `ProposalRecord.stagedBy`
 * is what makes that answerable. Neither half is sufficient alone; see the note
 * on that function.
 *
 * ## And how an agent session is attributed — #117
 *
 * The two acceptance-semantics questions the old refusal named — does the
 * reading need a receipt window checked against the messages it cites (`:663`),
 * does θ apply (`:828`) — are answered by #117, and the answer is that an agent
 * proposer is a MACHINE proposer. It takes the model path in `@atrium/core`:
 * receipt window checked, θ applied, a commitment naming somebody else waits for
 * that person. So an agent session's reading is recorded as its own — `proposer:
 * {kind:'agent', userId}` — rather than either refused or laundered into a
 * person's. Recording it as a human's was the r9 defect (a machine's reading
 * stored as a person's, skipping the receipt gate a human acceptance skips);
 * recording it as an agent's is the honest attribution, and the receipt gate is
 * NOT skipped, because a machine acceptance runs it.
 *
 * What did NOT move is the certification boundary. `record_proposal` is
 * participation (`certificationClassOf` → `open`), so an agent may stage a `~`;
 * every certification-class command stays refused for a non-human one door up
 * (the covenant gate in `execute`) and again in the reducer's `isHuman` gates.
 * The machine drafts `~`; only a human certifies `✓`. `actorMatchesProposer` in
 * `@atrium/core` is the other end that moved with this: an agent now matches the
 * reading it staged, exactly as a model matches its own.
 */
function draftToProposal(
  draft: ProposalDraft,
  roomId: string,
  at: string,
  session: Session,
): Proposal {
  // Derived from the session's own principal kind, never from the payload —
  // exactly as `actorOf` derives the trusted actor. A human session stages a
  // human proposal; an agent session (#117) stages an agent proposal under its
  // own user id. `PrincipalKind` is `'human' | 'agent'`, so these are the only
  // two, and both carry the id off the session.
  const proposer: Proposal['proposer'] =
    session.principalKind === 'agent'
      ? { kind: 'agent', userId: session.userId }
      : { kind: 'human', userId: session.userId };
  return {
    id: randomUUID(),
    roomId,
    type: draft.type,
    payload: draft.payload,
    confidence: draft.confidence,
    proposer,
    provenance: draft.provenance,
    quote: draft.quote,
    interpretationId: draft.interpretationId,
    status: 'proposed',
    createdAt: at,
  } as Proposal;
}

/**
 * The object an acceptance mints, carrying the proposal's provenance forward.
 *
 * Exported for the interpretation worker (#23), which accepts through the same
 * ledger this layer does and must mint the same object from the same proposal.
 * A second copy of this mapping in `jobs/interpret.ts` would be a second answer
 * to "what does accepting this proposal produce", free to disagree the first
 * time either side gained a field.
 */
export function objectFromProposal(
  proposal: Proposal | Omit<Proposal, 'status'>,
  objectiveId: string | null,
  at: string,
): AcceptedObject {
  return {
    id: randomUUID(),
    roomId: proposal.roomId,
    type: proposal.type,
    payload: proposal.payload,
    objectiveId,
    provenance: {
      messageIds: proposal.provenance,
      proposalId: proposal.id,
      interpretationId: proposal.interpretationId,
    },
    createdAt: at,
    updatedAt: at,
  } as AcceptedObject;
}
