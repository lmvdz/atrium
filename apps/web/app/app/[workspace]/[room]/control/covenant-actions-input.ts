import { z } from 'zod';

/**
 * THE CERTIFY-OBJECT/SPAN REQUEST SCHEMA (extracted from `covenant-actions.ts`,
 * P6F-2 / #196).
 *
 * Kept in its OWN module — not inline in the `'use server'` action file — for two
 * reasons: a `'use server'` module may export ONLY async server functions (a Next
 * build constraint), so a shared schema const cannot live there; and the schema is
 * the exact refusal boundary a test must pin without dragging the action's
 * server-only dependency graph into the test.
 *
 * ## Why `.strict()` (P6F-2 gauntlet LOW — REFUSE, don't strip)
 *
 * The request carries ONLY which object and which span the human gestured over —
 * an object id, a body path, and char offsets. Everything RESOLUTION-BEARING (a
 * `renderedDigest`, a `stateVector` / `deleteSet`, a `relStart` / span boundary,
 * a certifier / `principalKind`) is derived SERVER-SIDE by the authoritative
 * reader; none of it may come from the client. A NON-strict `z.object` would
 * SILENTLY STRIP such a field and parse the request as valid — indistinguishable,
 * to the client, from a request that never carried it. The covenant's promise is
 * REFUSAL, not laundering: `.strict()` makes a request that attempts to supply any
 * resolution-bearing (or otherwise unknown) field FAIL validation, so the action
 * returns `derive_failed` rather than proceeding on a stripped payload.
 */
export const CertifyObjectSpanInput = z
  .object({
    workspaceSlug: z.string().min(1).max(200),
    roomSlug: z.string().min(1).max(200),
    /** The accepted object whose span is being certified. */
    objectId: z.uuid(),
    /** The path of child indices from the content root to the span's `Y.XmlText` body. */
    bodyPath: z.array(z.number().int().nonnegative()).max(64),
    /** The selected character range within that body — the human's gesture, not context. */
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict();

/** The parsed, validated certify request — WHICH object + WHICH span, nothing more. */
export type CertifyObjectSpanRequest = z.infer<typeof CertifyObjectSpanInput>;

/**
 * THE COVENANT-SWEEP POKE REQUEST (#220 / T6) — WHICH room to re-verdict.
 *
 * The yjs surface syncs its conversation purely over Electric; it never calls
 * `router.refresh()`, so the server-authoritative replica has no trigger to
 * re-consume peer edits and re-run the drift sweep that projects `covenant_status`
 * (the client glyph shape). This request drives that: the client polls it while
 * mounted, the action re-acquires the room's replica (folding new durable ops), and
 * the sweep re-verdicts every certified span. It carries ONLY the room locators —
 * membership is re-checked server-side; nothing resolution-bearing crosses. `.strict()`
 * for the same reason the certify input is: refuse an unknown field, never strip it.
 */
export const PokeCovenantSweepInput = z
  .object({
    workspaceSlug: z.string().min(1).max(200),
    roomSlug: z.string().min(1).max(200),
  })
  .strict();

/** The parsed, validated sweep-poke request — WHICH room, nothing more. */
export type PokeCovenantSweepRequest = z.infer<typeof PokeCovenantSweepInput>;
