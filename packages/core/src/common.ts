import { z } from 'zod';

/**
 * Shared primitives. Everything in this package is pure: no imports from
 * `node:*`, no network, no clock, no randomness. The reducer must be able to
 * replay the same event log on a server, in a worker, or in a browser and land
 * on a byte-identical state.
 */

export const Id = z.string().min(1);
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
