import {
  type CovenantAnchor,
  type CovenantDocReader,
  type RenderedFragment,
  type ResolvedSpan,
  resolveCovenant,
} from './covenant.js';

/**
 * THE READ AUTHORITY — the single fail-closed seam every display reader computes
 * `✓` through (Phase 6, #191 / SL-4, under #181). It loads an object's covenant
 * anchor from the ledger, re-resolves it against the live document, and answers a
 * THREE-valued status. This is the one place the object/span `✓` is decided; a
 * reader that computes it any other way is a hole (map #162, the #181 spine).
 *
 * ## The load-bearing decision: a SYNC contract over an ASYNC resolution
 *
 * `resolveCovenant` (#180) is sync and pure, but the two things it needs — the
 * ledger read (the anchor) and the production `CovenantDocReader` backed by a live
 * Electric/Yjs stream (#189, `resolveSpanAsync` + its deadline) — are ASYNCHRONOUS,
 * while EVERY display reader that renders the glyph today is SYNCHRONOUS. Bridging
 * that gap by dragging `await` through eight readers, or by blocking the event loop
 * on a stream, is exactly what this seam exists to prevent. So the authority splits
 * into two surfaces:
 *
 *   - {@link CovenantReadAuthority.resolve} — ASYNC. Does the real work (load the
 *     anchor, resolve the span under the reader's deadline, run the core verdict),
 *     fail-closed, and CACHES the definitive result.
 *   - {@link CovenantReadAuthority.read} — SYNC, pure, non-blocking. Returns the
 *     cached definitive result, or `unresolved` (`~`) while resolution is pending.
 *     A sync display reader calls THIS and never blocks, never awaits, never throws.
 *
 * ## Fail-CLOSED, and the third state
 *
 * The covenant is DETECT-only and fail-closed (#164): the ONLY status that renders
 * `✓` is a positively-resolved `ok`. Everything else is not-`✓`, split into two so
 * SL-6's readers can tell "we know it drifted / there is no `✓`" from "we do not
 * know yet":
 *
 *   - `drift`      — a DEFINITIVE not-`✓`. No anchor for the object; the doc is
 *                    unavailable/stalled (the async resolve concluded `null` at its
 *                    deadline); the live span drifted from the certified content; or
 *                    the reader/ledger THREW. Renders `~`. Never blocks a `✓`.
 *   - `unresolved` — resolution is IN FLIGHT and has not concluded. A TEMPORAL
 *                    state, only ever seen by a sync {@link read} before the async
 *                    {@link resolve} settles. Renders `~`. Crucially it is NOT `ok`
 *                    and NOT `drift`: painting a pending object `✓` would be a stale
 *                    lie, and painting it `drift` would false-stale a fine `✓`.
 *
 * `unavailable/stalled ⇒ drift` and `pending ⇒ unresolved` differ only in TIME: the
 * former is what the async resolve concludes once its deadline fires; the latter is
 * what a sync read sees before that. There is no OK-by-default and no OK-on-error
 * anywhere: a naive authority that returned `ok` while pending, or let a reader
 * throw escape, or read a missing anchor as `ok`, fails the not-theater proof.
 *
 * ## Purity
 *
 * This lives in `@atrium/core` and obeys its zero-I/O boundary: the ledger read and
 * the live-doc resolve are injected as async PORTS ({@link AnchorLoader},
 * {@link SpanResolver}), exactly as {@link CovenantDocReader} injects the Yjs work.
 * The app layer binds those ports (the drizzle query in `apps/server`, the
 * `CovenantDocReaderProd` in `apps/web`); the fail-closed contract is decided HERE,
 * under the core gate, so an adapter cannot quietly weaken it.
 */

/**
 * The status a display reader renders. `ok` is the ONLY `✓`; `drift` and
 * `unresolved` both render `~` but carry different meaning (see the module docblock).
 */
export type CovenantReadStatus = 'ok' | 'drift' | 'unresolved';

/** What the read authority answers for an object. Frozen; stable across calls. */
export interface CovenantReadResult {
  /** The object/span this status is for. */
  readonly objectId: string;
  /**
   * The revision the `✓` was bound to, or `null` when there is no anchor / the
   * resolution is pending or failed closed before an anchor was in hand.
   */
  readonly revision: number | null;
  /** The live re-rendered fragment for an `ok`/`drift` resolution, else `null`. */
  readonly renderedFragment: RenderedFragment | null;
  /** `ok` (`✓`) only for a byte-identical live span; `drift` / `unresolved` render `~`. */
  readonly covenantStatus: CovenantReadStatus;
}

/**
 * PORT 1 — load the persisted covenant anchor for an object from the ledger. A
 * `null` return means the object has no live `✓` (fail-closed ⇒ `drift`). The app
 * binding is the `covenant_anchors` read query (`apps/server`); a reject/throw is
 * caught by the authority and fails closed to `drift`, never propagates.
 */
export type AnchorLoader = (objectId: string) => Promise<CovenantAnchor | null>;

/**
 * PORT 2 — re-resolve an anchor against the live document, DEADLINE-BOUNDED. A
 * `null` return is the fail-closed signal (unavailable / stalled / GC'd / past the
 * deadline). The app binding is `CovenantDocReaderProd.resolveSpanAsync` (#189),
 * whose deadline is genuinely async and monotonic — a never-ready or slow-
 * eventually-ready stream yields `null` (⇒ `drift`) without a late `ok` and without
 * blocking the loop. A throw is caught here and fails closed to `drift`.
 *
 * The reader owns its OWN deadline internally, so the port carries no cancellation
 * signal — external abort of a display read is SL-6's concern (invalidation), not
 * the resolve seam's, and threading a DOM `AbortSignal` type through `@atrium/core`
 * would breach its `lib: ES2023` / `types: []` purity boundary for no SL-4 gain.
 */
export type SpanResolver = (anchor: CovenantAnchor) => Promise<ResolvedSpan | null>;

export interface CovenantReadAuthorityOptions {
  /** Load an object's anchor from the ledger. `null` ⇒ no `✓` ⇒ `drift`. */
  readonly loadAnchor: AnchorLoader;
  /** Re-resolve an anchor against the live doc, deadline-bounded. `null` ⇒ `drift`. */
  readonly resolveSpan: SpanResolver;
}

/** A pending (`~`) result for an object not yet resolved. Never a `✓`, never `drift`. */
function pending(objectId: string): CovenantReadResult {
  return Object.freeze({
    objectId,
    revision: null,
    renderedFragment: null,
    covenantStatus: 'unresolved',
  });
}

/** A definitive `drift` (`~`) result — missing anchor, unavailable doc, or a throw. */
function drift(objectId: string, revision: number | null): CovenantReadResult {
  return Object.freeze({
    objectId,
    revision,
    renderedFragment: null,
    covenantStatus: 'drift',
  });
}

/**
 * THE READ AUTHORITY. One instance is scoped to one resolution context (a room's
 * ledger + that room's live-doc reader); its ports carry the room binding. A
 * display reader holds the instance and calls {@link read} synchronously; the
 * surface (or SL-6's migration) drives {@link resolve} / {@link prime} to populate
 * the cache. Two reads of the same object return the IDENTICAL result object, so a
 * rendered fragment is byte-identical across every call site (acceptance #5).
 */
export class CovenantReadAuthority {
  /** The last DEFINITIVE (`ok`/`drift`) result per object. `read` returns this. */
  private readonly cache = new Map<string, CovenantReadResult>();
  /** In-flight resolutions, so concurrent callers share one and never double-resolve. */
  private readonly inflight = new Map<string, Promise<CovenantReadResult>>();

  constructor(private readonly opts: CovenantReadAuthorityOptions) {}

  /**
   * THE SYNC CONTRACT display readers call. Returns the cached definitive result,
   * or `unresolved` (`~`) while resolution is pending. NEVER blocks, NEVER awaits,
   * NEVER throws, and NEVER returns `ok` by default: an object nobody has resolved
   * yet is `~`, not `✓`. This is the whole point of the seam — a sync reader gets a
   * safe glyph now, and the real verdict once {@link resolve} has run.
   */
  read(objectId: string): CovenantReadResult {
    return this.cache.get(objectId) ?? pending(objectId);
  }

  /**
   * THE ASYNC RESOLUTION. Load the anchor, resolve the span under the reader's
   * deadline, and run the CORE verdict — fail-closed at every step — then cache and
   * return the definitive result. Concurrent calls for one object share a single
   * in-flight resolution (so both see the identical cached result, and the reader is
   * not driven twice). Re-calling after a result is cached RE-resolves (content can
   * drift later); {@link prime} is the deduped fire-and-forget variant for a reader
   * that only wants the first resolution.
   */
  resolve(objectId: string): Promise<CovenantReadResult> {
    const existing = this.inflight.get(objectId);
    if (existing) return existing;
    const p = this.compute(objectId)
      .then((result) => {
        this.cache.set(objectId, result);
        return result;
      })
      .finally(() => {
        this.inflight.delete(objectId);
      });
    this.inflight.set(objectId, p);
    return p;
  }

  /**
   * Fire-and-forget kick for a SYNC reader: start resolving an object if it is not
   * already resolved or in flight, and SWALLOW the result/rejection (`resolve` is
   * itself fail-closed, so there is never a real rejection to surface). A sync
   * reader calls `prime` then `read`: the first render shows `~`, a later render —
   * after the async resolution settled the cache — shows the real glyph. Deduped, so
   * priming in a hot render loop starts at most one resolution per object.
   */
  prime(objectId: string): void {
    if (this.cache.has(objectId) || this.inflight.has(objectId)) return;
    void this.resolve(objectId).catch(() => {
      /* resolve is fail-closed; nothing to surface */
    });
  }

  /** Kick resolution (deduped) AND sync-read in one call: `~` now, real glyph later. */
  peek(objectId: string): CovenantReadResult {
    this.prime(objectId);
    return this.read(objectId);
  }

  /**
   * The fail-closed core of {@link resolve}. Every branch that is not a positively
   * verified, digest-identical `ok` is `drift`; a missing anchor, an unavailable /
   * stalled doc (resolver `null`), and ANY throw (ledger read or reader) all fail
   * closed to `drift`. The OK/DRIFT verdict itself is DELEGATED to the core
   * {@link resolveCovenant} — the already-awaited async `ResolvedSpan` is fed back
   * through the sync {@link CovenantDocReader} port — so the meaning check (snapshot
   * verification, enclosed-item identity, and the rendered digest) is computed in
   * exactly ONE place and cannot drift between the sync and async paths.
   */
  private async compute(objectId: string): Promise<CovenantReadResult> {
    try {
      const anchor = await this.opts.loadAnchor(objectId);
      // No anchor ⇒ the object was never certified (or the `✓` was replaced/removed)
      // ⇒ DRIFT, fail-closed. Never `ok`, never `unresolved`.
      if (anchor === null) return drift(objectId, null);

      // Deadline-bounded resolve; `null` is unavailable / stalled / GC'd / past the
      // deadline ⇒ DRIFT (turned into it by resolveCovenant below).
      const resolved = await this.opts.resolveSpan(anchor);

      // Delegate the verdict to the ONE core primitive by adapting the awaited async
      // result into the sync port it consumes. resolveCovenant is itself guarded, so a
      // malformed anchor or a reader-shaped throw inside it also becomes `drift`.
      const adapter: CovenantDocReader = {
        captureSelection: () => null,
        authoritativeContext: () => null,
        resolveSpan: () => resolved,
      };
      const verdict = resolveCovenant(adapter, anchor);
      return Object.freeze({
        objectId,
        revision: verdict.revision,
        renderedFragment: verdict.renderedFragment,
        // resolveCovenant answers only `ok`/`drift`; `unresolved` is never a
        // definitive outcome, so the mapping is total and identity-preserving.
        covenantStatus: verdict.covenantStatus,
      });
    } catch {
      // A throw from the ledger read or the resolver is "could not faithfully
      // resolve" ⇒ fail-closed to DRIFT, never a propagated exception, never `ok`.
      return drift(objectId, null);
    }
  }
}
