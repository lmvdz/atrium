import { z } from 'zod';
import { TEXT_FIELD } from './attribution.js';
import { emptyProvenance, Id, Provenance, Timestamp } from './common.js';

/**
 * The five first-class accepted object types (issue #3 resolution). Stored in
 * one table with a `type` discriminator and a typed jsonb payload; mirrored
 * here so the payload is validated before it ever reaches Postgres.
 */
export const AcceptedObjectType = z.enum([
  'decision',
  'commitment',
  'open_question',
  'claim',
  'objective',
]);
export type AcceptedObjectType = z.infer<typeof AcceptedObjectType>;

/** `{statement, decidedBy?, status}` */
export const DecisionPayload = z.object({
  statement: z.string().min(1),
  decidedBy: Id.nullable().default(null),
  status: z.enum(['active', 'superseded']).default('active'),
});
export type DecisionPayload = z.infer<typeof DecisionPayload>;

/** `{statement, owner, due?, status}` — absorbs "responsibility" (a standing commitment). */
export const CommitmentPayload = z.object({
  statement: z.string().min(1),
  owner: Id,
  due: Timestamp.nullable().default(null),
  status: z.enum(['open', 'done', 'dropped']).default('open'),
});
export type CommitmentPayload = z.infer<typeof CommitmentPayload>;

/** `{question, status}` */
export const OpenQuestionPayload = z.object({
  question: z.string().min(1),
  status: z.enum(['open', 'answered']).default('open'),
});
export type OpenQuestionPayload = z.infer<typeof OpenQuestionPayload>;

/** `{statement, claimant, verification}` — the `~` vs `✓` distinction, as data. */
export const ClaimPayload = z.object({
  statement: z.string().min(1),
  claimant: Id,
  verification: z.enum(['unverified', 'verified', 'disputed']).default('unverified'),
});
export type ClaimPayload = z.infer<typeof ClaimPayload>;

/** `{title, status}` — the grouping noun; "branch" folds into this for v1. */
export const ObjectivePayload = z.object({
  title: z.string().min(1),
  status: z.enum(['open', 'achieved', 'abandoned']).default('open'),
});
export type ObjectivePayload = z.infer<typeof ObjectivePayload>;

export const objectPayloadByType = {
  decision: DecisionPayload,
  commitment: CommitmentPayload,
  open_question: OpenQuestionPayload,
  claim: ClaimPayload,
  objective: ObjectivePayload,
} as const;

/** The payload a given type carries, keyed off the one table above. */
export type ObjectPayloadOf<K extends AcceptedObjectType> = z.infer<
  (typeof objectPayloadByType)[K]
>;

/**
 * **Every field a payload of this type has**, read off the schema rather than
 * written out.
 *
 * r10. `findDuplicate` compared exactly one field of a payload — the sentence —
 * and destroyed every reading that differed only in `owner`, `claimant`, `due`,
 * `status` or `verification`. The repair that adds the two fields the finding
 * was demonstrated with is the enumeration `RETRO.md` refuses; this is the
 * enumeration that cannot fall behind, because the schema *is* the list. A field
 * added to a payload above appears here in the same commit.
 */
export function objectPayloadKeys(type: AcceptedObjectType): readonly string[] {
  return Object.keys(objectPayloadByType[type].shape);
}

const envelope = {
  id: Id,
  roomId: Id,
  /** Every object may belong to an objective; objectives themselves may nest. */
  objectiveId: Id.nullable().default(null),
  provenance: Provenance.default(emptyProvenance),
  createdAt: Timestamp,
  updatedAt: Timestamp,
};

export const Decision = z.object({
  ...envelope,
  type: z.literal('decision'),
  payload: DecisionPayload,
});
export const Commitment = z.object({
  ...envelope,
  type: z.literal('commitment'),
  payload: CommitmentPayload,
});
export const OpenQuestion = z.object({
  ...envelope,
  type: z.literal('open_question'),
  payload: OpenQuestionPayload,
});
export const Claim = z.object({ ...envelope, type: z.literal('claim'), payload: ClaimPayload });
export const Objective = z.object({
  ...envelope,
  type: z.literal('objective'),
  payload: ObjectivePayload,
});

export const AcceptedObject = z.discriminatedUnion('type', [
  Decision,
  Commitment,
  OpenQuestion,
  Claim,
  Objective,
]);
export type AcceptedObject = z.infer<typeof AcceptedObject>;
export type AcceptedObjectInput = z.input<typeof AcceptedObject>;

export type Decision = z.infer<typeof Decision>;
export type Commitment = z.infer<typeof Commitment>;
export type OpenQuestion = z.infer<typeof OpenQuestion>;
export type Claim = z.infer<typeof Claim>;
export type Objective = z.infer<typeof Objective>;

/**
 * The text field of a payload, whichever the type calls it: `question` for an
 * open question, `title` for an objective, `statement` for the other three.
 *
 * It lives here, on the types themselves, rather than in the acceptance engine
 * where it started — `authority.ts` needs it to ask whether a quote bears the
 * sentence being minted, and it must not import the engine to find out (the
 * engine imports the reducer, which imports `authority.ts`).
 *
 * **The key comes from `TEXT_FIELD`, not from a ladder.** Until #22 r11 the
 * ladder was written out right here — `type === 'open_question' ? 'question'
 * : …` — which made this the *second* answer to "which field holds the
 * sentence", beside the one `attribution.ts` derives from
 * `PAYLOAD_FIELD_ROLE`. r10 closed exactly that shape for "which field holds a
 * person" and found three hand-written answers where the brief said two; this
 * was the same defect one field over, waiting for a sixth type whose text key
 * is neither `statement`, `question` nor `title` to make the two disagree in
 * silence. `attribution.ts` has no runtime import of this module (its imports
 * of `objectPayloadByType` and `AcceptedObjectType` are `import type`, erased
 * at emit), so the edge is one-way and there is no cycle.
 */
export function payloadText(type: AcceptedObjectType, payload: Record<string, unknown>): string {
  const value = payload[TEXT_FIELD[type]];
  return typeof value === 'string' ? value : '';
}

/**
 * Which key `payloadText` reads, named rather than recomputed.
 *
 * r10's `payloadsMatch` compares every field of a payload *except* the sentence,
 * which it has already compared with the receipt's alignment — so it needs the
 * name of the one key to skip, and a second copy of this ternary is how the two
 * would drift.
 *
 * AND IT IS NO LONGER A TERNARY, for exactly the reason the paragraph above
 * gives. The core lane added this accessor while the realtime lane was deleting
 * the ladder out of `payloadText` and pointing it at `TEXT_FIELD`; keeping both
 * verbatim would have left the ladder alive HERE, one function below a comment
 * that says it is gone — the third hand-written answer to "which field holds the
 * sentence", which is the defect one field over from the one r10 closed. So the
 * accessor survives (its callers in `acceptance.ts` and its tests are real) and
 * it reads the same table `payloadText` does. `attribution.test.ts` pins
 * `TEXT_FIELD` against a written-out expectation, so this is value-identical
 * today and single-sourced tomorrow.
 */
export function payloadTextKey(type: AcceptedObjectType): string {
  return TEXT_FIELD[type];
}

/** `payloadText` for a whole object. */
export function objectStatement(object: AcceptedObject): string {
  return payloadText(object.type, object.payload as unknown as Record<string, unknown>);
}

/** Narrowing helper — `type` is the discriminator everywhere in the system. */
export function isType<T extends AcceptedObjectType>(
  object: AcceptedObject,
  type: T,
): object is Extract<AcceptedObject, { type: T }> {
  return object.type === type;
}
