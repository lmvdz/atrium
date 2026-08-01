import { z } from 'zod';
import { Id, Timestamp } from './common.js';

/**
 * Typed edges, not objects (issue #3): supersession, dependency, blocking,
 * answering, and evidence are all relations. Four of the twelve original
 * concepts collapsed into this table.
 */
export const RelationKind = z.enum([
  /** a supersedes b — b's status flips, b is never deleted. */
  'supersedes',
  /** a depends_on b */
  'depends_on',
  /** a blocks b */
  'blocks',
  /** question a answers→ decision|claim b */
  'answers',
  /** object a is evidenced by a message, url, or file. */
  'evidence',
]);
export type RelationKind = z.infer<typeof RelationKind>;

/**
 * Relation targets are polymorphic: object-to-object for the structural kinds,
 * object-to-(message|url|file) for evidence. Exactly one target is set — the DB
 * mirrors this with nullable columns plus a check constraint.
 */
export const RelationTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('object'), objectId: Id }),
  z.object({ kind: z.literal('message'), messageId: Id }),
  z.object({ kind: z.literal('url'), url: z.url() }),
  z.object({ kind: z.literal('file'), fileKey: z.string().min(1) }),
]);
export type RelationTarget = z.infer<typeof RelationTarget>;

export const Relation = z.object({
  id: Id,
  roomId: Id,
  kind: RelationKind,
  fromObjectId: Id,
  to: RelationTarget,
  /** Evidence carries a human note ("this is the benchmark that shows it"). */
  note: z.string().nullable().default(null),
  createdAt: Timestamp,
});
export type Relation = z.infer<typeof Relation>;
export type RelationInput = z.input<typeof Relation>;

/** Structural kinds must point at another object, not at a message or a url. */
export const objectToObjectKinds = ['supersedes', 'depends_on', 'blocks', 'answers'] as const;

export function isObjectTarget(
  target: RelationTarget,
): target is Extract<RelationTarget, { kind: 'object' }> {
  return target.kind === 'object';
}

/**
 * Validates the kind/target pairing the DB check constraint also enforces.
 * Returns an error message, or `null` when the relation is well-formed.
 */
export function relationShapeError(relation: Relation): string | null {
  const structural = (objectToObjectKinds as readonly string[]).includes(relation.kind);
  if (structural && !isObjectTarget(relation.to)) {
    return `relation "${relation.kind}" must target an object, got "${relation.to.kind}"`;
  }
  if (relation.kind === 'evidence' && isObjectTarget(relation.to)) {
    return 'relation "evidence" must target a message, url, or file';
  }
  if (structural && isObjectTarget(relation.to) && relation.to.objectId === relation.fromObjectId) {
    return `relation "${relation.kind}" cannot point an object at itself`;
  }
  return null;
}
