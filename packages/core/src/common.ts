import { z } from 'zod';

/**
 * Shared primitives. Everything in this package is pure: no imports from
 * `node:*`, no network, no clock, no randomness. The reducer must be able to
 * replay the same event log on a server, in a worker, or in a browser and land
 * on a byte-identical state.
 */

export const Id = z.string().min(1);
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

/** ISO-8601 timestamp. Callers supply time; the core never reads a clock. */
export const Timestamp = z.iso.datetime({ offset: true });
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
