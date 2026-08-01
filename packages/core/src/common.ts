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

/** ISO-8601 timestamp. Callers supply time; the core never reads a clock. */
export const Timestamp = z.iso.datetime({ offset: true });
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
