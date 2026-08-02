import { describe, expect, it } from 'vitest';
import {
  type AcceptedObjectType,
  ATTRIBUTION_FIELD,
  ATTRIBUTION_FIELDS,
  objectPayloadByType,
  PAYLOAD_FIELD_ROLE,
  payloadAttributions,
  TEXT_FIELD,
} from '../src/index.js';
import { ALICE, BOB } from './fixtures.js';

/**
 * One answer to "who does this payload name", and a way to notice when a
 * payload grows a name nobody classified.
 *
 * The defect this file is the regression for is not a missing check — it is two
 * checks disagreeing. `ATTRIBUTION_FIELD` knew about `decidedBy`;
 * `payloadAttributedTo`, which is what the acceptance gate actually read, did
 * not; `escalation.ts` had a third, hard-written pair. So a decision naming
 * somebody else walked through all of them (#22 r10, D2).
 */

const TYPES = Object.keys(objectPayloadByType) as AcceptedObjectType[];

describe('the attribution table is exhaustive over the payloads', () => {
  it('classifies every key of every payload, and no key that no payload has', () => {
    /**
     * The runtime shadow of the mapped type in `attribution.ts`.
     *
     * The type is the real guard — `PayloadFieldRoles` uses `-?` over
     * `keyof z.infer<…>`, so an unclassified key is a compile error and an
     * invented one is an excess property. This asserts the same thing at runtime
     * so the property is visible in a test run, and so a future refactor that
     * loosens the type (to `Record<string, …>`, say) is still caught.
     *
     * Mutation this catches: widen `PayloadFieldRoles` to
     * `Record<AcceptedObjectType, Record<string, PayloadFieldRole>>` and delete
     * `decidedBy: 'attribution'` from the table. `tsc` goes quiet; this fails.
     */
    for (const type of TYPES) {
      const schemaKeys = Object.keys(objectPayloadByType[type].shape).sort();
      const classified = Object.keys(PAYLOAD_FIELD_ROLE[type]).sort();
      expect(classified).toEqual(schemaKeys);
    }
  });

  it('derives the attribution and text fields rather than repeating them', () => {
    // Mutation: change `ATTRIBUTION_FIELDS` to a hand-written literal that omits
    // `decidedBy`. It disagrees with `PAYLOAD_FIELD_ROLE` and this fails.
    for (const type of TYPES) {
      const table = PAYLOAD_FIELD_ROLE[type] as Readonly<Record<string, string>>;
      const named = Object.keys(table).filter((key) => table[key] === 'attribution');
      expect([...ATTRIBUTION_FIELDS[type]]).toEqual(named);
      expect(ATTRIBUTION_FIELD[type]).toBe(named[0] ?? null);
      expect(table[TEXT_FIELD[type]]).toBe('text');
    }
  });

  it('says a decision names its decider — the sentence r9 got wrong', () => {
    // `authority.ts:222` used to state that "a decision, an objective and an open
    // question name nobody". Two of those three are true.
    expect(ATTRIBUTION_FIELD.decision).toBe('decidedBy');
    expect(ATTRIBUTION_FIELD.commitment).toBe('owner');
    expect(ATTRIBUTION_FIELD.claim).toBe('claimant');
    expect(ATTRIBUTION_FIELD.objective).toBeNull();
    expect(ATTRIBUTION_FIELD.open_question).toBeNull();
  });
});

describe('payloadAttributions', () => {
  it('reads every attribution field, decidedBy included', () => {
    // Mutation: restore `payloadAttributedTo`'s old body — `claim → claimant,
    // commitment → owner, null otherwise`. The decision case fails.
    expect(payloadAttributions('decision', { statement: 's', decidedBy: BOB })).toEqual([BOB]);
    expect(payloadAttributions('commitment', { statement: 's', owner: BOB })).toEqual([BOB]);
    expect(payloadAttributions('claim', { statement: 's', claimant: BOB })).toEqual([BOB]);
    expect(payloadAttributions('objective', { title: 't' })).toEqual([]);
    expect(payloadAttributions('open_question', { question: 'q' })).toEqual([]);
  });

  it('treats an absent, null or non-string name as naming nobody', () => {
    // A decision may legitimately name nobody; `decidedBy` defaults to null. A
    // non-string is a shape problem for `AcceptedObject` to refuse, not a person
    // — reporting it as one would make the refusal text quote a number at a room.
    expect(payloadAttributions('decision', { statement: 's' })).toEqual([]);
    expect(payloadAttributions('decision', { statement: 's', decidedBy: null })).toEqual([]);
    expect(payloadAttributions('decision', { statement: 's', decidedBy: 7 })).toEqual([]);
    expect(payloadAttributions('decision', { statement: 's', decidedBy: '' })).toEqual([]);
  });

  it('is a set: one person named twice is one person', () => {
    // Only reachable once a type carries two attribution fields, which is
    // exactly when this matters — the gate subtracts `before` from `after`, and
    // a duplicate would make a name look like it arrived when it did not.
    const doubled = payloadAttributions('commitment', { statement: 's', owner: ALICE });
    expect(doubled).toEqual([ALICE]);
  });
});
