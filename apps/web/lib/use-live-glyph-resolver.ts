'use client';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE LIVE COVENANT GLYPH — the client subscription (#218 / T4, the live flip).
 *
 * This hook is the payoff of the E6 increment: it subscribes the per-room
 * `covenant_status` Electric shape and feeds a LIVE {@link LiveGlyphResolver}, so a
 * covenant glyph flips `✓`→`~` the instant a peer edits a certified span, with NO
 * `router.refresh()`. It replaces the SSR-static coupling in `LiveRoomSession`
 * (`precomputedGlyphResolver(data.covenantReads)` refreshed only by a full route
 * re-fetch) with a resolver whose verdict map mutates as the shape streams.
 *
 * ## The data path, end to end
 *
 *   a peer edits an in-range span  →  the server drift sweep re-verdicts (E3/E7)
 *   →  `upsertCovenantStatus` PROJECTS the verdict to `covenant_status` (T3/#217)
 *   →  Electric replicates the row change  →  the shape proxy streams it
 *      (`app/electric/v1/shape`, `table=covenant_status`, `where room = $1`)
 *   →  THIS hook folds the row into the live resolver and bumps a render tick
 *   →  `anchorCertifies` re-reads the map and the glyph flips.
 *
 * ## READ-ONLY, fail-closed (the T4 scope boundary)
 *
 * The client NEVER authors a verdict: `covenant_status` INSERT/UPDATE/DELETE are
 * REVOKEd (migration 0056) and the shape is read-only. This hook only READS the
 * synced projection. Before the shape reaches its first up-to-date snapshot it
 * serves the SSR seed (`data.covenantReads`), and an object absent from the map is
 * `~` — provenance alone never mints a `✓`. `✓` is decided by `anchorCertifies`
 * over `status === 'ok'` and nothing else.
 *
 * ## Degrade honestly with no sync fabric
 *
 * A deployment with no Electric (`electricShapePath` is `null`) keeps the SSR seed
 * and re-seeds it whenever new server props arrive — exactly the pre-T4 behaviour,
 * so a non-Electric deployment loses nothing. The live flip is an ADDITION for
 * deployments that have the sync fabric, never a regression for those that do not.
 * ═══════════════════════════════════════════════════════════════════════════ */

import type { CovenantReadStatus } from '@atrium/core';
import { useEffect, useRef, useState } from 'react';
import { loadRuntimeConfig } from '@/src/lib/runtime-config';
import { resolveElectricShapeUrl } from '@/src/lib/ws-url';
import {
  type LiveGlyphResolver,
  liveGlyphResolver,
  type ObjectGlyphResolver,
  type SyncedCovenantStatusRow,
} from './covenant-read';

/**
 * Carry the session cookie on the shape read, stated rather than assumed — the shape
 * proxy authorizes the read by the cookie, and a same-origin fetch sends it by
 * default today, but a future runtime default of `omit` would silently turn every
 * read into an unauthenticated 401. Mirrors `electric-transport.ts`'s `sendFetch`.
 */
const shapeFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, credentials: 'same-origin' });

/**
 * Subscribe the room's `covenant_status` shape and return a LIVE resolver.
 *
 * Returns `undefined` when `seed === undefined` — the exact fail-closed-UNWIRED
 * parity {@link (precomputedGlyphResolver:function)} gives a hand-built fixture with
 * no covenant reads: `anchorCertifies` reads `undefined` as every glyph `~`, and no
 * shape is subscribed. Any real room props carry a (possibly empty) `covenantReads`
 * object, so the live path engages there.
 *
 * The returned resolver is a STABLE reference whose internal map mutates; the hook
 * bumps a render tick on every shape delta so the caller re-renders and re-reads the
 * updated verdicts through `anchorCertifies`.
 */
export function useLiveGlyphResolver(
  roomId: string,
  seed: Readonly<Record<string, CovenantReadStatus>> | undefined,
): ObjectGlyphResolver | undefined {
  // One stable resolver instance whose map mutates in place. Recreated only when the
  // room changes (a different room is a different verdict space).
  const resolverRef = useRef<LiveGlyphResolver | null>(null);
  const roomRef = useRef<string | null>(null);
  if (resolverRef.current === null || roomRef.current !== roomId) {
    resolverRef.current = liveGlyphResolver(seed);
    roomRef.current = roomId;
  }
  // True once the shape has delivered its first up-to-date snapshot: from then on the
  // synced projection is authoritative and later SSR seeds are ignored (the shape
  // never disagrees with itself once quiescent — rubric 12).
  const syncedRef = useRef(false);
  // A monotone render tick. Bumped on every shape delta so the consumer re-renders
  // and re-reads the mutated map; the resolver reference itself stays stable.
  const [, setTick] = useState(0);
  const bump = () => setTick((tick) => tick + 1);

  // Re-seed from fresh SSR props ONLY while the shape has not yet synced (or when no
  // Electric is configured). Once the live shape is authoritative, its verdicts win.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `bump` is a stable setter wrapper; re-running on its identity would loop.
  useEffect(() => {
    if (syncedRef.current) return;
    if (seed === undefined) return;
    resolverRef.current?.replace(seedRows(seed));
    bump();
  }, [seed]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `bump` is a stable setter wrapper; the effect must key on the room alone.
  useEffect(() => {
    if (seed === undefined) return; // unwired fixture — no live subscription
    let disposed = false;
    let dispose: (() => void) | undefined;
    syncedRef.current = false;

    void (async () => {
      const config = await loadRuntimeConfig();
      if (disposed) return;
      // No Electric on this deployment: keep the SSR seed, do not subscribe. The
      // seed effect above already published it; nothing live to fold.
      if (!config.electricShapePath) return;

      // The Electric client is browser-only; import it in the effect so a live room's
      // server render never pulls it in (same discipline as `LiveConversationDoc`).
      const { Shape, ShapeStream } = await import('@electric-sql/client');
      if (disposed) return;

      let shapeUrl: string;
      try {
        // Authorized by the `?room=` the proxy reads; same-origin by construction so
        // the session cookie rides. `table` travels as an Electric shape param; the
        // proxy discards the client `where`/`columns` and pins them from the room.
        const base = new URL(resolveElectricShapeUrl(config));
        base.searchParams.set('room', roomId);
        shapeUrl = base.toString();
      } catch {
        // A misconfigured shape URL leaves the SSR seed in place — fail-closed to the
        // server's last verdict, never to a crash on the live surface.
        return;
      }

      // The client's `Row` requires a string index signature that the narrow
      // `SyncedCovenantStatusRow` deliberately does not carry; the fold reads only
      // `object_id`/`status`/`generation` (defensively), so the rows are cast at the
      // seam rather than widening the wire type. The proxy pins the exact columns
      // server-side (`SHAPE_COLUMNS.covenant_status`), so those three are what arrive.
      const stream = new ShapeStream({
        url: shapeUrl,
        params: { table: 'covenant_status' },
        fetchClient: shapeFetch,
      });
      const shape = new Shape(stream);
      const unsubscribe = shape.subscribe(({ rows }) => {
        if (disposed) return;
        // The shape has folded the log to one row per PK; rebuild the map from the
        // current rows. The first notification with `isUpToDate` marks the synced
        // baseline — from then on the live projection wins over any SSR re-seed.
        resolverRef.current?.replace(rows as unknown as readonly SyncedCovenantStatusRow[]);
        if (shape.isUpToDate) syncedRef.current = true;
        bump();
      });

      dispose = () => {
        unsubscribe();
        shape.unsubscribeAll();
        stream.unsubscribeAll();
      };
    })();

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [roomId]);

  // Fail-closed-UNWIRED parity: a fixture with no covenant reads gets `undefined`,
  // which `anchorCertifies` reads as every glyph `~` — never a live subscription.
  if (seed === undefined) return undefined;
  return resolverRef.current ?? undefined;
}

/** Adapt the SSR `{ objectId → status }` seed into the synced-row shape `replace` folds. */
function seedRows(
  seed: Readonly<Record<string, CovenantReadStatus>>,
): readonly SyncedCovenantStatusRow[] {
  return Object.entries(seed).map(([object_id, status]) => ({ object_id, status, generation: 1 }));
}
