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

export const AttentionItem = z.object({
  id: Id,
  roomId: Id,
  userId: Id,
  objectId: Id,
  class: AttentionClass,
  /** Why this person specifically. Never empty. */
  rationale: z.string().min(1),
  status: AttentionStatus.default('pending'),
  createdAt: Timestamp,
});
export type AttentionItem = z.infer<typeof AttentionItem>;
export type AttentionItemInput = z.input<typeof AttentionItem>;
