import { z } from 'zod';
import { decideAcceptance } from './acceptance.js';
import { Id, Timestamp } from './common.js';
import type { ProvenanceMessage } from './escalation.js';
import type { AcceptedObject } from './objects.js';
import type { AcceptanceConfig } from './policy.js';
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
    case 'question_blocks_commitment':
      return `${you} — you own the commitment this open question blocks ("${clip(reason.commitment)}"), so it is your answer that unblocks it: "${clip(reason.question)}".` as Rationale;
    case 'question_blocks_objective':
      return `${you} — this open question blocks the objective "${clip(reason.objective)}", which nobody owns, so any member of the room can unblock it: "${clip(reason.question)}".` as Rationale;
    case 'question_names_you':
      return `${you} — this open question names you: "${clip(reason.question)}".` as Rationale;
    case 'mention':
      return `${you} — you were named in a message that asks you something: "${clip(reason.request)}".` as Rationale;
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

/** For items read back from storage, which carry a class but no priority. */
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
    default: {
      const exhaustive: never = attentionClass;
      return Number.MAX_SAFE_INTEGER + (exhaustive as unknown as number);
    }
  }
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
   * makes. Without it, unassigned decisions produce no items at all — stated
   * here so the silence is a known consequence rather than a mystery.
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
  const items: ComputedAttentionItem[] = [];
  const refusals: AttentionRefusal[] = [];

  for (const item of proposalItems(state, ctx, refusals)) items.push(item);
  for (const item of commitmentItems(state, ctx)) items.push(item);
  for (const item of blockingQuestionItems(state, ctx)) items.push(item);
  for (const item of mentionItems(ctx)) items.push(item);

  return { items: sortAttention(items), refusals };
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
 * Everything a staged proposal raises: `needs_decision`, and the owner-confirm
 * shape of `owned_commitment`.
 *
 * Both go through `decideAcceptance`, so the panel and the engine cannot
 * disagree about what a proposal in the θ band means — and so a proposal the
 * engine cannot judge (no messages) raises nothing rather than raising
 * everything.
 */
function proposalItems(
  state: CoreState,
  ctx: AttentionContext,
  refusals: AttentionRefusal[],
): ComputedAttentionItem[] {
  const out: ComputedAttentionItem[] = [];

  for (const proposalId of Object.keys(state.proposals).sort()) {
    const record = state.proposals[proposalId];
    if (record?.status !== 'proposed') continue;
    const { proposal } = record;
    if (proposal.type !== 'decision' && proposal.type !== 'commitment') continue;

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
    if (verdict.visibility !== 'needs_you') continue;

    if (proposal.type === 'decision') {
      const statement = proposal.payload.statement;
      const named = proposal.payload.decidedBy;
      const audience =
        named !== null ? [named] : [...(ctx.members?.[proposal.roomId] ?? [])].sort();
      for (const userId of audience) {
        out.push(
          item({
            id: `attn:${userId}:${proposal.id}:needs_decision`,
            roomId: proposal.roomId,
            userId,
            objectId: proposal.id,
            subjectKind: 'proposal',
            class: 'needs_decision',
            priority: ATTENTION_PRIORITY.needs_decision,
            createdAt: ctx.now,
            reason: { kind: 'decision_pending', statement, assigned: named !== null },
          }),
        );
      }
      continue;
    }

    // A commitment only asks anybody anything when somebody else's sentence put
    // their name on it — which is exactly `awaitingConfirmFrom`.
    const owner = verdict.awaitingConfirmFrom;
    if (owner === null) continue;
    out.push(
      item({
        id: `attn:${owner}:${proposal.id}:owned_commitment`,
        roomId: proposal.roomId,
        userId: owner,
        objectId: proposal.id,
        subjectKind: 'proposal',
        class: 'owned_commitment',
        priority: ATTENTION_PRIORITY.commitment_confirm,
        createdAt: ctx.now,
        reason: { kind: 'commitment_confirm', statement: proposal.payload.statement },
      }),
    );
  }

  return out;
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
function commitmentItems(state: CoreState, ctx: AttentionContext): ComputedAttentionItem[] {
  const out: ComputedAttentionItem[] = [];

  for (const objectId of Object.keys(state.objects).sort()) {
    const record = state.objects[objectId];
    if (!isLive(record)) continue;
    const { object } = record;
    if (object.type !== 'commitment' || object.payload.status !== 'open') continue;

    const { owner, due, statement } = object.payload;
    const overdue = due !== null && due < ctx.now;
    out.push(
      item({
        id: `attn:${owner}:${object.id}:owned_commitment`,
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

  return out;
}

/**
 * `blocking_question` — an open question standing in front of somebody's work.
 *
 * Routed by what it blocks: a commitment routes to its owner, an objective has
 * no owner so it fans out to the room, and a question that names a person routes
 * to them whatever it blocks.
 */
function blockingQuestionItems(state: CoreState, ctx: AttentionContext): ComputedAttentionItem[] {
  const out: ComputedAttentionItem[] = [];
  const seen = new Set<string>();

  const push = (userId: Id, question: ObjectRecord, reason: RationaleReason): void => {
    const id = `attn:${userId}:${question.object.id}:blocking_question`;
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

  return out;
}

function compareQuestionMention(a: QuestionMentionSignal, b: QuestionMentionSignal): number {
  if (a.questionObjectId !== b.questionObjectId) {
    return a.questionObjectId < b.questionObjectId ? -1 : 1;
  }
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

/** `mention` — a direct reference carrying a request, decided upstream. */
function mentionItems(ctx: AttentionContext): ComputedAttentionItem[] {
  const signals = [...(ctx.mentions ?? [])].sort((a, b) => {
    if (a.objectId !== b.objectId) return a.objectId < b.objectId ? -1 : 1;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  return signals.map((signal) =>
    item({
      id: `attn:${signal.userId}:${signal.objectId}:mention`,
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
 */
export function reconcileAttention(
  stored: readonly AttentionItem[],
  computed: readonly ComputedAttentionItem[],
): ComputedAttentionItem[] {
  const byId = new Map(stored.map((entry) => [entry.id, entry]));
  const computedIds = new Set(computed.map((entry) => entry.id));
  const out: ComputedAttentionItem[] = [];

  for (const entry of computed) {
    const previous = byId.get(entry.id);
    out.push(previous ? { ...entry, status: previous.status } : entry);
  }

  for (const entry of stored) {
    if (computedIds.has(entry.id)) continue;
    if (entry.status !== 'pending') continue;
    out.push({
      ...entry,
      status: 'resolved',
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
