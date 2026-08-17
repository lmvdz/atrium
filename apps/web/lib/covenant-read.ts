import type { ResolvedSpan } from '@atrium/core';
import {
  type AnchorLoader,
  type CovenantAnchor,
  CovenantReadAuthority,
  type CovenantReadResult,
  type CovenantReadStatus,
  type LiveFreshness,
  type SpanResolver,
} from '@atrium/core';
import type { CovenantDocReaderProd } from './covenant-reader.js';

/**
 * THE WEB SHAPE of the covenant read authority (#191 / SL-4) — the app binding that
 * points `@atrium/core`'s pure {@link CovenantReadAuthority} at the PRODUCTION
 * `CovenantDocReaderProd` (#189) on the surface. The load-bearing fail-closed
 * contract lives in core; this file only wires the live-doc `resolveSpan` port to
 * the reader's genuinely-async, deadline-bounded, cancellable `resolveSpanAsync`,
 * so a stalled Electric/Yjs stream yields `drift` at the deadline and a pending
 * resolution renders `~` — never a stale `✓` painted by a sync reader, and never
 * `await` dragged through the display readers (SL-6 consumes this seam).
 *
 * The types are re-exported so a display reader imports the whole covenant-read
 * surface from one place.
 */
export {
  type AnchorLoader,
  CovenantReadAuthority,
  type CovenantReadResult,
  type CovenantReadStatus,
  type LiveFreshness,
  type SpanResolver,
};

/**
 * Adapt a production reader's DEADLINE-BOUNDED async resolve into the core
 * {@link SpanResolver} port. `resolveSpanAsync` (#189, hardening c) returns `null`
 * for a never-ready / slow-eventually-ready / past-deadline stream — the fail-closed
 * signal the authority turns into `drift`. The reader owns its own monotonic
 * deadline internally, so the seam needs no external abort signal.
 */
export function readerSpanResolver(reader: CovenantDocReaderProd): SpanResolver {
  return (anchor: CovenantAnchor): Promise<ResolvedSpan | null> => reader.resolveSpanAsync(anchor);
}

/**
 * Adapt a production reader into the core {@link LiveFreshness} port — the SYNC
 * check that lets `read()` prove a cached `ok` is still fresh (SL-4 gauntlet FAIL:
 * `read()` must NEVER serve a stale `ok`). The token is the live doc's Yjs STATE
 * VECTOR, read via the reader's single non-blocking poll
 * (`authoritativeContext().stateVector`): ANY op that lands under the `✓` advances
 * it, so a `read()` after a drift re-samples a different token ⇒ demotes the stale
 * `ok` to `~` and kicks a re-resolve. A gone / stalled handle polls `null` ⇒ no
 * context ⇒ `null` token ⇒ the authority treats the cache as unprovable ⇒ `~` (the
 * staleness bound). The whole-doc state vector over-detects (an unrelated edit forces
 * a harmless re-resolve) — the fail-closed direction; it can never mint a stale `ok`.
 */
export function readerLiveFreshness(reader: CovenantDocReaderProd): LiveFreshness {
  return (_anchor: CovenantAnchor): string | null =>
    reader.authoritativeContext()?.stateVector ?? null;
}

/**
 * Build a {@link CovenantReadAuthority} for the web surface: the ledger read
 * (`loadAnchor`, supplied by the surface — an API / Electric read of
 * `covenant_anchors`, out of SL-4's scope) bound to the production reader's async,
 * deadline-guarded resolve AND its SYNC state-vector freshness sampler. One authority
 * per resolution context (a room's ledger + that room's live-doc reader).
 *
 * The `liveFreshness` wiring is what closes the SL-4 cardinal rule on the live path:
 * a cached `ok` whose span drifts is caught SYNCHRONOUSLY on the next `read()` and
 * demoted to `~`, even before SL-6's explicit `invalidate` arrives. Pass
 * `expectedRoomId` (SL-6's wiring) to also bind the room; the requested `objectId` is
 * bound unconditionally in core.
 */
export function webCovenantReadAuthority(input: {
  readonly loadAnchor: AnchorLoader;
  readonly reader: CovenantDocReaderProd;
  readonly expectedRoomId?: string;
}): CovenantReadAuthority {
  return new CovenantReadAuthority({
    loadAnchor: input.loadAnchor,
    resolveSpan: readerSpanResolver(input.reader),
    liveFreshness: readerLiveFreshness(input.reader),
    expectedRoomId: input.expectedRoomId,
  });
}
