import type { ResolvedSpan } from '@atrium/core';
import {
  type AnchorLoader,
  type CovenantAnchor,
  CovenantReadAuthority,
  type CovenantReadResult,
  type CovenantReadStatus,
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
 * Build a {@link CovenantReadAuthority} for the web surface: the ledger read
 * (`loadAnchor`, supplied by the surface — an API / Electric read of
 * `covenant_anchors`, out of SL-4's scope) bound to the production reader's async,
 * deadline-guarded resolve. One authority per resolution context (a room's ledger +
 * that room's live-doc reader).
 */
export function webCovenantReadAuthority(input: {
  readonly loadAnchor: AnchorLoader;
  readonly reader: CovenantDocReaderProd;
}): CovenantReadAuthority {
  return new CovenantReadAuthority({
    loadAnchor: input.loadAnchor,
    resolveSpan: readerSpanResolver(input.reader),
  });
}
