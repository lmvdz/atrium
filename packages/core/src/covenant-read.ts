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

/**
 * PORT 3 (optional but PRODUCTION-REQUIRED) — sample the live document's CURRENT
 * freshness token for an anchor's span, SYNCHRONOUSLY and cheaply. This is the sync
 * check that lets {@link CovenantReadAuthority.read} prove a cached `ok` is still
 * fresh WITHOUT awaiting, and is the mechanism that closes the cardinal rule (SL-4
 * gauntlet FAIL): **`read()` must NEVER serve a stale `ok`.**
 *
 * The token MUST be a COMPOSITE of the live doc's Yjs STATE VECTOR **and its DELETE
 * SET** (SL-4 fix round 2, CRITICAL). `Y.encodeStateVector` records only max-seen
 * clocks — an INSERT advances it, but a pure DELETION lands in the delete SET and
 * leaves the state vector UNCHANGED. A state-vector-only token therefore misses the
 * whole delete class: a char/embed deleted from the certified span reads `S === S`,
 * the cache is called fresh, and the old `ok` is served INDEFINITELY over content the
 * digest (and #180's anchor) already know drifted. Composing the delete set in closes
 * that: this is the SAME SV-vs-delete-set completeness #180's anchor already encodes
 * (`stateVector` + `deleteSet`), and the freshness token must match it. The app
 * binding reuses the production reader's own `authoritativeContext()` — which already
 * computes both `stateVector` and `deleteSet` for the anchor — and concatenates them
 * (a single non-blocking poll of the live `Y.Doc`), so ANY drift the digest catches —
 * insert, delete, delete+reinsert, format — advances the token.
 *
 * The authority captures this token at resolve time and re-samples it on every
 * `read()`; **any difference — or a `null` (doc gone / cannot sample) — is treated as
 * STALE**, so `read()` returns `~` and kicks an async re-resolve. The whole-doc token
 * over-detects (an unrelated edit triggers a harmless re-resolve), which is the
 * fail-closed direction: it can only ever demote a stale `ok` to `~`, never mint one.
 *
 * When this port is ABSENT the authority is in STATIC-DOC mode: a cached result is
 * served as-is, and freshness is driven ONLY by the explicit {@link
 * CovenantReadAuthority.invalidate} hook. The web binding always wires this port; the
 * server binding (no sync doc handle) relies on `invalidate` from the #182 drift sweep.
 */
export type LiveFreshness = (anchor: CovenantAnchor) => string | null;

export interface CovenantReadAuthorityOptions {
  /** Load an object's anchor from the ledger. `null` ⇒ no `✓` ⇒ `drift`. */
  readonly loadAnchor: AnchorLoader;
  /** Re-resolve an anchor against the live doc, deadline-bounded. `null` ⇒ `drift`. */
  readonly resolveSpan: SpanResolver;
  /**
   * OPTIONAL sync freshness sampler (production-required). See {@link LiveFreshness}:
   * with it, `read()` proves a cached `ok` is still fresh synchronously (a stale `ok`
   * can never be served, even before an explicit {@link CovenantReadAuthority.invalidate});
   * without it, freshness is driven only by `invalidate`.
   */
  readonly liveFreshness?: LiveFreshness;
  /**
   * FAIL-CLOSED when freshness cannot be proven (SL-4 fix round 2, HIGH — the server
   * static-mode fail-open). When `true` AND no {@link liveFreshness} port is wired, a
   * cached `ok` is UNPROVABLE (there is no sync doc handle to sample), so `read()`
   * serves it as `unresolved` (`~`) rather than trusting it — a server-cached `ok`
   * must never outlive a drift the server cannot yet observe.
   *
   * ## The `#182-before-server-✓` sequencing constraint
   *
   * The server binding has NO sync doc handle, so its ONLY freshness signal is the
   * explicit {@link CovenantReadAuthority.invalidate} hook that SL-6 / #182's
   * drift-on-update sweep calls. Until #182 is implemented and wired, NOTHING calls
   * `invalidate`, so a server-cached `ok` would survive live drift indefinitely — the
   * exact fail-open the gauntlet caught. This flag makes the interim fail-closed: the
   * server serves `~` for any cached `ok` it cannot prove fresh, and a server-path `✓`
   * is only reachable once #182 guarantees invalidate-on-drift (an entry that survives
   * an invalidate-covered window IS proven fresh — the guard drops any that drifted).
   * This is a HARD sequencing constraint: **do not flip the server to trust a cached
   * `ok` (clear this flag) before #182's invalidate-on-drift is live.**
   *
   * ## What the flag does, precisely (E7, #199 Fix 4)
   *
   * With the flag SET, a sync {@link CovenantReadAuthority.read} NEVER vouches for a
   * cached `ok` on its own — it demotes every cached `ok` to `~`. Freshness is driven
   * ENTIRELY by the explicit {@link CovenantReadAuthority.invalidate} hook (the drift
   * sweep calls it on every content update) plus a fresh `resolve()`; a cached `ok` is
   * only ever re-established by a resolve that ran after the last invalidate. There is
   * NO caller boolean and NO `sweepLive` gate that "opens" trust — an earlier round
   * shipped a `markSweepLive`/`sweepLive` mechanism for exactly that, but it was DEAD on
   * the production wiring (production binds the web authority, which has a
   * {@link liveFreshness} port and never reaches this branch), so it was removed rather
   * than kept as a guarantee production does not exercise.
   *
   * Absent / `false` (the default, and the invalidate-driven mode the web binding uses
   * alongside its always-wired freshness port): a cached result is trusted until an
   * explicit `invalidate` drops it — the pre-existing static-doc contract.
   */
  readonly failClosedWithoutFreshness?: boolean;
  /**
   * OPTIONAL room binding. When set, the loaded anchor's `roomId` MUST equal it, else
   * the authority fails closed to `drift` — defence-in-depth against a loader / cache /
   * cross-room mix-up handing back an anchor for a different room (the requested
   * `objectId` binding is enforced unconditionally; see {@link CovenantReadAuthority}).
   */
  readonly expectedRoomId?: string;
}

/**
 * DEEP-FREEZE a value in place and return it (SL-4 gauntlet MEDIUM). `Object.freeze`
 * is SHALLOW: a frozen {@link CovenantReadResult} still had a MUTABLE
 * `renderedFragment.nodes` (and `.ancestors`, each node's `marks`, every `attrs` /
 * `identity` map), so a single consumer mutating one node altered the content EVERY
 * cached reader sees — under status `ok`. Freezing the whole fragment tree closes that:
 * the shared, cached fragment is immutable, so no reader can rewrite another's `✓`.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
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
 * A cached resolution, plus the metadata {@link CovenantReadAuthority.read} needs to
 * decide, SYNCHRONOUSLY, whether it is still fresh: the `anchor` it was resolved
 * against (to re-sample the live freshness token), the freshness `token` captured at
 * resolve time, and the `generation` the compute ran under (for the invalidation guard).
 */
interface CacheEntry {
  readonly result: CovenantReadResult;
  /** The anchor this result resolved against; `null` for a no-anchor / thrown `drift`. */
  readonly anchor: CovenantAnchor | null;
  /** The live freshness token sampled at resolve time; `null` if unsampled/no port. */
  readonly token: string | null;
  /** The invalidation generation this compute started under (see {@link invalidate}). */
  readonly generation: number;
}

/**
 * THE READ AUTHORITY. One instance is scoped to one resolution context (a room's
 * ledger + that room's live-doc reader); its ports carry the room binding. A
 * display reader holds the instance and calls {@link read} synchronously; the
 * surface (or SL-6's migration) drives {@link resolve} / {@link prime} to populate
 * the cache. Two reads of the same object return the IDENTICAL result object, so a
 * rendered fragment is byte-identical across every call site (acceptance #5).
 *
 * ## THE CARDINAL RULE — `read()` NEVER serves a stale `ok` (SL-4 gauntlet FAIL)
 *
 * A cached `ok` MUST NOT outlive the live content it vouched for. `read()` therefore
 * proves freshness SYNCHRONOUSLY before returning a cached `ok`, through three
 * mechanisms that compose (each fail-closed):
 *
 *   1. **Sync state-vector freshness** ({@link LiveFreshness}). The cache captures the
 *      live doc's freshness token (its state vector) at resolve time; `read()` re-samples
 *      it and returns `~` (kicking an async re-resolve) on ANY advance — or on a `null`
 *      sample (doc gone). This catches drift with NO explicit signal, the instant a
 *      `read()` observes it.
 *   2. **Generation guard** ({@link invalidate}). A `compute()` that STARTED before an
 *      invalidation cannot repopulate the cache: its result is dropped if the object's
 *      generation advanced meanwhile. This closes the "a `resolve()` that JOINED a
 *      pre-drift in-flight computation recaches the stale `ok`" hole — the join is severed
 *      (invalidate clears the in-flight entry) AND the late result is refused.
 *   3. **Staleness bound.** A stalled refresh degrades to `~`, never an indefinite stale
 *      `✓`: once the token no longer matches, `read()` keeps returning `~` regardless of
 *      whether the kicked re-resolve ever settles.
 *
 * {@link invalidate} is the synchronous hook SL-6 / #182's drift-on-update calls; the
 * sync SV check means a stale `ok` cannot be served even in the window BEFORE an explicit
 * invalidate arrives.
 */
export class CovenantReadAuthority {
  /** The last DEFINITIVE (`ok`/`drift`) result per object, with freshness metadata. */
  private readonly cache = new Map<string, CacheEntry>();
  /** In-flight resolutions, so concurrent callers share one and never double-resolve. */
  private readonly inflight = new Map<string, Promise<CovenantReadResult>>();
  /** Per-object invalidation generation — bumped by {@link invalidate}; guards recache. */
  private readonly generation = new Map<string, number>();
  constructor(private readonly opts: CovenantReadAuthorityOptions) {}

  /**
   * INVALIDATE EVERY currently-known object at once (E7, #199) — the teardown hook a
   * sweep calls on `stop()`/evict so a torn-down sweep never leaves a stale cached `ok`
   * behind. Drops every cached result and bumps every generation (cached AND in-flight),
   * so `read()` returns `~` immediately and no resolve kicked before the teardown can
   * recache an `ok` afterwards.
   */
  invalidateAll(): void {
    // Snapshot both key sets first — invalidate() mutates the maps as it runs.
    for (const objectId of new Set([...this.cache.keys(), ...this.inflight.keys()])) {
      this.invalidate(objectId);
    }
  }

  private generationOf(objectId: string): number {
    return this.generation.get(objectId) ?? 0;
  }

  /** Sample the live freshness token for an anchor, fail-closed (a throw ⇒ `null`). */
  private sampleFreshness(anchor: CovenantAnchor): string | null {
    if (!this.opts.liveFreshness) return null;
    try {
      return this.opts.liveFreshness(anchor);
    } catch {
      return null;
    }
  }

  /**
   * Is a cached `ok` still PROVABLY FRESH, synchronously? With a {@link LiveFreshness}
   * port and an anchor, the live token must still equal the one captured at resolve
   * time; ANY advance, or a `null` sample (doc gone / cannot prove), is STALE. Without
   * the port (static-doc mode) or for a no-anchor entry (no live span to be stale
   * about) the `ok` is trusted — freshness is then driven only by {@link invalidate}.
   *
   * Applied ONLY to a cached `ok` (the only status that can be a stale LIE); a cached
   * `drift` already renders `~` and is fail-closed, so it is served as-is (matching the
   * pre-SL-4 behaviour — a `drift`, e.g. from a stalled doc, must not be re-labelled
   * `unresolved` just because freshness cannot be sampled).
   */
  private isFresh(entry: CacheEntry): boolean {
    if (this.opts.liveFreshness) {
      if (entry.anchor === null) return true; // no live span (no-anchor / thrown result)
      const current = this.sampleFreshness(entry.anchor);
      if (current === null) return false; // cannot prove fresh ⇒ STALE ⇒ `~`
      return current === entry.token; // any freshness-token advance (SV or delete set) ⇒ STALE
    }
    // No freshness port.
    if (this.opts.failClosedWithoutFreshness) {
      // FAIL-CLOSED: an authority with no sync doc handle cannot PROVE a cached `ok` is
      // still fresh, so `read()` never serves it — it is demoted to `~` and freshness is
      // driven ENTIRELY by the explicit `invalidate` hook (the drift sweep calls it on
      // every content update) plus a fresh `resolve()` per read. A cached `ok` that
      // survives is only ever re-established by a resolve that ran AFTER the last
      // invalidate; the sync `read()` never vouches for one on its own. (E7, #199 Fix 4:
      // the old `sweepLive`/`markSweepLive` trust-gate was DEAD on the production wiring —
      // production binds the web authority, which has a `liveFreshness` port and never
      // reached this branch — so it was removed rather than shipped as a false guarantee.)
      return false;
    }
    // No port and not fail-closed ⇒ the pre-existing invalidate-driven trust: a cached
    // result is trusted until an explicit `invalidate` drops it.
    return true;
  }

  /**
   * THE SYNC CONTRACT display readers call. Returns the cached definitive result, but
   * a cached `ok` ONLY WHEN IT IS PROVABLY FRESH — else `unresolved` (`~`). NEVER
   * blocks, NEVER awaits, NEVER throws, NEVER returns `ok` by default — and, the SL-4
   * close, NEVER returns a STALE `ok`: a cached `ok` whose live span has advanced since
   * it resolved (or whose freshness cannot be proven) is demoted to `~` here, and an
   * async re-resolve is kicked. A cached `drift` (already the safe `~` glyph) is served
   * directly. So a sync reader gets a safe glyph now, and the current verdict later.
   */
  read(objectId: string): CovenantReadResult {
    const entry = this.cache.get(objectId);
    if (entry === undefined) return pending(objectId);
    if (entry.result.covenantStatus === 'ok' && !this.isFresh(entry)) {
      // Stale (or unprovable) `✓`: refuse to serve it, and kick a re-resolve so a later
      // read reflects the current verdict. The staleness bound: until that re-resolve
      // settles fresh, every read stays `~` — never the indefinite stale `✓`.
      this.kickRefresh(objectId);
      return pending(objectId);
    }
    return entry.result;
  }

  /**
   * THE ASYNC RESOLUTION. Load the anchor, resolve the span under the reader's
   * deadline, and run the CORE verdict — fail-closed at every step — then cache and
   * return the definitive result. Concurrent calls for one object share a single
   * in-flight resolution (so both see the identical cached result, and the reader is
   * not driven twice). Re-calling after a result is cached RE-resolves (content can
   * drift later); {@link prime} is the deduped fire-and-forget variant for a reader
   * that only wants the first resolution.
   *
   * GENERATION GUARD: a compute is stamped with the object's generation at the moment
   * it STARTS; its result is written to the cache only if that generation has not
   * advanced by the time it settles. An {@link invalidate} during the compute therefore
   * DROPS the (now-stale) result rather than letting it repopulate the cache — including
   * a second caller that joined this same in-flight computation before the drift.
   */
  resolve(objectId: string): Promise<CovenantReadResult> {
    const existing = this.inflight.get(objectId);
    if (existing) return existing;
    const startGeneration = this.generationOf(objectId);
    const p = this.compute(objectId, startGeneration)
      .then((entry) => {
        // Generation guard: only cache if no invalidation landed since this compute
        // started. Otherwise the result predates a drift ⇒ drop it (read stays `~`).
        if (this.generationOf(objectId) === startGeneration) {
          this.cache.set(objectId, entry);
          return entry.result;
        }
        // Invalidated mid-flight (SL-4 fix round 2, HIGH). The compute — and every caller
        // AWAITING this same in-flight promise — predates a drift the generation guard
        // already refused to cache. Handing those awaiters `entry.result` would leak the
        // superseded verdict (a stale `ok`) to the very readers that asked. Fail-closed:
        // they get `unresolved` (`~`) instead, exactly what a sync `read()` now returns
        // for the dropped entry, and a subsequent resolve()/prime() re-resolves under the
        // new generation. Never the dropped `ok`.
        return pending(objectId);
      })
      .finally(() => {
        // Only clear if WE are still the registered in-flight (invalidate may have
        // cleared it and a fresh resolve may have taken the slot).
        if (this.inflight.get(objectId) === p) this.inflight.delete(objectId);
      });
    this.inflight.set(objectId, p);
    return p;
  }

  /**
   * INVALIDATE an object's cached `✓` SYNCHRONOUSLY — the hook SL-6 / #182's
   * drift-on-update calls the instant it mutates a certified span. Three effects,
   * all immediate: (1) bump the object's generation, so any in-flight compute that
   * started earlier can no longer repopulate the cache (the generation guard drops
   * it); (2) drop the cached result, so `read()` returns `~` at once; (3) clear the
   * in-flight entry, so a subsequent `resolve()`/`prime()` starts a FRESH compute
   * under the new generation rather than joining the pre-drift one.
   */
  invalidate(objectId: string): void {
    this.generation.set(objectId, this.generationOf(objectId) + 1);
    this.cache.delete(objectId);
    this.inflight.delete(objectId);
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

  /**
   * Kick a REFRESH of an object whose cached result went stale (the {@link read}
   * staleness path). Unlike {@link prime} it does NOT early-out on a present cache
   * entry — a stale entry is exactly what must be re-resolved — but it still dedupes on
   * the in-flight map, so a hot render loop over a stale object starts at most one
   * re-resolve, not a storm.
   */
  private kickRefresh(objectId: string): void {
    if (this.inflight.has(objectId)) return;
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
   * verified, digest-identical `ok` is `drift`; a missing anchor, an anchor that is
   * not for the requested object/room, an unavailable / stalled doc (resolver `null`),
   * and ANY throw (ledger read or reader) all fail closed to `drift`. The OK/DRIFT
   * verdict itself is DELEGATED to the core {@link resolveCovenant} — the already-
   * awaited async `ResolvedSpan` is fed back through the sync {@link CovenantDocReader}
   * port — so the meaning check (snapshot verification, enclosed-item identity, and the
   * rendered digest) is computed in exactly ONE place and cannot drift between paths.
   *
   * Returns the {@link CacheEntry} (result + freshness metadata); {@link resolve}
   * decides, under the generation guard, whether to install it.
   */
  private async compute(objectId: string, generation: number): Promise<CacheEntry> {
    const miss = (): CacheEntry => ({
      result: drift(objectId, null),
      anchor: null,
      token: null,
      generation,
    });
    try {
      const anchor = await this.opts.loadAnchor(objectId);
      // No anchor ⇒ the object was never certified (or the `✓` was replaced/removed)
      // ⇒ DRIFT, fail-closed. Never `ok`, never `unresolved`.
      if (anchor === null) return miss();

      // BIND the requested object (and room, when configured) to the LOADED anchor
      // (SL-4 gauntlet HIGH). `resolveCovenant` ignores provenance ids and the authority
      // stamps the REQUESTED `objectId`, so an anchor loaded for a DIFFERENT object or
      // room — a loader / cache / cross-room mix-up — would otherwise paint the wrong
      // object's `✓`. Refuse it here, fail-closed to `drift`.
      if (anchor.objectId !== objectId) return miss();
      if (this.opts.expectedRoomId !== undefined && anchor.roomId !== this.opts.expectedRoomId) {
        return miss();
      }

      // Sample the live freshness token BEFORE resolving: if the doc advances during or
      // after the resolve, the captured token under-approximates the resolved state, so a
      // later `read()` reads STALE and re-resolves — the fail-closed direction (it can
      // only demote a stale `ok` to `~`, never serve one).
      const token = this.sampleFreshness(anchor);

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
      const result = Object.freeze({
        objectId,
        revision: verdict.revision,
        // DEEP-freeze the shared cached fragment so a consumer mutation cannot rewrite
        // every reader's `✓` content (SL-4 gauntlet MEDIUM).
        renderedFragment: deepFreeze(verdict.renderedFragment),
        // resolveCovenant answers only `ok`/`drift`; `unresolved` is never a
        // definitive outcome, so the mapping is total and identity-preserving.
        covenantStatus: verdict.covenantStatus,
      });
      return { result, anchor, token, generation };
    } catch {
      // A throw from the ledger read or the resolver is "could not faithfully
      // resolve" ⇒ fail-closed to DRIFT, never a propagated exception, never `ok`.
      return miss();
    }
  }
}
