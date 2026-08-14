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

declare const receiptTextBrand: unique symbol;

/**
 * **Text in the representation the receipt's guarantee was established over** —
 * the output of `normalizeForReceipt`, and nothing else.
 *
 * ## Why this is a type and not a convention, r8
 *
 * r7 shipped `readsAsCommitment` with an argument that reads, in `policy.ts`:
 * *"the input is `statement`, and the receipt has already proved `statement` is
 * the author's own words, verbatim"*. The receipt proves
 * `normalizeForReceipt(quote) === normalizeForReceipt(statement)`. The predicate
 * read the **raw** statement. Those are not the same claim, and the gap between
 * them is exactly the set of differences `normalizeForReceipt` forgives — so the
 * proposer controlled the statement freely inside that equivalence class while
 * the certification predicate never saw the fold:
 *
 * ```
 * body/quote: "I will land the narrowing fix before the release."
 * statement:  "I wi<U+200B>ll land the narrowing fix before the release."
 * → every one of the ten COMMITMENT_SHAPES stopped matching, and the reading
 *   auto-accepted as a claim at 0.95 with the poisoned text in state
 * ```
 *
 * One deletable code point evaded the whole finite domain, at both enforcement
 * points, because both call the same predicate over the same unnormalized text.
 *
 * **The general rule this brand mechanises:** whenever a guarantee is
 * established over a normalized form, every downstream check must consume that
 * same form. Writing the rule down is what r7 did — its docblock states the
 * premise in the present tense and the code contradicts it. A `string` parameter
 * cannot tell the two representations apart, so the fix that lasts is one the
 * compiler makes: `readsAsCommitment`, `typeCertifiableFromText` and
 * `isAssertion` take `ReceiptText`, `normalizeForReceipt` is the only function
 * that produces one, and a call site handing over a raw statement does not
 * build.
 *
 * It lives here rather than beside the fold because `matching.ts` imports
 * `policy.ts` for `RECEIPT_POLICY`; a predicate in `policy.ts` that normalized
 * its own input would close the loop into an import cycle. `common.ts` imports
 * nothing but `zod`, so both ends can name the representation without either
 * depending on the other.
 */
export type ReceiptText = string & { readonly [receiptTextBrand]: true };

/* ---------------------------------------------------------------------------
 * THE TIMESTAMP TYPE BELOW IS THE REALTIME LANE'S, NOT THE CORE LANE'S, AND
 * THAT IS THE MERGE DECISION.
 *
 * The core lane's line here was `export const Timestamp = z.iso.datetime({
 * offset: true })` with the comment "callers supply time; the core never reads a
 * clock". That sentence is still true and is still what this type is for — what
 * changed is only which SPELLINGS of an instant it admits, and the realtime
 * lane's answer is a strict narrowing of the core lane's, driven by a defect the
 * core lane could not see from where it was standing: `packages/db` builds the
 * `core_events_payload_at_is_canonical_utc` CHECK out of `CANONICAL_TIMESTAMP`'s
 * own source, so a looser value type here is a type that admits rows Postgres
 * refuses. Nothing of the core lane's intent is dropped; the loose spelling is.
 * ------------------------------------------------------------------------- */

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

/**
 * **One instant, spelled several ways — and the sort key that reads all of them
 * the same.**
 *
 * `reduce.ts` promises a state that is byte-identical *"on any machine, in any
 * order of arrival — rows are canonically ordered by `(at, id)`"*. Until r8 that
 * order was a **lexical** comparison of the `at` strings, and the schema above
 * admits several spellings of one moment: `Z` and `+00:00`, any offset, and a
 * fractional part of any length or none. Lexically, `'.'` (U+002E) sorts before
 * `'Z'` (U+005A), so
 *
 * ```
 * "2026-01-01T00:00:00.500Z"  <  "2026-01-01T00:00:00Z"
 * ```
 *
 * — half a second **later** compares **earlier**. Appending the two in real-time
 * order made the second event `rejected / out_of_order`, permanently: the cursor
 * had already moved past it, and re-minting at that instant fails forever. Every
 * fixture in this package spells timestamps one way, so all 1059 tests were
 * blind to it, and `packages/ingest` canonicalises through `toISOString()`, so it
 * was latent rather than live. A contract hole is still a hole: the guarantee is
 * stated over *any* valid `Timestamp`, and nothing anywhere enforced the one
 * spelling it was true for.
 *
 * The repair is here rather than in the schema on purpose. Narrowing `Timestamp`
 * to a single spelling would push the problem onto every caller — an offset
 * timestamp is a *correct* ISO-8601 instant and refusing it would be this
 * package inventing a dialect — and it would not fix a log already written. So
 * the vocabulary stays open and **the comparison closes**: every accepted
 * spelling maps to one totally-ordered key.
 *
 * Pure, and deliberately not `Date.parse`. `Date` truncates to milliseconds, so
 * two instants that differ below a millisecond would collide and fall through to
 * the id tiebreak — ordering by id where the caller asked for ordering by time.
 * This reads the fields, converts the offset to UTC with `Date.UTC` (a pure
 * function of its arguments; no clock is read anywhere in this package), and
 * keeps the fraction at full width beside it.
 *
 * A string the pattern does not recognise is returned unchanged rather than
 * thrown on: this is a sort key, `compareCursor` must be total, and an
 * unparseable `at` has already been refused by `CoreEvent.parse` before any
 * fold sees it.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

export function instantKey(at: string): string {
  const match = ISO_INSTANT.exec(at);
  if (!match) return `?${at}`;
  const [, year, month, day, hour, minute, second, fraction, , sign, offsetHour, offsetMinute] =
    match;
  const offsetMinutes =
    sign === undefined
      ? 0
      : (sign === '-' ? -1 : 1) * (Number(offsetHour) * 60 + Number(offsetMinute));
  // `Date.UTC` maps years 0–99 onto 1900–1999, which would order a year-0050
  // timestamp between 1949 and 1951. Shifted forward by one full Gregorian
  // cycle — 400 years is exactly 146097 days, so the shift is lossless — and
  // subtracted back.
  const year4 = Number(year);
  const cycle = year4 < 100 ? 12_622_780_800_000 : 0;
  const utcMillis =
    Date.UTC(
      year4 + (cycle === 0 ? 0 : 400),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ) -
    cycle -
    offsetMinutes * 60_000;
  // Biased so the key is never negative — a sign character would sort the wrong
  // way round under a plain string comparison, which is the class of defect this
  // function exists to remove. The bias is the epoch value of `0000-01-01`.
  const biased = utcMillis + 62_167_219_200_000;
  // Sub-millisecond digits, kept beside the epoch value rather than folded into
  // it, so no precision is lost and the key stays a plain string comparison.
  const sub = (fraction ?? '').padEnd(9, '0');
  return `${String(biased).padStart(16, '0')}.${sub}`;
}

/**
 * Who did a thing. Mirrors `core_events.actor_kind` / `actor_id`.
 *
 * ## Four kinds, and the axis that separates them is not the one it looks like
 *
 * The union splits twice, along two different lines, and reading it as one line
 * is how a gate goes blind:
 *
 *  - **Identity.** `human` and `agent` carry a `userId` — a row in `users`, and
 *    therefore something that can hold a `memberships` row, be named by an
 *    attention item, and be pointed at by an attribution column. `model` and
 *    `system` carry no identity at all: a model is named by the model string it
 *    reported and a system actor is named by nothing.
 *  - **Humanity.** `human` alone is a person. `agent`, `model` and `system` are
 *    all machines, and `isHuman` (`authority.ts`) is false for every one of
 *    them, so every certification gate in `reduce.ts` refuses all three by the
 *    same predicate it always did.
 *
 * Before the `agent` variant existed those two lines coincided, and code could
 * read "carries a `userId`" as "is a person" and be accidentally right. It is
 * not right any more. `kind === 'human'` means *a person*; if what a call site
 * wants is *an identity*, it must ask for the `userId` and take `agent` with it.
 *
 * ## What `agent` is for
 *
 * A non-human participant that the room can actually address: it holds an
 * account, a workspace membership and a room membership, it speaks over the same
 * authenticated socket a person does, and its writes are attributed to its own
 * `users` row rather than landing anonymous. What it may not do is certify —
 * accept a decision, a commitment or an objective, verify a claim, correct an
 * accepted object, bind an answer, or retire one. Those refusals are not new
 * code; they are the existing `isHuman` gates, which now have an identified
 * machine to refuse instead of only an anonymous one.
 *
 * `Proposer` (`proposal.ts`) gained its own `agent` variant in #117, and the
 * answer to the two acceptance-semantics questions was the covenant-preserving
 * one: an agent proposer is a MACHINE proposer. The acceptance engine asks it
 * for a receipt window and applies θ exactly as it does a `model` — the receipt
 * is a property of the citations, not of which sort of machine read them — so
 * `apps/server` now stages an agent session's reading as `proposer_kind='agent'`
 * (its own `userId`) rather than refusing it. What did **not** move is the
 * certification boundary: an agent hits every `isHuman` gate as a model does, so
 * the widening opens WHO may STAGE a `~` and nothing about who may certify `✓`.
 */
export const Actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), userId: Id }),
  z.object({ kind: z.literal('agent'), userId: Id }),
  z.object({ kind: z.literal('model'), model: z.string().min(1) }),
  z.object({ kind: z.literal('system') }),
]);
export type Actor = z.infer<typeof Actor>;

/**
 * The kinds that name a row in `users`, and the only ones a `userId` can be
 * read off.
 *
 * A predicate rather than a `kind === 'human' || kind === 'agent'` written at
 * each call site: the question "does this actor have an identity?" is asked in
 * four packages, and a list repeated four times is a list that will disagree
 * with itself the next time the union grows. Deliberately *not* named anything
 * with "human" in it — the whole point is that it is not that question.
 */
export function actorUserId(actor: Actor): string | null {
  return actor.kind === 'human' || actor.kind === 'agent' ? actor.userId : null;
}

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
