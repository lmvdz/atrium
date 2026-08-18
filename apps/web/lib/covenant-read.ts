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
 * THE NARROW READ SURFACE a display glyph reader consumes (#193 / SL-6, under
 * #181). A migrated reader computes `✓`/`~` for an object through THIS and nothing
 * else — never `humanTouchedAt`/`acceptedByKind` alone — so the glyph's meaning is
 * "the certified content still resolves to the exact certified fragment", decided
 * in the ONE fail-closed authority.
 *
 * It is exactly the SYNC-KICK read {@link CovenantReadAuthority.peek} provides:
 * prime the async resolve if needed, then return the cached definitive result, or
 * `unresolved` (`~`) while a resolve is in flight. A synchronous render therefore
 * gets a safe `~` on the first frame and the real glyph on the re-render after the
 * async resolution settles — no `await` dragged through the readers, no stale `✓`.
 * The full `CovenantReadAuthority` satisfies this by structural typing; a test may
 * inject any object with a matching `peek`.
 */
export interface ObjectGlyphResolver {
  /** Sync-kick + read: `~` (`unresolved`) now, the real glyph once the resolve settles. */
  peek(objectId: string): CovenantReadResult;
}

/**
 * The CLIENT-side {@link ObjectGlyphResolver} over verdicts already resolved on the
 * SERVER (#198, P6F-4). The read authority resolves against the room's
 * server-authoritative replica (`roomCovenantReads`, `'server-only'`); its
 * `{ objectId → status }` map is serialized into the surface's props, and this wraps
 * it so the migrated readers source `✓`/`~` through the SAME `anchorCertifies` seam
 * they always have — no client-side live `Y.Doc` (there is none; P6F-2 made the
 * authoritative doc server-side), no `await` in a render.
 *
 * `peek` is a pure map read: a resolved `ok` is `✓`, anything else — a `drift`, or an
 * object absent from the map — is `~`, fail-closed. When no reads were computed
 * (`reads === undefined`, e.g. a hand-built fixture with no live doc), this returns
 * `undefined`, so the surface stays exactly as fail-closed as an unwired resolver:
 * every glyph is `~`. `anchorCertifies` only ever reads `covenantStatus`, so the
 * `revision`/`renderedFragment` a full authority carries are not reconstructed.
 */
export function precomputedGlyphResolver(
  reads: Readonly<Record<string, CovenantReadStatus>> | undefined,
): ObjectGlyphResolver | undefined {
  if (reads === undefined) return undefined;
  return {
    peek(objectId: string): CovenantReadResult {
      const covenantStatus: CovenantReadStatus = reads[objectId] ?? 'drift';
      return { objectId, revision: null, renderedFragment: null, covenantStatus };
    },
  };
}

/**
 * One synced `covenant_status` row, as the client folds it off the Electric shape
 * (#218 / T4). The column names are the WIRE names (snake_case) the shape streams —
 * `object_id`, `status`, `generation` — NOT the camelCase the server binding uses:
 * `apps/web/app/electric/v1/shape/route.ts` forwards no column mapper, so the rows
 * arrive with their Postgres names. `generation` is a bigint on the wire and can
 * surface as a number, a bigint, or a string depending on the client parser, so the
 * fold coerces it through `Number` rather than assuming one.
 */
export interface SyncedCovenantStatusRow {
  readonly object_id: string;
  readonly status: CovenantReadStatus;
  readonly generation?: number | bigint | string | null;
}

/**
 * A LIVE {@link ObjectGlyphResolver} whose verdict map updates as the per-room
 * `covenant_status` Electric shape streams (#218 / T4 — the live flip). It is the
 * live twin of {@link precomputedGlyphResolver}: the SAME fail-closed `✓` gate
 * (`✓` ONLY on `status === 'ok'`), sourced from a map that MUTATES in place as the
 * shape emits, instead of a frozen SSR snapshot refreshed only by `router.refresh()`.
 *
 * `replace` folds the shape's CURRENT materialised rows into the map — the caller
 * hands it `shape.currentRows` on every subscribe notification, and `@electric-sql`'s
 * `Shape` has already collapsed the log to one row per primary key, so a re-render
 * after an in-range peer edit sees the drifted verdict and the glyph flips `✓`→`~`
 * within a render tick. A row DROPPED from the shape (an object pruned by cascade)
 * simply vanishes from the rebuilt map and reads `~`, fail-closed.
 */
export interface LiveGlyphResolver extends ObjectGlyphResolver {
  /** Rebuild the verdict map from the shape's current rows (newest generation wins). */
  replace(rows: Iterable<SyncedCovenantStatusRow>): void;
}

/**
 * Build a {@link LiveGlyphResolver} (#218 / T4). Optionally SEEDED from the SSR
 * `{ objectId → status }` map (`data.covenantReads`) so the first client paint is the
 * server's verdict rather than a flash of all-`~` while the shape connects; the shape's
 * first up-to-date snapshot then `replace`s the seed and every live delta after it.
 *
 * `peek` is the SAME pure map read as {@link precomputedGlyphResolver}: a synced `ok`
 * is `✓`; a `drift`/`unresolved`, an object absent from the map, or a not-yet-synced
 * shape is `~`, fail-closed. NEVER treat "a row exists" as `✓` — only `status === 'ok'`
 * certifies, and `anchorCertifies` remains the single gate that decides it. A status
 * that is not one of the three known kinds is coerced to `drift`, so a corrupted wire
 * value can never mint a `✓`.
 *
 * ## TODO (#218, DO NOT build here — reserved): the un-certify prune seam
 *
 * When un-certify lands (anchor-delete-WITHOUT-object-delete), a stranded verdict can
 * outlive its anchor: the `covenant_status` row survives (its FK is to the OBJECT, not
 * the anchor), and the sweep's logical `generation` RESETS to 1 on prune. A gen-1
 * verdict then cannot overwrite a stored gen-N row (the `< excluded.generation` guard
 * in `upsertCovenantStatus`, and the newest-wins fold here), so a stale `ok` could
 * strand as a `✓` after the human signature that justified it is gone. This resolver
 * folds newest-generation-wins on purpose; the guard for the reset seam belongs with
 * un-certify, NOT here. Noted, not built (T4 scope boundary).
 */
export function liveGlyphResolver(
  seed?: Readonly<Record<string, CovenantReadStatus>>,
): LiveGlyphResolver {
  const map = new Map<string, CovenantReadStatus>();
  const generations = new Map<string, number>();
  if (seed) {
    for (const [objectId, status] of Object.entries(seed)) map.set(objectId, status);
  }
  return {
    replace(rows: Iterable<SyncedCovenantStatusRow>): void {
      map.clear();
      generations.clear();
      for (const row of rows) {
        const objectId = row.object_id;
        if (typeof objectId !== 'string' || objectId.length === 0) continue;
        // A defensive newest-wins fold: `Shape` already collapses the log to one
        // row per (room, object_id) PK, so a duplicate object_id here is not
        // expected — but if one appears, the strictly-newer generation wins, the
        // same monotone rule the durable `upsertCovenantStatus` guard enforces.
        const generation = Number(row.generation ?? 0);
        const seen = generations.get(objectId);
        if (seen !== undefined && seen >= generation) continue;
        generations.set(objectId, Number.isFinite(generation) ? generation : 0);
        // Fail-closed on any status that is not a known kind: only `ok` ever
        // certifies, so an unrecognised value must never survive as one.
        const status: CovenantReadStatus =
          row.status === 'ok' || row.status === 'drift' || row.status === 'unresolved'
            ? row.status
            : 'drift';
        map.set(objectId, status);
      }
    },
    peek(objectId: string): CovenantReadResult {
      const covenantStatus: CovenantReadStatus = map.get(objectId) ?? 'drift';
      return { objectId, revision: null, renderedFragment: null, covenantStatus };
    },
  };
}

/**
 * The ONE place the migrated display readers turn a covenant read into the boolean
 * `certified` gate (#193 / SL-6). `✓` ONLY when the authority positively resolves
 * the object's certified content (`covenantStatus === 'ok'`); `~` for `drift` /
 * `unresolved` / a missing object, and `~` when NO authority is wired
 * (`resolver === undefined`) — fail-CLOSED, because provenance alone must never
 * mint `✓`. Using {@link ObjectGlyphResolver.peek} makes a sync render kick the
 * async resolve and re-render with the settled verdict.
 */
export function anchorCertifies(
  resolver: ObjectGlyphResolver | undefined,
  objectId: string,
): boolean {
  return resolver !== undefined && resolver.peek(objectId).covenantStatus === 'ok';
}

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
 * `read()` must NEVER serve a stale `ok`).
 *
 * The token is a COMPOSITE of the live doc's Yjs STATE VECTOR **and its DELETE SET**
 * (SL-4 fix round 2, CRITICAL). A state-vector-ONLY token misses the DELETE class:
 * `Y.encodeStateVector` records max-seen clocks, so a pure deletion — an ordinary
 * backspace in the live editor — lands in the delete set and leaves the state vector
 * UNCHANGED, and a `read()` would see `S === S`, call the cache fresh, and serve the
 * old `ok` INDEFINITELY over deleted content (the exact bug the round-2 gauntlet
 * measured). We reuse the reader's SINGLE non-blocking `authoritativeContext()` poll —
 * which ALREADY computes both `stateVector` and `deleteSet` for the anchor, the same
 * pair #180's anchor is signed over — and concatenate them, so ANY drift the digest
 * catches (insert, delete, delete+reinsert, format) moves the token. A `read()` after
 * a drift re-samples a different token ⇒ demotes the stale `ok` to `~` and kicks a
 * re-resolve. A gone / stalled handle polls `null` ⇒ no context ⇒ `null` token ⇒ the
 * authority treats the cache as unprovable ⇒ `~` (the staleness bound). The whole-doc
 * token over-detects (an unrelated edit forces a harmless re-resolve) — the fail-closed
 * direction; it can never mint a stale `ok`.
 */
export function readerLiveFreshness(reader: CovenantDocReaderProd): LiveFreshness {
  return (_anchor: CovenantAnchor): string | null => {
    const ctx = reader.authoritativeContext();
    if (ctx === null) return null; // doc gone / stalled ⇒ unprovable ⇒ `~`
    // Composite: BOTH the state vector (catches inserts) AND the delete set (catches
    // deletions the SV cannot see). The ` ` separator cannot appear in the base64
    // encodings, so the concatenation is unambiguous — two states never collide.
    return `${ctx.stateVector} ${ctx.deleteSet}`;
  };
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
 * demoted to `~`, even before SL-6's explicit `invalidate` arrives.
 *
 * `expectedRoomId` is REQUIRED (SL-4 fix round 2, MEDIUM). An UNBOUND web authority
 * would resolve a foreign-room anchor that happens to carry the requested `objectId`
 * to `ok` — a cross-room mix-up painting the wrong room's `✓`. Binding the room is not
 * optional on the public surface: the room is the isolation boundary (migration 0050's
 * cascade), so every authority is scoped to exactly one room, and a foreign-room anchor
 * fails closed to `drift` in core. The requested `objectId` is bound unconditionally in
 * core; this makes the room binding equally non-negotiable at the seam.
 */
export function webCovenantReadAuthority(input: {
  readonly loadAnchor: AnchorLoader;
  readonly reader: CovenantDocReaderProd;
  readonly expectedRoomId: string;
}): CovenantReadAuthority {
  if (!input.expectedRoomId) {
    // Fail-closed on an unbound room even if a JS caller defeats the required type:
    // an empty / missing room must not silently disable the cross-room guard.
    throw new Error('webCovenantReadAuthority: expectedRoomId is required (room binding)');
  }
  return new CovenantReadAuthority({
    loadAnchor: input.loadAnchor,
    resolveSpan: readerSpanResolver(input.reader),
    liveFreshness: readerLiveFreshness(input.reader),
    expectedRoomId: input.expectedRoomId,
  });
}
