import { z } from 'zod';

/**
 * Shared primitives. Everything in this package is pure: no imports from
 * `node:*`, no network, no clock, no randomness. The reducer must be able to
 * replay the same event log on a server, in a worker, or in a browser and land
 * on a byte-identical state.
 */

/**
 * The characters an id may be made of: printable ASCII, no space, no controls.
 *
 * ## Why a charset at all (#22 gauntlet r3 delta, major 1)
 *
 * `id` is the second half of the canonical `(at, id)` order, and that order is
 * evaluated in **two** places by two different rules: here, by JavaScript's `<`,
 * which is UTF-16 code-unit order; and in the ledger's SQL append gate, by
 * `COLLATE "C"`, which is UTF-8 byte order. The finding:
 *
 * > astral-plane ids compare differently in UTF-16 than in `COLLATE "C"`;
 * > production minting stays in the safe subset, so **constrain the subset
 * > rather than trusting it**.
 *
 * The two orders agree for every code point in the Basic Multilingual Plane —
 * UTF-8 is order-preserving on code points, and a BMP code point *is* its UTF-16
 * code unit. They disagree above it: a code point at U+10000 or beyond is a
 * surrogate pair beginning at U+D800, so UTF-16 sorts it **before** U+E000–U+FFFF
 * while byte order sorts it after. One astral id in a ledger and the database's
 * "strictly after the cursor" gate and the reducer's `orderEvents` disagree about
 * what the log says — silently, and only for the events involved.
 *
 * ASCII is the subset every layer already produces (uuids, slugs, `u1`) and the
 * one where nothing can disagree. Constraining it here makes the agreement a
 * property of the type rather than a property of what production happens to mint;
 * `core_events.id` carries the same rule as a CHECK, so it holds for a writer that
 * never goes through this package at all.
 *
 * Space and the control characters are excluded on a second ground: two ids that
 * differ only by an invisible character are two ids a person cannot tell apart.
 */
export const ID_CHARSET = /^[\x21-\x7E]+$/;

/**
 * The maximum id length.
 *
 * Not a storage limit — `text` has none worth naming — but a bound on what an
 * unbounded caller can put into the ledger's canonical key and into every index
 * that carries it.
 */
export const ID_MAX_LENGTH = 256;

export const Id = z
  .string()
  .min(1)
  .max(ID_MAX_LENGTH)
  .regex(
    ID_CHARSET,
    'an id must be printable ASCII with no spaces: the canonical (at, id) order is evaluated by JavaScript in one place and by Postgres `COLLATE "C"` in another, and the two agree only inside that subset',
  );
export type Id = z.infer<typeof Id>;

/**
 * The one spelling of an instant this system uses:
 * `YYYY-MM-DDTHH:MM:SS.mmmZ` — exactly what `Date#toISOString` produces.
 *
 * ## Why a spelling and not a format family (#22 gauntlet r4 delta, major 1)
 *
 * Round 4 constrained `core_events.payload->>'at'` to this spelling with a CHECK
 * and left this type as `z.iso.datetime({ offset: true })`, then claimed the two
 * were one rule. They were not:
 *
 * > `at` type/CHECK parity is false — `z.iso.datetime({ offset: true })` accepts
 * > non-`Z` offsets and other spellings while the CHECK accepts only `…SS.mmmZ`,
 * > so "one ISO spelling on both sides" does not hold.
 *
 * Exactly right, and the gap is not cosmetic. `2026-08-01T12:00:03.000+00:00`
 * and `2026-08-01T12:00:03.000Z` are one instant to `timestamptz` and two
 * different strings to `orderEvents`, so a log holding both has an ordering gate
 * (SQL) and a reducer (JS) that disagree about whether two events are
 * simultaneous. A type that admits a value the database refuses is also a type
 * that turns a data problem into a runtime failure at the last possible moment —
 * the event is built, folded, and then the INSERT says no.
 *
 * So the type is the CHECK, character for character, and
 * `integration/db/ledger-constraints.test.ts` generates values across the whole
 * disputed area and asserts that no value is accepted by one side and refused by
 * the other.
 *
 * ## One regex, two engines
 *
 * Parity is not achieved by writing the same rule twice. `CANONICAL_TIMESTAMP` is
 * the rule, and `packages/db/src/schema.ts` builds
 * `core_events_payload_at_is_canonical_utc` out of `CANONICAL_TIMESTAMP.source`
 * — so the CHECK is not a transcription that can drift, it is the same string.
 * The pattern is deliberately calendar-aware (leap years, month lengths, hour and
 * minute ranges) rather than the loose `[0-9]{2}` shape round 4 used, because a
 * *shape* check admits `2026-13-45T25:00:00.000Z`: well-formed, impossible, and
 * refused by the value type on one side while the database accepts it into a
 * CHECK and only trips over it later at the `::timestamptz` cast. That is a
 * parity failure too, just a quieter one. Postgres's advanced regular expressions
 * take `\d`, `{n}` and `(?:…)` with the same meaning JavaScript gives them, so
 * one source really does serve both.
 *
 * `integration/db/ledger-constraints.test.ts` fuzzes the two engines against each
 * other across the whole disputed area and asserts the set of values one accepts
 * and the other refuses is empty.
 *
 * ## What this narrows
 *
 * Deliberately every `Timestamp` in the core, not only an event's `at` — the same
 * call `Id` got in round 4, for the same reason: a rule that applies to one of a
 * type's uses is a rule the next caller does not know about. A `due` date, an
 * `acceptedAt`, an ingest line's `ts` are all now one spelling, and the only
 * producers in this repo (`Date#toISOString`, `nextTimestamp`,
 * `normalizeTimestamp`) already emit it. The cost is real and worth naming: any
 * writer that is not this codebase must normalise before handing a timestamp in,
 * where before it could hand in any ISO-8601 instant. That is the trade the
 * finding asks for — one spelling, so that string order and instant order are the
 * same order everywhere.
 */
export const CANONICAL_TIMESTAMP =
  /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|02-(?:0[1-9]|1\d|2[0-8])))T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

export const Timestamp = z
  .string()
  .regex(
    CANONICAL_TIMESTAMP,
    'a timestamp must be spelled exactly YYYY-MM-DDTHH:MM:SS.mmmZ and name a real instant — what Date#toISOString produces, and the only spelling core_events_payload_at_is_canonical_utc admits: two spellings of one instant make string order and timestamptz order disagree about which of two events came first',
  );
export type Timestamp = z.infer<typeof Timestamp>;

/** Who did a thing. Mirrors `proposals.proposer_kind` / `corrections.by_*`. */
export const Actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), userId: Id }),
  z.object({ kind: z.literal('model'), model: z.string().min(1) }),
  z.object({ kind: z.literal('system') }),
]);
export type Actor = z.infer<typeof Actor>;

/**
 * Where a fact came from. Every accepted object points back at the messages it
 * was derived from and, when it came through interpretation, at the proposal
 * and interpretation run that produced it (init.md §5: retain the original
 * source, always).
 */
export const Provenance = z.object({
  messageIds: z.array(Id).default([]),
  proposalId: Id.nullable().default(null),
  interpretationId: Id.nullable().default(null),
});
export type Provenance = z.infer<typeof Provenance>;

export const emptyProvenance: Provenance = {
  messageIds: [],
  proposalId: null,
  interpretationId: null,
};
