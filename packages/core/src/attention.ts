import { z } from 'zod';
import { Id, Timestamp } from './common.js';

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
 * #21 discovered this in the core; #22 owns the persistence half, and
 * `attention_items` in @atrium/db is polymorphic on exactly this discriminator
 * (`subject_kind` + `subject_id`, each edge room-scoped). The two enums are
 * held together by a compile-time parity assertion in that schema.
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
