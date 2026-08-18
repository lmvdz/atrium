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
 * ## READ-ONLY, fail-closed to `~` (the T4 scope boundary)
 *
 * The client NEVER authors a verdict: `covenant_status` INSERT/UPDATE/DELETE are
 * REVOKEd (migration 0056) and the shape is read-only. This hook only READS the
 * synced projection. `✓` is decided by `anchorCertifies` over `status === 'ok'` and
 * nothing else — AND only while the shape is currently LIVE (below). Fail-closed here
 * means fail to `~`, NEVER to the last-known `✓`.
 *
 * ## The liveness invariant (#218 fix round — the last-mile cardinal-sin fix)
 *
 * A `✓` at the surface where the glyph meets a human MUST mean "the certified content
 * still resolves, AND we are currently receiving the authoritative `covenant_status`
 * stream". So the resolver renders `✓` for an object ONLY while ALL hold:
 *   - the shape is CONNECTED (`shape.isConnected()`),
 *   - it has reached its first UP-TO-DATE snapshot (`syncedRef`), and
 *   - it is NOT errored (`shape.error`, or a non-retryable `onError`),
 * and the row's `status === 'ok'`. The hook drives this through `resolver.setLive`.
 *
 * Any loss of that live authority — a `503`/`401`, a slept or dead connection, a
 * missing `electricShapePath`, a failed runtime-config, a room change — flips the
 * resolver NOT-live and EVERY glyph degrades to `~`, regardless of what the last
 * folded map held. This closes the two user-reachable stale-`✓` paths the gauntlet
 * found: (1) a silent/dead shape retaining its last `ok`, and (2) the SSR seed
 * minting `✓` on frame 0 before the live shape ever confirmed it. A brief `~`
 * ("verifying") on mount is the correct, honest behaviour — `✓` is forbidden until
 * the live shape confirms it.
 *
 * ## No sync fabric ⇒ `~`, honestly
 *
 * A deployment with no Electric (`electricShapePath` is `null`) has NO live authority,
 * so it can never satisfy the invariant: the resolver stays NOT-live and every glyph
 * is `~`. This is a DELIBERATE change from the pre-fix behaviour (which painted `✓`
 * from the SSR seed on such deployments): a seed alone is provenance, not a live
 * certification, and a `✓` the client cannot currently back with the authoritative
 * stream is the exact stale-`✓` cardinal sin. Honest `~` over unconfirmed `✓`.
 * ═══════════════════════════════════════════════════════════════════════════ */

import type { CovenantReadResult, CovenantReadStatus } from '@atrium/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadRuntimeConfig } from '@/src/lib/runtime-config';
import { resolveElectricShapeUrl } from '@/src/lib/ws-url';
import {
  type LiveGlyphResolver,
  liveGlyphResolver,
  type ObjectGlyphResolver,
  type SyncedCovenantStatusRow,
} from './covenant-read';

/**
 * How often the hook re-checks the shape's connectivity (#218 fix round). The `Shape`
 * subscribe callback fires only on data change / up-to-date transitions — it is SILENT
 * on a dropped connection, so a shape that went live and then slept would keep its last
 * `ok` forever with no callback to demote it. This interval re-reads `isConnected()` /
 * `error` and demotes to `~` the moment live authority is lost, independent of traffic.
 */
const LIVENESS_POLL_MS = 1_000;

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
  // True once the shape has delivered its first up-to-date snapshot: from then on the
  // synced projection is authoritative and later SSR seeds are ignored (the shape
  // never disagrees with itself once quiescent — rubric 12). Reset to false on error
  // or room change so a re-subscribe must re-earn the up-to-date baseline before `✓`.
  const syncedRef = useRef(false);
  // The current live-authority state the resolver is set to. Mirrors `resolver.setLive`
  // so a poll / callback / error handler only re-renders on an ACTUAL transition.
  const liveRef = useRef(false);
  if (resolverRef.current === null || roomRef.current !== roomId) {
    // A different room is a different verdict space: start a fresh, NOT-live resolver
    // (the seed is non-certifying until this room's live shape confirms it) and clear
    // the liveness mirror so the prior room's `✓` can never bleed across.
    resolverRef.current = liveGlyphResolver(seed);
    roomRef.current = roomId;
    liveRef.current = false;
  }
  // A monotone render tick. Bumped on every shape delta so the consumer re-renders
  // and re-reads the mutated map; the resolver reference itself stays stable.
  const [tick, setTick] = useState(0);
  const bump = () => setTick((current) => current + 1);
  // Set the resolver's liveness and re-render only when it actually changes. `✓` is
  // served ONLY while live; every transition to not-live degrades every glyph to `~`.
  const setLive = (next: boolean) => {
    if (liveRef.current === next) return;
    liveRef.current = next;
    resolverRef.current?.setLive(next);
    bump();
  };

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
    // Re-subscribing (a room change) must re-earn live authority: not-synced and
    // NOT-live until this room's shape confirms an up-to-date snapshot. Until then
    // every glyph is `~` — the seed does not certify.
    syncedRef.current = false;
    setLive(false);

    void (async () => {
      const config = await loadRuntimeConfig();
      if (disposed) return;
      // No Electric on this deployment: there is NO live authority, so the invariant
      // can never be met — stay NOT-live and every glyph is `~`. A missing sync fabric
      // must never leave the seed's `ok` painted as `✓` (the stale-`✓` cardinal sin);
      // a seed is provenance, not a live certification.
      if (!config.electricShapePath) {
        setLive(false);
        return;
      }

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
        // A misconfigured shape URL is a loss of live authority — degrade every glyph
        // to `~`, never leave the seed's last verdict painted as `✓`.
        setLive(false);
        return;
      }

      // Recompute liveness from the shape's own signals: `✓` is served ONLY while the
      // shape is connected, has reached an up-to-date snapshot (`syncedRef`), and is
      // not errored. Anything else ⇒ NOT-live ⇒ every glyph `~`.
      const refreshLiveness = (shape: {
        isUpToDate: boolean;
        error: unknown;
        isConnected(): boolean;
      }) => {
        if (disposed) return;
        setLive(syncedRef.current && shape.isConnected() && !shape.error);
      };

      // The client's `Row` requires a string index signature that the narrow
      // `SyncedCovenantStatusRow` deliberately does not carry; the fold reads only
      // `object_id`/`status`/`generation` (defensively), so the rows are cast at the
      // seam rather than widening the wire type. The proxy pins the exact columns
      // server-side (`SHAPE_COLUMNS.covenant_status`), so those three are what arrive.
      const stream = new ShapeStream({
        url: shapeUrl,
        params: { table: 'covenant_status' },
        fetchClient: shapeFetch,
        // A NON-RETRYABLE stream error (a `401`/`403`, a permanent `4xx`) is a loss of
        // live authority: mark not-synced + NOT-live so every glyph degrades to `~`
        // instead of stranding the last `ok` as a stale `✓`. Returning void stops the
        // sync loop — we do not silently retry into a false-live. (The client retries
        // `5xx`/network/`429` on its own WITHOUT calling this; the connectivity poll
        // below catches those by seeing `isConnected()` go false during backoff.)
        onError: () => {
          if (disposed) return;
          syncedRef.current = false;
          setLive(false);
        },
      });
      const shape = new Shape(stream);
      const unsubscribe = shape.subscribe(({ rows }) => {
        if (disposed) return;
        // The shape has folded the log to one row per PK (DELETEs included: the client
        // materialises the full row set, so a removed row is simply absent here and
        // reads `~`). Rebuild the map from the current rows. The first notification with
        // `isUpToDate` marks the synced baseline — from then on the live projection wins
        // over any SSR re-seed, and the shape is LIVE (connected + up-to-date + no error).
        resolverRef.current?.replace(rows as unknown as readonly SyncedCovenantStatusRow[]);
        if (shape.isUpToDate) syncedRef.current = true;
        refreshLiveness(shape);
        bump();
      });

      // The subscribe callback is SILENT on a dropped connection, so a shape that went
      // live and then slept/500-looped would keep its last `ok` with no callback to
      // demote it. Poll connectivity so a lost stream flips to `~` even with no traffic.
      const poll = setInterval(() => refreshLiveness(shape), LIVENESS_POLL_MS);

      dispose = () => {
        clearInterval(poll);
        unsubscribe();
        shape.unsubscribeAll();
        stream.unsubscribeAll();
      };
    })();

    return () => {
      disposed = true;
      // Tearing down the subscription is a loss of live authority: never leave the
      // resolver live (and painting `✓`) behind a dead stream.
      setLive(false);
      dispose?.();
    };
  }, [roomId]);

  // Return a wrapper whose IDENTITY changes with the render `tick`, not the stable
  // resolver ref. The resolver ref is deliberately stable (its map mutates in place);
  // the tick is what re-renders. Binding the returned identity to the tick means a
  // future `useMemo(view, [glyphResolver])` recomputes on every live delta instead of
  // freezing the glyph on frame 0 — the live update can never become an ornament.
  // `peek` delegates to the live ref so it always reads the current map + liveness.
  //
  // Fail-closed-UNWIRED parity: a fixture with no covenant reads (`seed === undefined`)
  // returns `undefined`, which `anchorCertifies` reads as every glyph `~` — no live
  // subscription. Computed unconditionally (rules of hooks) rather than short-circuited.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the whole point — it forces a fresh identity per live delta; `resolverRef` is a stable ref.
  return useMemo<ObjectGlyphResolver | undefined>(() => {
    if (seed === undefined) return undefined;
    const resolver = resolverRef.current;
    if (resolver === null) return undefined;
    return { peek: (objectId: string): CovenantReadResult => resolver.peek(objectId) };
  }, [tick, roomId, seed]);
}

/** Adapt the SSR `{ objectId → status }` seed into the synced-row shape `replace` folds. */
function seedRows(
  seed: Readonly<Record<string, CovenantReadStatus>>,
): readonly SyncedCovenantStatusRow[] {
  return Object.entries(seed).map(([object_id, status]) => ({ object_id, status, generation: 1 }));
}
