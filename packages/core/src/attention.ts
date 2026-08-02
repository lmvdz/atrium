import { z } from 'zod';
import { type AcceptanceDecision, decideAcceptance } from './acceptance.js';
import { Id, Timestamp } from './common.js';
import type { ProvenanceMessage } from './escalation.js';
import { hasContent } from './matching.js';
import { type AcceptedObject, AcceptedObjectType, payloadText } from './objects.js';
import type { AcceptanceConfig } from './policy.js';
import type { StoredProposal } from './proposal.js';
import type { CoreState, ObjectRecord } from './state.js';

/**
 * Attention items are a *projection*, never source truth (issue #3). They are
 * stored so the UI can page them, but they are always recomputable from the
 * accepted-object graph.
 *
 * A rationale is required by design: an attention item that cannot say why it
 * needs this person specifically is not allowed to exist (research brief,
 * concept 8). What is *stored* is the structured reason; the sentence is
 * rendered from it. See `RationaleReason`.
 */
export const AttentionClass = z.enum([
  'needs_decision',
  'owned_commitment',
  'mention',
  'blocking_question',
]);
export type AttentionClass = z.infer<typeof AttentionClass>;

export const AttentionStatus = z.enum(['pending', 'resolved', 'dismissed']);
export type AttentionStatus = z.infer<typeof AttentionStatus>;

/**
 * What the item is about.
 *
 * Almost always an accepted object. `needs_decision` is the exception and has to
 * be: a decision never auto-accepts, so at the moment somebody needs to rule on
 * one there is no object yet — the thing waiting is the *proposal*. Pointing
 * the item at a not-yet-existent object id, or inventing a placeholder object,
 * would both be worse than saying which kind of thing this is.
 *
 * **No default.** It carried `.default('object')` in round 1, which is a footgun
 * with #22's polymorphic subject column behind it: an item read back from a
 * store that forgot the column would parse cleanly as an object-subject item and
 * point its foreign key at a proposal id. A field whose wrong value is
 * unfalsifiable does not get a default.
 *
 * (Noted for #22: `attention_items.object_id` is a foreign key onto
 * `accepted_objects`, so persisting a proposal-subject item needs that column to
 * become polymorphic. Core is the layer that discovered it; the migration is not
 * this ticket's.)
 */
export const AttentionSubjectKind = z.enum(['object', 'proposal']);
export type AttentionSubjectKind = z.infer<typeof AttentionSubjectKind>;

/* ─────────────────────────────────────────────────────────────────────────
 * Rationale — structured, and rendered from trusted templates
 * ───────────────────────────────────────────────────────────────────────── */

declare const rationaleBrand: unique symbol;

/**
 * A rendered rationale.
 *
 * Branded, so a bare string cannot be passed off as one. Round 1's gauntlet
 * found the brand did not bind at runtime — the persisted field was
 * `z.string().min(1)`, so anything non-empty that came back from a store, or in
 * from an API, was a rationale as far as the schema was concerned, and the
 * "only one producer" argument held only for code that went through the
 * producer.
 *
 * So the string is no longer the thing that is stored. `AttentionItem.reason` is
 * a discriminated union with no free text in it except the object's own words,
 * and the sentence is rendered from it by `rationaleFor` — the only producer,
 * whose first argument is the person's id. "Why you specifically" is a
 * constructor argument, and now it is one at runtime too: an attention item
 * cannot carry a reason that is not one of the eight the product has.
 */
export type Rationale = string & { readonly [rationaleBrand]: true };

/**
 * Why an item was raised, as data.
 *
 * Every variant carries only what the template interpolates, and the free-text
 * fields are quotations of the room's own objects — a statement, a question, the
 * request a mention carried. Nothing here is a sentence somebody wrote for the
 * UI to display, which is the property that makes rendering safe: the template
 * is in this file, under review, and a caller cannot substitute its own.
 */
export const RationaleReason = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('decision_pending'),
    statement: z.string().min(1),
    assigned: z.boolean(),
  }),
  z.object({
    kind: z.literal('commitment_overdue'),
    statement: z.string().min(1),
    due: Timestamp,
    now: Timestamp,
  }),
  z.object({
    kind: z.literal('commitment_open'),
    statement: z.string().min(1),
    due: Timestamp.nullable().default(null),
  }),
  z.object({ kind: z.literal('commitment_confirm'), statement: z.string().min(1) }),
  /**
   * **r9.** A commitment the engine staged for its *own* owner — the self-stated
   * shape, which since r5 never auto-accepts and until r9 raised nothing at all.
   *
   * A separate variant rather than a reuse of `commitment_confirm`, because that
   * one's sentence is *"somebody else's message named you as the owner of this,
   * and nobody gets committed by someone else's sentence"* — which is false here
   * and false in the direction that matters. An item that tells you a colleague
   * put your name on your own words is a rationale that misrepresents the room
   * to the person being asked, and a rationale that cannot say truthfully why
   * this person specifically is the thing this union exists to make impossible.
   */
  z.object({ kind: z.literal('commitment_self_stated'), statement: z.string().min(1) }),
  z.object({
    kind: z.literal('question_blocks_commitment'),
    question: z.string().min(1),
    commitment: z.string().min(1),
  }),
  z.object({
    kind: z.literal('question_blocks_objective'),
    question: z.string().min(1),
    objective: z.string().min(1),
  }),
  z.object({ kind: z.literal('question_names_you'), question: z.string().min(1) }),
  z.object({ kind: z.literal('mention'), request: z.string().min(1) }),
  /**
   * **r8.** A model reading that the engine staged for a person rather than
   * accepting — today that is `type_not_certified`, whose refusal text promises
   * this panel by name. It is not `decision_pending`: nobody is being asked to
   * settle the underlying question, they are being asked what kind of act these
   * words were, and a rationale that said "you are named as the one to decide
   * this" about a claim would be false about both halves.
   */
  z.object({
    kind: z.literal('reading_pending'),
    statement: z.string().min(1),
    proposedType: AcceptedObjectType,
  }),
]);
export type RationaleReason = z.infer<typeof RationaleReason>;

export const AttentionItem = z.object({
  id: Id,
  roomId: Id,
  userId: Id,
  /** The accepted object, or the staged proposal — see `subjectKind`. */
  objectId: Id,
  subjectKind: AttentionSubjectKind,
  class: AttentionClass,
  /** Why this person specifically, as data. Rendered by `rationaleFor`. */
  reason: RationaleReason,
  status: AttentionStatus.default('pending'),
  createdAt: Timestamp,
});
export type AttentionItem = z.infer<typeof AttentionItem>;
export type AttentionItemInput = z.input<typeof AttentionItem>;

/**
 * The only producer of a `Rationale`.
 *
 * Every branch names the user and states the reason, in that order, because
 * that is the sentence the UI shows and the order it reads in: "needs you — you
 * own the migration commitment this question blocks".
 */
export function rationaleFor(userId: Id, reason: RationaleReason): Rationale {
  const you = `@${userId}`;
  switch (reason.kind) {
    case 'decision_pending':
      return (
        reason.assigned
          ? `${you} — you are named as the one to decide this, and it is still open: "${clip(reason.statement)}". A decision is never accepted by inference; it waits for you.`
          : `${you} — nobody is named on this decision, so any member of the room can settle it: "${clip(reason.statement)}". A decision is never accepted by inference; it waits for a person.`
      ) as Rationale;
    case 'commitment_overdue':
      return `${you} — you own this commitment and it was due ${reason.due}, which has passed as of ${reason.now}: "${clip(reason.statement)}".` as Rationale;
    case 'commitment_open':
      return `${you} — you own this commitment${reason.due ? `, due ${reason.due}` : ''}: "${clip(reason.statement)}".` as Rationale;
    case 'commitment_confirm':
      return `${you} — somebody else's message named you as the owner of this, and nobody gets committed by someone else's sentence. Confirm it or decline it: "${clip(reason.statement)}".` as Rationale;
    case 'commitment_self_stated':
      return `${you} — this is staged as a commitment of yours, and a commitment is never accepted by inference however plainly it reads. Confirm it or decline it: "${clip(reason.statement)}".` as Rationale;
    case 'question_blocks_commitment':
      return `${you} — you own the commitment this open question blocks ("${clip(reason.commitment)}"), so it is your answer that unblocks it: "${clip(reason.question)}".` as Rationale;
    case 'question_blocks_objective':
      return `${you} — this open question blocks the objective "${clip(reason.objective)}", which nobody owns, so any member of the room can unblock it: "${clip(reason.question)}".` as Rationale;
    case 'question_names_you':
      return `${you} — this open question names you: "${clip(reason.question)}".` as Rationale;
    case 'mention':
      return `${you} — you were named in a message that asks you something: "${clip(reason.request)}".` as Rationale;
    case 'reading_pending':
      return `${you} — a machine read this as a ${reason.proposedType} and nothing in the words settles that it was one, so it is staged rather than accepted and any member of the room can file it or decline it: "${clip(reason.statement)}".` as Rationale;
    default: {
      const exhaustive: never = reason;
      return `${you} — ${JSON.stringify(exhaustive)}` as Rationale;
    }
  }
}

/** The sentence for a stored item. The one way to get text out of one. */
export function renderRationale(item: Pick<AttentionItem, 'userId' | 'reason'>): Rationale {
  return rationaleFor(item.userId, item.reason);
}

function clip(text: string, limit = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Priority — #6's sort, made data
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Hardest-first, per #6: *"needs_decision > overdue commitments >
 * blocking_question > confirms > mentions — owed attention sorts above
 * everything and never hides in a fold."*
 *
 * Six tiers for four classes, because `owned_commitment` splits three ways in
 * that sentence: an overdue commitment outranks a blocking question, a confirm
 * sits below one, and an ordinary open commitment is named in neither half. It
 * goes below confirms and above mentions — a confirm is a question aimed at you
 * that nobody else can answer, an open commitment is work you already agreed to
 * and have not been asked about again.
 */
export const ATTENTION_PRIORITY = Object.freeze({
  needs_decision: 0,
  commitment_overdue: 1,
  blocking_question: 2,
  commitment_confirm: 3,
  commitment_open: 4,
  mention: 5,
});

export type AttentionPriority = (typeof ATTENTION_PRIORITY)[keyof typeof ATTENTION_PRIORITY];

/**
 * A freshly computed item. `priority` is derived, not persisted: the projection
 * is recomputable by definition (#3), so re-deriving it costs nothing and
 * storing it would give the sort two sources that can disagree.
 */
export interface ComputedAttentionItem extends AttentionItem {
  priority: number;
}

/** Hardest first; ties broken deterministically so two callers agree. */
export function sortAttention<T extends AttentionItem & { priority?: number }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => {
    const pa = a.priority ?? fallbackPriority(a.class);
    const pb = b.priority ?? fallbackPriority(b.class);
    if (pa !== pb) return pa - pb;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * For items read back from storage, which carry a class but no priority.
 *
 * **The exhaustive branch returns a number, r8.** It read
 * `Number.MAX_SAFE_INTEGER + (exhaustive as unknown as number)`, which is
 * `MAX_SAFE_INTEGER + NaN` — `NaN` — for any class outside the enum. `pa - pb`
 * is then `NaN`, a comparator that returns `NaN` is not an ordering, and the
 * item sorted **above `needs_decision`**: an unrecognised class took the top of
 * somebody's Needs-you, which is the exact opposite of what a fail-safe default
 * for an unknown class should do. The arithmetic was there to make the
 * unreachable branch use `exhaustive`; it made it wrong instead.
 *
 * Reachable, despite the `never`: `AttentionItem` is parsed at the boundary but
 * `sortAttention` is exported and takes anything shaped like one, and a store
 * written by an older or newer version of this package is exactly where a
 * fifth class comes from.
 */
function fallbackPriority(attentionClass: AttentionClass): number {
  switch (attentionClass) {
    case 'needs_decision':
      return ATTENTION_PRIORITY.needs_decision;
    case 'owned_commitment':
      return ATTENTION_PRIORITY.commitment_open;
    case 'blocking_question':
      return ATTENTION_PRIORITY.blocking_question;
    case 'mention':
      return ATTENTION_PRIORITY.mention;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * **An item id that cannot be forged out of its own components — r8.**
 *
 * The id was `attn:${userId}:${subjectId}:${class}` interpolated raw, and `Id` is
 * `z.string().min(1)` with no charset restriction. A user id of
 * `alice:obj_7:mention` collides with the mention item for `alice` on `obj_7`,
 * and a proposal whose id equals an accepted object's id collides across the two
 * sources that build `owned_commitment` items. A colliding id is not a cosmetic
 * problem here: `reconcileAttention` keys on it, so one item inherits the other's
 * dismissal, or replaces it in the panel outright.
 *
 * Two changes: the separator is escaped in every component, so no component
 * content can imitate the structure; and `subjectKind` is part of the id, so the
 * proposal namespace and the object namespace cannot meet.
 */
function itemId(userId: Id, subjectKind: AttentionSubjectKind, subjectId: Id, cls: string): string {
  return `attn:${escapeIdPart(userId)}:${subjectKind}:${escapeIdPart(subjectId)}:${cls}`;
}

function escapeIdPart(value: string): string {
  return value.replace(/%/g, '%25').replace(/:/g, '%3A');
}

/**
 * **One subject a cycle reached a conclusion about**, and the whole of what
 * `reconcileAttention` is allowed to treat as "computed and found done".
 *
 * The key is the item id with the *person* taken out — an item is
 * `(user, subjectKind, subject, class)` and a source decides about
 * `(subjectKind, subject, class)` for everyone at once. A commitment whose owner
 * was amended is one examination that resolves the old owner's item and raises
 * the new one, which is the behaviour rule 2 already had for the case it could
 * see.
 */
export interface ExaminedSubject {
  class: AttentionClass;
  subjectKind: AttentionSubjectKind;
  subjectId: Id;
}

function examinedKey(entry: {
  class: AttentionClass;
  subjectKind: AttentionSubjectKind;
  subjectId: Id;
}): string {
  return `${entry.class}:${entry.subjectKind}:${escapeIdPart(entry.subjectId)}`;
}

/**
 * What one source of the projection produced — **items, refusals and
 * examinations together**, because a source that reports one of the three
 * without the others is how absence stops being distinguishable from silence.
 *
 * All three are required rather than optional for the reason `NeedsYouOutcome`
 * is a type: the next source added to `projectAttention` cannot forget to say
 * what it looked at, because `tsc` will not let it return without saying.
 */
interface AttentionSource {
  items: ComputedAttentionItem[];
  refusals: AttentionRefusal[];
  examined: ExaminedSubject[];
}

/* ─────────────────────────────────────────────────────────────────────────
 * Computation
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * A mention, decided upstream.
 *
 * #6 is explicit that a mention is "a direct reference carrying a request or
 * question, **not** bare name-drops", and that judgement needs the message body,
 * which this package deliberately never sees. The interpretation pipeline makes
 * the call and hands the result down; core does the routing, the rationale and
 * the sort. A caller that passes every `@name` it finds will get a Needs-you
 * full of noise, and that is the caller's bug, not this function's.
 */
export interface MentionSignal {
  roomId: Id;
  /** The object the mention is attached to. */
  objectId: Id;
  userId: Id;
  /** What is being asked of them, verbatim enough to quote. */
  request: string;
}

/** An open question that names a person, decided upstream for the same reason. */
export interface QuestionMentionSignal {
  questionObjectId: Id;
  userId: Id;
}

export interface AttentionContext {
  /** Used only to date the items and to decide what is overdue. */
  now: Timestamp;
  /**
   * Room membership, `roomId → user ids`. Needed for the "or any-member when
   * unassigned" half of #6's `needs_decision`: an unowned decision fans out to
   * everyone, because a decision nobody is asked about is a decision nobody
   * makes.
   *
   * **Omitting it is no longer silent — r9.** This docblock used to end *"without
   * it, unassigned decisions produce no items at all — stated here so the silence
   * is a known consequence rather than a mystery"*, and a known silence is still
   * a panel with a decision missing from it. Every proposal it starves now
   * appears in `AttentionProjection.refusals` naming the room whose roster is
   * missing. Documenting a hole is not the same as closing it, and the field
   * that could be read to say otherwise was load-bearing in the wrong direction.
   */
  members?: Readonly<Record<Id, readonly Id[]>>;
  /**
   * The window's messages — the same input `decideAcceptance` takes, because
   * every proposal-derived item here *is* an acceptance decision.
   *
   * Round 1's gauntlet: the confirm path fail-opened without message authorship,
   * so every staged commitment read as third-party and everybody named in one
   * got a confirm they never needed to be asked for. It refuses now: a proposal
   * whose messages are not supplied raises nothing and is reported in
   * `AttentionProjection.refusals`.
   */
  messages?: readonly ProvenanceMessage[];
  /** The θ table to judge proposals by. Defaults to the product's. */
  config?: AcceptanceConfig;
  mentions?: readonly MentionSignal[];
  questionMentions?: readonly QuestionMentionSignal[];
}

/** A proposal the projection declined to judge, and why. */
export interface AttentionRefusal {
  proposalId: Id;
  reason: string;
}

export interface AttentionProjection {
  items: ComputedAttentionItem[];
  /**
   * Proposals that could have raised an item and were not judged, because a
   * required input was missing. Empty in normal operation; non-empty means a
   * caller is asking for a projection it has not supplied the evidence for, and
   * the honest answer to that is silence *plus a receipt for the silence*.
   */
  refusals: AttentionRefusal[];
  /**
   * **Every subject this cycle actually reached a conclusion about** — the
   * evidence `reconcileAttention` needs before it may read a missing item as a
   * finished one. See `ExaminedSubject` and rule 2.
   *
   * A subject is in here when the source that owns it looked at it and decided
   * no item was owed. It is *not* in here when the source could not decide: a
   * proposal that was refused, a mention nobody supplied a signal for. Absence
   * from this list is the difference between "done" and "the cycle went blind",
   * which is the distinction r10 exists to restore.
   */
  examined: ExaminedSubject[];
}

/**
 * The attention projection: #6's four classes, computed from state.
 *
 * Deterministic and total. Output is sorted hardest-first with a fully specified
 * tiebreak, so two nodes computing it from the same state produce identical
 * bytes — the same property the reducer has, for the same reason.
 *
 * **Proposal-derived items ask `decideAcceptance`.** They used to apply their
 * own reading of θ, and round 1's gauntlet found the two disagreeing in both
 * directions: below θ_min the engine discarded a commitment while the panel
 * still asked its owner to confirm one, and inside the θ band the engine stayed
 * quiet while the panel raised a Needs-you. One source of truth now — if the
 * engine would not surface it, the panel does not raise it.
 */
export function projectAttention(
  state: CoreState,
  context: AttentionContext | Timestamp,
): AttentionProjection {
  const ctx: AttentionContext = typeof context === 'string' ? { now: context } : context;
  const sources: readonly AttentionSource[] = [
    proposalItems(state, ctx),
    commitmentItems(state, ctx),
    blockingQuestionItems(state, ctx),
    mentionItems(ctx),
  ];

  return {
    items: sortAttention(sources.flatMap((source) => source.items)),
    refusals: sources.flatMap((source) => source.refusals),
    examined: sources.flatMap((source) => source.examined),
  };
}

/** `projectAttention`, when the caller only wants the panel. */
export function computeAttention(
  state: CoreState,
  context: AttentionContext | Timestamp,
): ComputedAttentionItem[] {
  return projectAttention(state, context).items;
}

/** Live means: accepted, not retracted, not superseded. */
function isLive(record: ObjectRecord | undefined): record is ObjectRecord {
  return !!record && record.retractedAt === null && record.supersededById === null;
}

function item(
  input: Omit<ComputedAttentionItem, 'status' | 'reason'> & { reason: RationaleReason },
): ComputedAttentionItem {
  return { ...input, status: 'pending' };
}

/**
 * **What a `needs_you` proposal owes the panel — r9, and it is a type rather
 * than a rule of thumb.**
 *
 * The requirement: *no proposal whose verdict is `needs_you` may leave
 * `proposalItems` without producing either an attention item or a refusal.*
 *
 * It is a type because it had to be. The same defect has now shipped three
 * times, in three different branches, each one a `continue` that fired before
 * anything counted what it had produced:
 *
 *  - **r7** — a `type_not_certified` claim, dropped by a guard that let only
 *    decisions and commitments past.
 *  - **r8** — fixed that one by appending a fallthrough *below* the two
 *    type-specific branches, and left both of them `continue`ing above it.
 *  - **r9** — the two it left: a self-stated commitment (`awaitingConfirmFrom`
 *    is null, so the branch dropped it) and an unassigned decision with no
 *    member list (the audience is empty, so the loop pushed nothing).
 *
 * Three patches to the same hole is the signal that the hole is the shape of the
 * code and not of any one branch. So the branches no longer `push` and
 * `continue`; each **returns** one of these, and the affirmative arm carries a
 * *non-empty* tuple. A branch that ends up with nobody to ask cannot return an
 * empty list — `tsc` refuses it — so it has to say so out loud, which is what
 * `refuse` is. Same move as r8's `ReceiptText` brand, one level up: the thing
 * that must not happen stops being a thing to remember.
 *
 * A refusal is a legitimate outcome, not a consolation prize. The loop already
 * refuses `missing_message_context` and `receipt_not_certifiable` with a reason
 * a person can read, and "nobody in this room can be asked about this" is the
 * same kind of fact. What is not legitimate is silence.
 */
type NeedsYouOutcome =
  | { kind: 'raise'; items: readonly [ComputedAttentionItem, ...ComputedAttentionItem[]] }
  | { kind: 'refuse'; reason: string };

/**
 * The only constructor of a `raise`, and therefore the only way to satisfy the
 * type above with a fanout whose size is decided at runtime.
 *
 * It takes the refusal reason as an argument rather than inventing one, because
 * *why there was nobody to ask* is knowledge the branch has and this function
 * does not.
 */
function raiseOrRefuse(
  items: readonly ComputedAttentionItem[],
  reasonIfNobody: string,
): NeedsYouOutcome {
  const [first, ...rest] = items;
  return first === undefined
    ? { kind: 'refuse', reason: reasonIfNobody }
    : { kind: 'raise', items: [first, ...rest] };
}

/**
 * Everything a staged proposal raises: `needs_decision`, and the two
 * confirm shapes of `owned_commitment`.
 *
 * Both go through `decideAcceptance`, so the panel and the engine cannot
 * disagree about what a proposal in the θ band means — and so a proposal the
 * engine cannot judge (no messages) raises nothing rather than raising
 * everything.
 */
function proposalItems(state: CoreState, ctx: AttentionContext): AttentionSource {
  const out: ComputedAttentionItem[] = [];
  const refusals: AttentionRefusal[] = [];
  const examined: ExaminedSubject[] = [];
  /**
   * A proposal raises exactly one class, decided by its type — the same split
   * `needsYouOutcome` makes. Named here so "what this source could have raised
   * about this subject" and "what it did raise" are one fact.
   */
  const classOf = (type: AcceptedObjectType): AttentionClass =>
    type === 'commitment' ? 'owned_commitment' : 'needs_decision';
  const conclude = (proposal: StoredProposal): void => {
    examined.push({
      class: classOf(proposal.type),
      subjectKind: 'proposal',
      subjectId: proposal.id,
    });
  };

  for (const proposalId of Object.keys(state.proposals).sort()) {
    const record = state.proposals[proposalId];
    if (record === undefined) continue;
    if (record.status !== 'proposed') {
      // Accepted, rejected or superseded: the cycle looked at this proposal and
      // it is settled. That is a conclusion, and it is the ordinary way a
      // `needs_decision` item stops being owed.
      conclude(record.proposal);
      continue;
    }
    const { proposal } = record;

    const verdict = decideAcceptance(proposal, {
      messages: ctx.messages as readonly ProvenanceMessage[],
      ...(ctx.config ? { config: ctx.config } : {}),
    });
    if (verdict.rule === 'missing_message_context') {
      refusals.push({
        proposalId: proposal.id,
        reason:
          'no message window was supplied, so this proposal could not be judged — raising it anyway would ask somebody to confirm a commitment nobody can show they were named in',
      });
      continue;
    }
    // A receipt the engine declines to rule on silences the panel too, and the
    // silence gets a receipt of its own. Round 3's gauntlet is the case: the
    // quote carries the whole statement and says more, so the extra words may be
    // "not" — asking somebody to confirm a commitment that may be the negation of
    // what they wrote is worse than asking them nothing.
    if (verdict.rule === 'receipt_not_certifiable') {
      refusals.push({ proposalId: proposal.id, reason: verdict.reason });
      continue;
    }
    // The one `continue` that owes nothing *in items*: `accepted`, `quiet` and
    // `none` are the engine saying this proposal is not anybody's turn. It owes
    // an examination, though — this is the branch that carries "the commitment
    // closed, the question got answered" for a proposal, and rule 2 cannot fire
    // for a subject nobody says was looked at.
    if (verdict.visibility !== 'needs_you') {
      conclude(proposal);
      continue;
    }

    const outcome = needsYouOutcome(proposal, verdict, ctx);
    if (outcome.kind === 'refuse') {
      refusals.push({ proposalId: proposal.id, reason: outcome.reason });
      continue;
    }
    conclude(proposal);
    out.push(...outcome.items);
  }

  return { items: out, refusals, examined };
}

/**
 * Who a `needs_you` proposal goes in front of, per type — **total, by return
 * type**.
 *
 * Every arm ends in a `NeedsYouOutcome`, so the compiler is what keeps the next
 * type-specific branch from doing what the last three did.
 */
function needsYouOutcome(
  proposal: StoredProposal,
  verdict: AcceptanceDecision,
  ctx: AttentionContext,
): NeedsYouOutcome {
  const room = [...(ctx.members?.[proposal.roomId] ?? [])].sort();

  if (proposal.type === 'decision') {
    const statement = proposal.payload.statement;
    const named = proposal.payload.decidedBy;
    const audience = named !== null ? [named] : room;
    // **r9's fourth instance, and the one the review did not name.** With
    // `decidedBy` null and no member list the audience was empty, the loop
    // pushed nothing, and it fell out silent — the documented consequence of
    // omitting `members`, which made it a known silence rather than an
    // acceptable one. A decision is never accepted by inference, so a decision
    // nobody is asked about stays staged forever; the projection now says that
    // instead of leaving the caller to notice.
    return raiseOrRefuse(
      audience.map((userId) =>
        item({
          id: itemId(userId, 'proposal', proposal.id, 'needs_decision'),
          roomId: proposal.roomId,
          userId,
          objectId: proposal.id,
          subjectKind: 'proposal',
          class: 'needs_decision',
          priority: ATTENTION_PRIORITY.needs_decision,
          createdAt: ctx.now,
          reason: { kind: 'decision_pending', statement, assigned: named !== null },
        }),
      ),
      `nobody is named as having decided this and no member list was supplied for room "${proposal.roomId}", so there is no one to put it in front of — a decision is never accepted by inference, so it stays staged until somebody is asked: "${clip(statement)}"`,
    );
  }

  if (proposal.type === 'commitment') {
    // This branch used to read: *"A commitment only asks anybody anything when
    // somebody else's sentence put their name on it — which is exactly
    // `awaitingConfirmFrom`."* That was true of the engine before r5, when a
    // self-stated commitment auto-accepted and there was nothing to ask. r5 put
    // commitment in the never-auto-accepts row, whose own reason text ends *"it
    // goes to Needs-you for a person to accept or decline"* — and the branch
    // above went on dropping every one of them, because `awaitingConfirmFrom` is
    // null unless somebody else's sentence is the one being confirmed.
    //
    // The person to ask is the owner. For the self-stated shape that is who
    // `commitmentAttribution` proved wrote the bearing message, and for the
    // human-staged shape it is who staged it about themselves; in both, nobody
    // else in the room has standing to say whether these words were an
    // undertaking. `awaitingConfirmFrom` still wins when it is set, because the
    // third-party case is a strictly stronger statement about *whose* confirm
    // this is.
    const owner = verdict.awaitingConfirmFrom ?? proposal.payload.owner;
    const statement = proposal.payload.statement;
    // The two are different questions and get different sentences.
    // `commitment_confirm` says *somebody else's message named you*, which is
    // false of a commitment you wrote yourself — a rationale that names the
    // wrong reason is the failure `RationaleReason` exists to prevent.
    const reason: RationaleReason =
      verdict.awaitingConfirmFrom !== null
        ? { kind: 'commitment_confirm', statement }
        : { kind: 'commitment_self_stated', statement };
    return raiseOrRefuse(
      hasContent(owner)
        ? [
            item({
              id: itemId(owner, 'proposal', proposal.id, 'owned_commitment'),
              roomId: proposal.roomId,
              userId: owner,
              objectId: proposal.id,
              subjectKind: 'proposal',
              class: 'owned_commitment',
              priority: ATTENTION_PRIORITY.commitment_confirm,
              createdAt: ctx.now,
              reason,
            }),
          ]
        : [],
      `no owner is named on this commitment, so there is nobody who can confirm or decline it — nobody gets committed by someone else's sentence, and nobody can be asked about one that names no one: "${clip(statement)}"`,
    );
  }

  // ── The other three types, and the promise that was not kept — r8 ──────────
  //
  // This loop began `if (proposal.type !== 'decision' && proposal.type !==
  // 'commitment') continue;`, which was true of the panel r7 inherited: those
  // were the only two types that could reach `needs_you`. r7 added
  // `type_not_certified`, whose refusal text ends *"so at 0.95 it goes to
  // Needs-you with its quote for a person to accept or decline"* — and the
  // adjudication that let the type narrowing ship rested on that sentence.
  //
  // Executed, the engine said `pending / needs_you` and `projectAttention`
  // returned **zero items and zero refusals**: a claim is not a decision and
  // not a commitment, so the line above dropped it before anything looked at
  // the verdict. The reading was staged in a panel nobody renders. A refusal
  // that names a destination is a promise, and this is the second one in this
  // round to have been painted on.
  //
  // The class is `needs_decision` because that is what is being asked — a
  // person decides whether these words were a claim or an undertaking — and
  // because inventing a fifth `AttentionClass` for it would push a schema
  // change through #22's storage to say the same thing. The audience is the
  // room, on the same argument an unassigned decision fans out: nothing in a
  // laundered reading names who should rule on it.
  //
  // **r9 closes the two holes r8 left in its own fallthrough**: an empty
  // `members` and a payload with no text both used to `continue` from here, the
  // first of them stated as a contract on the field and the second not stated
  // anywhere. Both are refusals now.
  const statement = payloadText(proposal.type, proposal.payload as Record<string, unknown>);
  if (statement.length === 0) {
    return {
      kind: 'refuse',
      reason: `a ${proposal.type} was staged for a person to rule on, but its payload carries no text — there is nothing to show anybody, and an attention item that cannot quote what it is about is not one`,
    };
  }
  return raiseOrRefuse(
    room.map((userId) =>
      item({
        id: itemId(userId, 'proposal', proposal.id, 'needs_decision'),
        roomId: proposal.roomId,
        userId,
        objectId: proposal.id,
        subjectKind: 'proposal',
        class: 'needs_decision',
        priority: ATTENTION_PRIORITY.needs_decision,
        createdAt: ctx.now,
        reason: { kind: 'reading_pending', statement, proposedType: proposal.type },
      }),
    ),
    `a machine read this as a ${proposal.type} and nothing in the words settles that it was one, so it is staged rather than accepted — but no member list was supplied for room "${proposal.roomId}", so there is nobody to put it in front of: "${clip(statement)}"`,
  );
}

/**
 * `owned_commitment` for objects: overdue, and open.
 *
 * The third shape — awaiting your confirm — comes from a *proposal* and lives in
 * `proposalItems`: a commitment somebody else's sentence put your name on is
 * staged, never accepted, until you say so (#4). It sorts above an ordinary open
 * commitment because it is a question, and below an overdue one because an
 * overdue commitment is already late.
 */
function commitmentItems(state: CoreState, ctx: AttentionContext): AttentionSource {
  const out: ComputedAttentionItem[] = [];
  // Every object in state, whether or not it raises anything: this source reads
  // nothing but state, so for a subject that is *in* state, "no item" is a
  // conclusion — the commitment closed, was retracted, was retyped. The
  // subjects it cannot conclude about are the ones a partial state does not
  // hold, and those are exactly the ones it does not list.
  const examined: ExaminedSubject[] = Object.keys(state.objects)
    .sort()
    .map((subjectId) => ({ class: 'owned_commitment', subjectKind: 'object', subjectId }));

  for (const objectId of Object.keys(state.objects).sort()) {
    const record = state.objects[objectId];
    if (!isLive(record)) continue;
    const { object } = record;
    if (object.type !== 'commitment' || object.payload.status !== 'open') continue;

    const { owner, due, statement } = object.payload;
    const overdue = due !== null && due < ctx.now;
    out.push(
      item({
        id: itemId(owner, 'object', object.id, 'owned_commitment'),
        roomId: object.roomId,
        userId: owner,
        objectId: object.id,
        subjectKind: 'object',
        class: 'owned_commitment',
        priority: overdue
          ? ATTENTION_PRIORITY.commitment_overdue
          : ATTENTION_PRIORITY.commitment_open,
        createdAt: ctx.now,
        reason: overdue
          ? { kind: 'commitment_overdue', statement, due: due as Timestamp, now: ctx.now }
          : { kind: 'commitment_open', statement, due },
      }),
    );
  }

  return { items: out, refusals: [], examined };
}

/**
 * `blocking_question` — an open question standing in front of somebody's work.
 *
 * Routed by what it blocks: a commitment routes to its owner, an objective has
 * no owner so it fans out to the room, and a question that names a person routes
 * to them whatever it blocks.
 */
function blockingQuestionItems(state: CoreState, ctx: AttentionContext): AttentionSource {
  const out: ComputedAttentionItem[] = [];
  const seen = new Set<string>();
  // Same argument as `commitmentItems` for the relation-driven half, which is
  // the one that answers "the question got answered". The `question_names_you`
  // half is caller-driven and shares this key, so it is covered by this
  // declaration too — see the residue note on `reconcileAttention`.
  const examined: ExaminedSubject[] = Object.keys(state.objects)
    .sort()
    .map((subjectId) => ({ class: 'blocking_question', subjectKind: 'object', subjectId }));

  const push = (userId: Id, question: ObjectRecord, reason: RationaleReason): void => {
    const id = itemId(userId, 'object', question.object.id, 'blocking_question');
    if (seen.has(id)) return;
    seen.add(id);
    out.push(
      item({
        id,
        roomId: question.object.roomId,
        userId,
        objectId: question.object.id,
        subjectKind: 'object',
        class: 'blocking_question',
        priority: ATTENTION_PRIORITY.blocking_question,
        createdAt: ctx.now,
        reason,
      }),
    );
  };

  const openQuestion = (id: Id): ObjectRecord | null => {
    const record = state.objects[id];
    if (!isLive(record)) return null;
    if (record.object.type !== 'open_question') return null;
    return record.object.payload.status === 'open' ? record : null;
  };

  // A question that names somebody is theirs whether or not it blocks anything —
  // #6: "…or names you".
  for (const signal of [...(ctx.questionMentions ?? [])].sort(compareQuestionMention)) {
    const question = openQuestion(signal.questionObjectId);
    if (question?.object.type !== 'open_question') continue;
    push(signal.userId, question, {
      kind: 'question_names_you',
      question: question.object.payload.question,
    });
  }

  const relations = [...state.relations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const relation of relations) {
    if (relation.kind !== 'blocks' || relation.to.kind !== 'object') continue;
    const question = openQuestion(relation.fromObjectId);
    if (question?.object.type !== 'open_question') continue;
    const blocked = state.objects[relation.to.objectId];
    if (!isLive(blocked)) continue;

    const questionText = question.object.payload.question;
    if (blocked.object.type === 'commitment') {
      const owner = blocked.object.payload.owner;
      push(owner, question, {
        kind: 'question_blocks_commitment',
        question: questionText,
        commitment: blocked.object.payload.statement,
      });
      continue;
    }
    if (blocked.object.type === 'objective') {
      const title = blocked.object.payload.title;
      for (const userId of [...(ctx.members?.[question.object.roomId] ?? [])].sort()) {
        push(userId, question, {
          kind: 'question_blocks_objective',
          question: questionText,
          objective: title,
        });
      }
    }
  }

  return { items: out, refusals: [], examined };
}

function compareQuestionMention(a: QuestionMentionSignal, b: QuestionMentionSignal): number {
  if (a.questionObjectId !== b.questionObjectId) {
    return a.questionObjectId < b.questionObjectId ? -1 : 1;
  }
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

/**
 * `mention` — a direct reference carrying a request, decided upstream.
 *
 * **Deduplicated, r8.** Every other source in this file guards its ids —
 * `blockingQuestionItems` has carried a `seen` set since it was written — and
 * this one did not. Two `MentionSignal`s naming the same person on the same
 * object (one message asking two things, or a caller that hands the same signal
 * in twice) produced **two items with the same id and different `reason` text**.
 * The projection's contract is that it is *"recomputable, byte for byte — the
 * same property the reducer has"*: two items with one id sort as a tie, ties
 * fall through to `id`, and a stable sort then hands back whichever order the
 * caller happened to supply them in. Two callers with the same state disagreed.
 *
 * The request is part of the sort key, so "which one survives" is a fact about
 * the signals rather than about their arrival order, and the first by that
 * ordering is the one kept.
 */
function mentionItems(ctx: AttentionContext): AttentionSource {
  // ── A signal-driven source can only conclude about what it was given — r10 ──
  //
  // This source reads no state at all. "No item for `obj_7`" therefore has two
  // readings — nobody was mentioned there, and nobody told this cycle about the
  // message that mentioned them — and the caller cannot mark the difference: an
  // ordinary sliding window that has moved past the mentioning message produces
  // the second while looking exactly like the first. So it declares an
  // examination only for a subject it was actually handed, which means a mention
  // item is never resolved by absence. It is resolved by the person, which is
  // what #6's one-click dismiss is for.
  const examined: ExaminedSubject[] = [];
  const signals = [...(ctx.mentions ?? [])].sort((a, b) => {
    if (a.objectId !== b.objectId) return a.objectId < b.objectId ? -1 : 1;
    if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
    return a.request < b.request ? -1 : a.request > b.request ? 1 : 0;
  });
  const out: ComputedAttentionItem[] = [];
  const seen = new Set<string>();
  for (const signal of signals) {
    const id = itemId(signal.userId, 'object', signal.objectId, 'mention');
    if (seen.has(id)) continue;
    seen.add(id);
    examined.push({ class: 'mention', subjectKind: 'object', subjectId: signal.objectId });
    out.push(
      item({
        id,
        roomId: signal.roomId,
        userId: signal.userId,
        objectId: signal.objectId,
        subjectKind: 'object',
        class: 'mention',
        priority: ATTENTION_PRIORITY.mention,
        createdAt: ctx.now,
        reason: { kind: 'mention', request: signal.request },
      }),
    );
  }
  return { items: out, refusals: [], examined };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Transitions
 * ───────────────────────────────────────────────────────────────────────── */

export type AttentionTransitionResult =
  | { ok: true; item: AttentionItem }
  | { ok: false; refusal: string };

/**
 * The only legal moves.
 *
 * `pending → resolved` (you acted on the underlying object), `pending →
 * dismissed` (#6's one-click dismiss, "allowed and recorded"). Nothing comes
 * back: an item that has been answered or waved away and then reappears is
 * indistinguishable from one that was never dealt with, and the room learns to
 * ignore the panel. When the *object* changes again, recomputation mints a new
 * item — that is the reopen path, and it is a new item on purpose.
 */
export function transitionAttention(
  attentionItem: AttentionItem,
  to: AttentionStatus,
): AttentionTransitionResult {
  if (attentionItem.status === to) {
    return { ok: true, item: attentionItem };
  }
  if (attentionItem.status !== 'pending') {
    return {
      ok: false,
      refusal: `attention item "${attentionItem.id}" is ${attentionItem.status} — a settled item never returns to the panel; acting on the object again mints a new one`,
    };
  }
  if (to === 'pending') {
    return {
      ok: false,
      refusal: `attention item "${attentionItem.id}" is already pending`,
    };
  }
  return { ok: true, item: { ...attentionItem, status: to } };
}

/** You acted on the underlying object. */
export function resolveAttention(attentionItem: AttentionItem): AttentionTransitionResult {
  return transitionAttention(attentionItem, 'resolved');
}

/** One-click dismiss — allowed, and recorded (#6). */
export function dismissAttention(attentionItem: AttentionItem): AttentionTransitionResult {
  return transitionAttention(attentionItem, 'dismissed');
}

/**
 * Fold a freshly computed list against what is already stored.
 *
 * Three rules, and the middle one is the whole point of #6's *"resolution
 * happens by acting on the underlying object"*:
 *
 *  1. A stored item that is still computed keeps its stored status — a dismissed
 *     item stays dismissed, or dismissal would be undone by the next recompute.
 *  2. A stored **pending** item that is no longer computed is `resolved`: the
 *     commitment closed, the question got answered, the proposal was accepted.
 *     Nobody clicked anything and the item is done anyway.
 *  3. A computed item nobody has seen is new, and pending.
 *
 * ## …and a settled item that stops being computed stays settled — r8
 *
 * Rule 1 is what makes dismissal stick, and it only works while the item is in
 * `stored`. This function used to **drop** every stored non-pending item that
 * was not in the current computation: `if (entry.status !== 'pending')
 * continue;`. So dismissal survived one cycle and not two.
 *
 * ```
 * cycle 1  computed: [X]            stored: []       → X pending
 *          user dismisses X                          → X dismissed
 * cycle 2  computed: []   (window not supplied, or the proposal briefly judged
 *                          `receipt_not_certifiable`, or the commitment closed)
 *          → X is not computed and not pending, so it is dropped from the store
 * cycle 3  computed: [X]            stored: []       → X pending again
 * ```
 *
 * There is a documented path that empties `computed` wholesale: a projection
 * with no `messages` raises nothing and reports refusals, which is deliberate
 * and correct. One such cycle used to wipe every dismissal in the room, and the
 * next recompute re-minted the lot as `pending` — the panel "learning to be
 * ignored" that #6 names as the failure dismissal exists to prevent.
 *
 * A settled item is a **tombstone** now: it is carried through unchanged, so a
 * later cycle that computes it again finds it in `stored` and rule 1 keeps it
 * settled. That is not a new semantic, it is the one rule 1 already had — ids
 * are deterministic, so a recomputed item has always been the same item.
 *
 * ## …and a *pending* item that stops being computed is only done if the cycle
 * looked — r10
 *
 * r8 fixed the `dismissed` half of that sequence and left the `pending` half on
 * rule 2, whose own comment enumerated the benign reasons an item stops being
 * computed — *"the commitment closed, the question got answered, nobody clicked
 * anything"* — and treated **the cycle could not compute it** as one of them.
 * Rule 1 then pinned the result: a later cycle that computes the item again
 * finds it in `stored` and keeps the stored `resolved`. One blind cycle, resolved
 * forever, while `decideAcceptance` still says `pending / needs_you / confirm:
 * bob` and the proposal stays `proposed`.
 *
 * It needed no caller mistake. An ordinary sliding "last N messages" window that
 * had moved past the cited message produced this:
 *
 * ```
 * cycle 1 (full window)  items: [bob/owned_commitment]  refusals: 0   → pending
 * cycle 2 (slid window)  items: []                      refusals: []  → resolved
 * cycle 3 (full window)                                               → resolved
 * ```
 *
 * Zero items, zero refusals, permanently resolved, and nothing anywhere saying
 * a proposal routed to Bob had reached nobody.
 *
 * **The repair is an allowlist, not a list of the blindnesses somebody thought
 * of.** Enumerating the ways a cycle can go blind is the shape `RETRO.md`
 * records: r9 made the `needs_you` path total and the exit that produced this
 * was `discard / provenance_failed`, which never reached that invariant — *an
 * invariant asserted on one branch of a dispatch does not constrain the
 * others.* So rule 2 no longer asks why the item is missing. It asks for
 * **positive evidence that the cycle reached a conclusion about the subject**,
 * and a source that cannot supply that evidence for a subject leaves the item
 * exactly where it was: pending, in the panel, owed to somebody. A source added
 * next round is silent about a subject by default, and silence now preserves
 * rather than resolves.
 *
 * Which is why the second argument is the whole `AttentionProjection` and not
 * its items. There is no spelling of "I computed nothing and I know why" left
 * for a caller to omit.
 *
 * **The residue, stated because it is a real one.** A `blocking_question` item
 * has two producers — a `blocks` relation, which is state, and a
 * `questionMentions` signal, which is the caller's — and they share an item id,
 * so they share an `ExaminedSubject` key. The state half declares the key, so a
 * cycle that supplies no `questionMentions` can still resolve a
 * `question_names_you` item by absence. That is r9's behaviour unchanged rather
 * than a new hole, and closing it means recording on the item which producer
 * raised it, which is an `AttentionItem` schema change and #22's storage
 * surface. `mention`, whose producer is caller-driven and *unshared*, is closed:
 * see `mentionItems`.
 */
export function reconcileAttention(
  stored: readonly AttentionItem[],
  cycle: AttentionProjection,
): ComputedAttentionItem[] {
  const byId = new Map(stored.map((entry) => [entry.id, entry]));
  const computedIds = new Set(cycle.items.map((entry) => entry.id));
  const examined = new Set(cycle.examined.map(examinedKey));
  const out: ComputedAttentionItem[] = [];

  for (const entry of cycle.items) {
    const previous = byId.get(entry.id);
    out.push(previous ? { ...entry, status: previous.status } : entry);
  }

  for (const entry of stored) {
    if (computedIds.has(entry.id)) continue;
    // Rule 2: a *pending* item that stopped being computed is done — but only
    // where the cycle says it examined the subject and raised nothing. Where it
    // does not, the item is owed to somebody still and stays where it is. A
    // settled item is left exactly as it was either way.
    const concluded = examined.has(
      examinedKey({
        class: entry.class,
        subjectKind: entry.subjectKind,
        subjectId: entry.objectId,
      }),
    );
    out.push({
      ...entry,
      status: entry.status === 'pending' && concluded ? 'resolved' : entry.status,
      priority: fallbackPriority(entry.class),
    });
  }

  return sortAttention(out);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Since you left
 * ───────────────────────────────────────────────────────────────────────── */

export interface SinceCursorCounts {
  /** Pending attention items raised for this user at or after the cursor. */
  attention: number;
  /** …broken down, because "3 things need you" is less useful than which three. */
  byClass: Record<AttentionClass, number>;
  /** Objects accepted, corrected, or related since the cursor, in this room. */
  changes: number;
  /** True when there is nothing new. */
  quiet: boolean;
}

export interface SinceCursorInput {
  userId: Id;
  roomId: Id;
  /**
   * The user's seen cursor — an ISO timestamp. Everything at or after it is
   * "since you left". `null` means they have never been here, so everything is.
   */
  seenAt: Timestamp | null;
  items: readonly AttentionItem[];
}

/**
 * #6's "since-you-left counts derive from attention items + change events
 * against the per-user seen cursor", derived rather than stored.
 *
 * Both halves are counted because they answer different questions: the
 * attention count is *what needs you*, and the change count is *what moved while
 * you were gone*. A room can be busy and owe you nothing, and it can be silent
 * and owe you a decision.
 */
export function sinceCursorCounts(state: CoreState, input: SinceCursorInput): SinceCursorCounts {
  const byClass: Record<AttentionClass, number> = {
    needs_decision: 0,
    owned_commitment: 0,
    mention: 0,
    blocking_question: 0,
  };
  let attention = 0;

  for (const entry of input.items) {
    if (entry.userId !== input.userId) continue;
    if (entry.roomId !== input.roomId) continue;
    if (entry.status !== 'pending') continue;
    if (input.seenAt !== null && entry.createdAt < input.seenAt) continue;
    attention += 1;
    byClass[entry.class] += 1;
  }

  // One count per *change event*, not per changed object: an object accepted and
  // then corrected twice while you were away is three things that happened, and
  // collapsing them to "1 changed" hides the argument that is the interesting
  // part. The three sources are disjoint by construction — an acceptance, a
  // correction and a relation are different rows in the log.
  const since = (at: Timestamp): boolean => input.seenAt === null || at >= input.seenAt;
  let changes = 0;

  for (const record of Object.values(state.objects)) {
    if (record.object.roomId !== input.roomId) continue;
    if (since(record.acceptedAt)) changes += 1;
  }
  for (const correction of state.corrections) {
    const record = state.objects[correction.objectId];
    if (!record || record.object.roomId !== input.roomId) continue;
    if (since(correction.at)) changes += 1;
  }
  for (const relation of state.relations) {
    if (relation.roomId !== input.roomId) continue;
    if (since(relation.createdAt)) changes += 1;
  }

  return { attention, byClass, changes, quiet: attention === 0 && changes === 0 };
}

/**
 * All the objects that would be counted as changed — for a UI that lists them.
 *
 * "Changed" is `updatedAt`, not `acceptedAt`: this answers "what should I look
 * at", and an object accepted last week and corrected this morning is a thing
 * that moved this morning. It is deliberately *not* the same population
 * `sinceCursorCounts` counts — that one counts events, this one lists objects,
 * and one object can be three events.
 */
export function changedSince(
  state: CoreState,
  roomId: Id,
  seenAt: Timestamp | null,
): AcceptedObject[] {
  const out: AcceptedObject[] = [];
  for (const id of Object.keys(state.objects).sort()) {
    const record = state.objects[id];
    if (!record || record.object.roomId !== roomId) continue;
    if (seenAt === null || record.updatedAt >= seenAt) out.push(record.object);
  }
  return out;
}
