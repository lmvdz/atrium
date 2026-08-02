import type { z } from 'zod';
import type { Id } from './common.js';
import type { AcceptedObjectType, objectPayloadByType } from './objects.js';

/**
 * Which payload field names a person — asked once, for the whole system.
 *
 * ## Why this file exists
 *
 * #4's rule is *nobody gets committed, or quoted, by someone else's sentence*.
 * Enforcing it means answering one question — **who does this payload name?** —
 * and until #22 r10 the package answered it twice, in two places, differently:
 *
 *  - `corrections.ts`'s `ATTRIBUTION_FIELD` knew about all three fields
 *    (`decidedBy`, `owner`, `claimant`) and was used only to route the
 *    `reattribute` verb.
 *  - `acceptance.ts`'s `payloadAttributedTo` knew about two (`owner`,
 *    `claimant`) and returned `null` for a decision — and *that* was the answer
 *    the acceptance gate read. So a member could stage
 *    `{statement: "We are cancelling the audit", decidedBy: <somebody else>}`,
 *    accept it himself, and the room's record said the victim cancelled the
 *    audit with nothing refused (r10, D2).
 *
 * Two answers to one question, and the narrower one sat on the path that
 * decides whether a guard runs. There is one answer now and it lives here.
 *
 * ## Exhaustive by construction, not by attention
 *
 * `PayloadFieldRoles` is a mapped type over `z.infer` of each payload schema
 * with `-?`, so the table below must classify **every key of every payload**.
 * Add `escalatedTo: Id` to `CommitmentPayload` and this file stops compiling
 * until somebody says what that field is; classify it `attribution` and every
 * gate in the system starts checking it, with no gate edited. That is the
 * property the r10 brief asked for: *a type that fails when a payload gains a
 * name field nobody classified.*
 *
 * The literal is assigned to the annotated type **before** it is frozen, on
 * purpose: excess-property checking only fires on a fresh object literal, so
 * `Object.freeze({…})` inlined here would silently accept a key that no payload
 * has (a renamed field, classified under its old name, checking nothing).
 */

/**
 * What a payload field is for.
 *
 *  - `attribution` — it holds a person's id. This is the set #4 is about.
 *  - `text` — the sentence itself; `TEXT_FIELD` in `corrections.ts` is the same
 *    fact and is derived from here.
 *  - `state` — the lifecycle enum a correction verb may flip.
 *  - `detail` — everything else that is neither a person nor a sentence.
 */
export type PayloadFieldRole = 'attribution' | 'text' | 'state' | 'detail';

type PayloadOf<T extends AcceptedObjectType> = z.infer<(typeof objectPayloadByType)[T]>;

type PayloadFieldRoles = {
  [T in AcceptedObjectType]: { [K in keyof PayloadOf<T> & string]-?: PayloadFieldRole };
};

const ROLES: PayloadFieldRoles = {
  decision: { statement: 'text', decidedBy: 'attribution', status: 'state' },
  commitment: { statement: 'text', owner: 'attribution', due: 'detail', status: 'state' },
  open_question: { question: 'text', status: 'state' },
  claim: { statement: 'text', claimant: 'attribution', verification: 'state' },
  objective: { title: 'text', status: 'state' },
};

for (const table of Object.values(ROLES)) Object.freeze(table);

/** Every payload key of every type, classified. The one answer. */
export const PAYLOAD_FIELD_ROLE: Readonly<PayloadFieldRoles> = Object.freeze(ROLES);

function fieldsWithRole(type: AcceptedObjectType, role: PayloadFieldRole): readonly string[] {
  const table = PAYLOAD_FIELD_ROLE[type] as Readonly<Record<string, PayloadFieldRole>>;
  return Object.freeze(Object.keys(table).filter((key) => table[key] === role));
}

/**
 * The fields of each type that hold a person's id, derived from `ROLES`.
 *
 * A list rather than a single field, because "how many names may a payload
 * carry" is not this module's decision to make — it is whatever the payloads
 * say. Every gate iterates it, so a second attribution field on some future
 * type is checked the day it is classified.
 */
export const ATTRIBUTION_FIELDS: Readonly<Record<AcceptedObjectType, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(PAYLOAD_FIELD_ROLE) as AcceptedObjectType[]).map((type) => [
        type,
        fieldsWithRole(type, 'attribution'),
      ]),
    ) as Record<AcceptedObjectType, readonly string[]>,
  );

/**
 * The single field `reattribute` moves, or `null` for the types that name
 * nobody.
 *
 * Derived, not declared — `reattribute` names exactly one field in its patch, so
 * a type carrying two attribution fields is a verb whose target is ambiguous.
 * That is a construction error rather than a runtime input, so it throws at
 * import: silently picking the first would make `reattribute` edit one name and
 * leave the other, which is the shape of the defect this whole module exists to
 * close.
 */
export const ATTRIBUTION_FIELD: Readonly<Record<AcceptedObjectType, string | null>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(ATTRIBUTION_FIELDS) as AcceptedObjectType[]).map((type) => {
      const fields = ATTRIBUTION_FIELDS[type];
      if (fields.length > 1) {
        throw new Error(
          `type "${type}" classifies ${fields.length} attribution fields (${fields.join(', ')}) — "reattribute" moves one field, so either the verb or the classification has to change; see attribution.ts`,
        );
      }
      return [type, fields[0] ?? null];
    }),
  ) as Record<AcceptedObjectType, string | null>,
);

/** The field each type puts its text in. `retype` carries this across. */
export const TEXT_FIELD: Readonly<Record<AcceptedObjectType, string>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(PAYLOAD_FIELD_ROLE) as AcceptedObjectType[]).map((type) => {
      const fields = fieldsWithRole(type, 'text');
      const field = fields[0];
      if (fields.length !== 1 || field === undefined) {
        throw new Error(
          `type "${type}" classifies ${fields.length} text fields — every accepted object is exactly one sentence; see attribution.ts`,
        );
      }
      return [type, field];
    }),
  ) as Record<AcceptedObjectType, string>,
);

/**
 * Every person this payload names, in field order, with duplicates and blanks
 * removed.
 *
 * **This is the only function that answers "who does this name".** It replaces
 * `acceptance.ts`'s `payloadAttributedTo`, which knew about two of the three
 * fields, and the two hand-written `type === 'claim' ? payload.claimant : …`
 * ladders that had been copied into `reduce.ts`.
 *
 * A field holding something that is not a string is *not* a name: the payload
 * has not been parsed on every path this is called from, and a non-string in a
 * name field is a shape problem for `AcceptedObject` to refuse, not a person.
 */
export function payloadAttributions(
  type: AcceptedObjectType,
  payload: Record<string, unknown>,
): readonly Id[] {
  const out: Id[] = [];
  for (const field of ATTRIBUTION_FIELDS[type]) {
    const value = payload[field];
    if (typeof value === 'string' && value.length > 0 && !out.includes(value)) out.push(value);
  }
  return out;
}
