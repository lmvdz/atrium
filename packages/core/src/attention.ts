import { z } from 'zod';
import { commitmentAttribution } from './acceptance.js';
import { Id, Timestamp } from './common.js';
import type { AcceptedObject } from './objects.js';
import type { CoreState, ObjectRecord } from './state.js';

/**
 * Attention items are a *projection*, never source truth (issue #3). They are
 * stored so the UI can page them, but they are always recomputable from the
 * accepted-object graph.
 *
 * `rationale` is required by design: an attention item that cannot say why it
 * needs this person specifically is not allowed to exist (research brief,
 * concept 8).
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
 * (Noted for #22: `attention_items.object_id` is a foreign key onto
 * `accepted_objects`, so persisting a proposal-subject item needs that column to
 * become polymorphic. Core is the layer that discovered it; the migration is not
 * this ticket's.)
 */
export const AttentionSubjectKind = z.enum(['object', 'proposal']);
export type AttentionSubjectKind = z.infer<typeof AttentionSubjectKind>;

export const AttentionItem = z.object({
  id: Id,
  roomId: Id,
  userId: Id,
  /** The accepted object, or the staged proposal — see `subjectKind`. */
  objectId: Id,
  subjectKind: AttentionSubjectKind.default('object'),
  class: AttentionClass,
  /** Why this person specifically. Never empty. */
  rationale: z.string().min(1),
  status: AttentionStatus.default('pending'),
  createdAt: Timestamp,
});
export type AttentionItem = z.infer<typeof AttentionItem>;
export type AttentionItemInput = z.input<typeof AttentionItem>;

/* ─────────────────────────────────────────────────────────────────────────
 * Rationale — enforced by the type system, not by a convention
 * ───────────────────────────────────────────────────────────────────────── */

declare const rationaleBrand: unique symbol;

/**
 * A rationale that names the person and the reason.
 *
 * Branded, so `buildAttentionItem` cannot be handed a bare string. The zod
 * schema's `min(1)` catches an empty rationale at the boundary; this catches the
 * thing that actually happens, which is not an empty rationale but a lazy one —
 * somebody in a hurry passing `"needs attention"` and moving on. There is
 * exactly one way to make a `Rationale`, it takes the person's id, and it
 * cannot produce an empty string. That is the enforcement the research brief's
 * concept 8 asks for: *"why you specifically"* is a constructor argument.
 */
export type Rationale = string & { readonly [rationaleBrand]: true };

export type RationaleReason =
  | { kind: 'decision_pending'; statement: string; assigned: boolean }
  | { kind: 'commitment_overdue'; statement: string; due: Timestamp; now: Timestamp }
  | { kind: 'commitment_open'; statement: string; due: Timestamp | null }
  | { kind: 'commitment_confirm'; statement: string }
  | { kind: 'question_blocks_commitment'; question: string; commitment: string }
  | { kind: 'question_blocks_objective'; question: string; objective: string }
  | { kind: 'question_names_you'; question: string }
  | { kind: 'mention'; request: string };

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
  /** `messageId → authorId`, for commitment attribution. */
  messageAuthors?: Readonly<Record<Id, Id>>;
  mentions?: readonly MentionSignal[];
  questionMentions?: readonly QuestionMentionSignal[];
}

/**
 * The attention projection: #6's four classes, computed from state.
 *
 * Deterministic and total. Output is sorted hardest-first with a fully specified
 * tiebreak, so two nodes computing it from the same state produce identical
 * bytes — the same property the reducer has, for the same reason.
 *
 * Backwards-compatible with the scaffold's `computeAttention(state, now)`: a
 * bare timestamp is read as a context with nothing else set.
 */
export function computeAttention(
  state: CoreState,
  context: AttentionContext | Timestamp,
): ComputedAttentionItem[] {
  const ctx: AttentionContext = typeof context === 'string' ? { now: context } : context;
  const items: ComputedAttentionItem[] = [];

  for (const item of decisionItems(state, ctx)) items.push(item);
  for (const item of commitmentItems(state, ctx)) items.push(item);
  for (const item of blockingQuestionItems(state, ctx)) items.push(item);
  for (const item of mentionItems(ctx)) items.push(item);

  return sortAttention(items);
}

/** Live means: accepted, not retracted, not superseded. */
function isLive(record: ObjectRecord | undefined): record is ObjectRecord {
  return !!record && record.retractedAt === null && record.supersededById === null;
}

function item(
  input: Omit<ComputedAttentionItem, 'status' | 'rationale' | 'subjectKind'> & {
    rationale: Rationale;
    subjectKind?: AttentionSubjectKind;
  },
): ComputedAttentionItem {
  return {
    ...input,
    subjectKind: input.subjectKind ?? 'object',
    status: 'pending',
  };
}

/** `needs_decision` — a staged decision waiting on a person. */
function decisionItems(state: CoreState, ctx: AttentionContext): ComputedAttentionItem[] {
  const out: ComputedAttentionItem[] = [];
  for (const proposalId of Object.keys(state.proposals).sort()) {
    const record = state.proposals[proposalId];
    if (record?.status !== 'proposed') continue;
    const { proposal } = record;
    if (proposal.type !== 'decision') continue;

    const statement = proposal.payload.statement;
    const named = proposal.payload.decidedBy;
    const audience = named !== null ? [named] : [...(ctx.members?.[proposal.roomId] ?? [])].sort();

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
          rationale: rationaleFor(userId, {
            kind: 'decision_pending',
            statement,
            assigned: named !== null,
          }),
        }),
      );
    }
  }
  return out;
}

/**
 * `owned_commitment` — three shapes: overdue, open, and awaiting your confirm.
 *
 * The confirm shape is the interesting one and it comes from a *proposal*, not
 * an object: a commitment somebody else's sentence put your name on is staged,
 * never accepted, until you say so (#4). It sorts above an ordinary open
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
        class: 'owned_commitment',
        priority: overdue
          ? ATTENTION_PRIORITY.commitment_overdue
          : ATTENTION_PRIORITY.commitment_open,
        createdAt: ctx.now,
        rationale: overdue
          ? rationaleFor(owner, {
              kind: 'commitment_overdue',
              statement,
              due: due as Timestamp,
              now: ctx.now,
            })
          : rationaleFor(owner, { kind: 'commitment_open', statement, due }),
      }),
    );
  }

  for (const proposalId of Object.keys(state.proposals).sort()) {
    const record = state.proposals[proposalId];
    if (record?.status !== 'proposed') continue;
    const { proposal } = record;
    if (proposal.type !== 'commitment') continue;

    // Only a third-party attribution asks anybody anything. A self-stated
    // commitment that has not cleared θ is just a quiet proposal.
    const messages = ctx.messageAuthors
      ? Object.entries(ctx.messageAuthors).map(([id, authorId]) => ({ id, authorId, body: '' }))
      : undefined;
    if (commitmentAttribution(proposal.payload.owner, proposal.provenance, messages) === 'self') {
      continue;
    }

    const { owner, statement } = proposal.payload;
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
        rationale: rationaleFor(owner, { kind: 'commitment_confirm', statement }),
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

  const push = (userId: Id, question: ObjectRecord, rationale: Rationale): void => {
    const id = `attn:${userId}:${question.object.id}:blocking_question`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(
      item({
        id,
        roomId: question.object.roomId,
        userId,
        objectId: question.object.id,
        class: 'blocking_question',
        priority: ATTENTION_PRIORITY.blocking_question,
        createdAt: ctx.now,
        rationale,
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
    push(
      signal.userId,
      question,
      rationaleFor(signal.userId, {
        kind: 'question_names_you',
        question: question.object.payload.question,
      }),
    );
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
      push(
        owner,
        question,
        rationaleFor(owner, {
          kind: 'question_blocks_commitment',
          question: questionText,
          commitment: blocked.object.payload.statement,
        }),
      );
      continue;
    }
    if (blocked.object.type === 'objective') {
      const title = blocked.object.payload.title;
      for (const userId of [...(ctx.members?.[question.object.roomId] ?? [])].sort()) {
        push(
          userId,
          question,
          rationaleFor(userId, {
            kind: 'question_blocks_objective',
            question: questionText,
            objective: title,
          }),
        );
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
      class: 'mention',
      priority: ATTENTION_PRIORITY.mention,
      createdAt: ctx.now,
      rationale: rationaleFor(signal.userId, { kind: 'mention', request: signal.request }),
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

/** All the objects that would be counted as changed — for a UI that lists them. */
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
