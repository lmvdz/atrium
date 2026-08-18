import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchorCertifies, type ObjectGlyphResolver } from '../lib/covenant-read.js';
import { useLiveGlyphResolver } from '../lib/use-live-glyph-resolver.js';

/**
 * THE LIVE GLYPH HOOK — the #218 fix-round regression suite for the liveness invariant.
 *
 * There was NO hook test before this round (the pure fold is covered in
 * `live-glyph-resolver.test.ts`; the SUBSCRIPTION was not). The gauntlet named two
 * user-reachable stale-`✓` paths that only the hook can close, and these drive them:
 *
 *   - a shape that goes live then ERRORS / DISCONNECTS must degrade a prior `✓` to `~`
 *     (the "silent/dead shape retains last ok" cardinal sin) — via both the non-retryable
 *     `onError` and a silent connectivity drop the poll catches;
 *   - the SSR seed must NOT mint `✓` before the first live up-to-date sync (the
 *     seed-window `✓`) — `~` on mount, then `✓` only once the live shape confirms it;
 *   - a never-synced / no-fabric mount stays `~`;
 *   - the proven live flip (a streamed drift after a prior ok → `✓`→`~`) still holds.
 *
 * The Electric client is mocked with a hand-driven fake `Shape`/`ShapeStream` so the
 * test controls up-to-date, connectivity, error, and each streamed row batch.
 */

const electric = vi.hoisted(() => {
  const state: {
    shape: FakeShape | undefined;
    stream: FakeStream | undefined;
  } = { shape: undefined, stream: undefined };

  class FakeStream {
    onError?: (error: unknown) => unknown;
    unsubscribeAllCalls = 0;
    constructor(opts: { onError?: (error: unknown) => unknown }) {
      this.onError = opts.onError;
      state.stream = this;
    }
    unsubscribeAll(): void {
      this.unsubscribeAllCalls += 1;
    }
  }

  class FakeShape {
    isUpToDate = false;
    error: unknown = false;
    connected = true;
    cb: ((data: { rows: unknown[] }) => void) | undefined;
    constructor(public readonly stream: FakeStream) {
      state.shape = this;
    }
    isConnected(): boolean {
      return this.connected;
    }
    subscribe(cb: (data: { rows: unknown[] }) => void): () => void {
      this.cb = cb;
      return () => {
        this.cb = undefined;
      };
    }
    unsubscribeAll(): void {}
  }

  return { state, FakeStream, FakeShape };
});

vi.mock('@electric-sql/client', () => ({
  Shape: electric.FakeShape,
  ShapeStream: electric.FakeStream,
}));

/** Set the runtime config the hook reads (via `window.__ATRIUM_RUNTIME__`). */
function setRuntime(electricShapePath: string | null): void {
  (window as unknown as { __ATRIUM_RUNTIME__: unknown }).__ATRIUM_RUNTIME__ = {
    wsUrl: null,
    wsPath: null,
    electricShapePath,
  };
}

/** Connectivity-poll callbacks the hook registered via `setInterval`, captured per test. */
let pollCallbacks: Array<{ cb: () => void; ms: number }> = [];

beforeEach(() => {
  electric.state.shape = undefined;
  electric.state.stream = undefined;
  setRuntime('/electric/v1/shape');
  // Stub `setInterval` to RECORD the poll callback without scheduling a real timer: a
  // real interval would keep the worker's event loop alive after the tests finish and
  // hang the run, and advancing a fake one deadlocks React's scheduler. The poll test
  // fires the recorded callback directly. `clearInterval` is a no-op against the fake id.
  pollCallbacks = [];
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((cb: () => void, ms?: number) => {
    pollCallbacks.push({ cb, ms: ms ?? 0 });
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation((() => {}) as typeof clearInterval);
});

afterEach(() => {
  // Unmount every rendered hook so its subscription is disposed.
  cleanup();
  vi.restoreAllMocks();
  (window as unknown as { __ATRIUM_RUNTIME__?: unknown }).__ATRIUM_RUNTIME__ = undefined;
});

/**
 * Drain the effect's async setup (runtime-config read + dynamic import of the mocked
 * client). Real timers throughout — fake timers deadlock React's scheduler when a poll
 * fires a state update mid-advance — so this drains the microtask queue plus one
 * macrotask (the dynamic import settles across a macrotask boundary).
 */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

/** The glyph the surface would paint for `objectId`, read through the returned resolver. */
function certifies(resolver: ObjectGlyphResolver | undefined, objectId: string): boolean {
  return anchorCertifies(resolver, objectId);
}

/** Emit a shape notification (the full materialised row set), optionally up-to-date. */
function emit(rows: unknown[], upToDate = true): void {
  act(() => {
    const shape = requireShape();
    shape.isUpToDate = upToDate;
    shape.cb?.({ rows });
  });
}

/** The subscribed fake shape, asserting it exists (keeps the tests free of `!`). */
function requireShape() {
  const shape = electric.state.shape;
  if (!shape) throw new Error('shape not subscribed yet');
  return shape;
}

/** The constructed fake stream, asserting it exists. */
function requireStream() {
  const stream = electric.state.stream;
  if (!stream) throw new Error('stream not constructed yet');
  return stream;
}

describe('useLiveGlyphResolver — the liveness invariant on the live subscription', () => {
  it('SEED-WINDOW: a seed ok renders ~ until the live shape confirms it, then ✓', async () => {
    const seed = { span: 'ok' as const };
    const { result } = renderHook(() => useLiveGlyphResolver('room-1', seed));

    // Frame 0: the seed is present but the shape has not synced — NOT live ⇒ `~`.
    // This is the seed-window fix: `✓` is forbidden on unconfirmed content.
    expect(certifies(result.current, 'span')).toBe(false);

    // The shape subscribes and reaches its first up-to-date snapshot carrying the row.
    await flush();
    expect(electric.state.shape).toBeDefined();
    emit([{ object_id: 'span', status: 'ok', generation: 1 }], true);

    // Now — and only now — the glyph certifies.
    expect(certifies(result.current, 'span')).toBe(true);
  });

  it('NEVER-SYNCED: a shape that never reaches up-to-date stays ~ (no seed ✓)', async () => {
    const seed = { span: 'ok' as const };
    const { result } = renderHook(() => useLiveGlyphResolver('room-1', seed));
    await flush();
    expect(electric.state.shape).toBeDefined();

    // A notification arrives but the shape is NOT up-to-date (still catching up): the
    // baseline is unproven, so it must not go live — the seed's ok stays `~`.
    emit([{ object_id: 'span', status: 'ok', generation: 1 }], false);
    expect(certifies(result.current, 'span')).toBe(false);
  });

  it('NO FABRIC: a deployment with no electricShapePath stays ~ (seed never certifies)', async () => {
    setRuntime(null);
    const seed = { span: 'ok' as const };
    const { result } = renderHook(() => useLiveGlyphResolver('room-1', seed));

    // Give the async effect a chance to run; with no Electric it never subscribes and
    // never goes live — every glyph is `~`, honestly (no live authority to back a `✓`).
    await flush();
    expect(electric.state.shape).toBeUndefined();
    expect(certifies(result.current, 'span')).toBe(false);
  });

  it('THE LIVE FLIP: a streamed drift after a prior ok demotes ✓ → ~', async () => {
    const seed = { span: 'ok' as const };
    const { result } = renderHook(() => useLiveGlyphResolver('room-1', seed));
    await flush();
    expect(electric.state.shape).toBeDefined();

    emit([{ object_id: 'span', status: 'ok', generation: 1 }], true);
    expect(certifies(result.current, 'span')).toBe(true);

    // A peer edits the in-range span; the sweep re-verdicts drift and the shape streams
    // the newer row — the glyph flips to `~` within the render tick.
    emit([{ object_id: 'span', status: 'drift', generation: 2 }], true);
    expect(certifies(result.current, 'span')).toBe(false);
  });

  it('ERROR AFTER OK: a non-retryable stream error degrades a prior ✓ → ~', async () => {
    const seed = { span: 'ok' as const };
    const { result } = renderHook(() => useLiveGlyphResolver('room-1', seed));
    await flush();
    expect(electric.state.shape).toBeDefined();

    emit([{ object_id: 'span', status: 'ok', generation: 1 }], true);
    expect(certifies(result.current, 'span')).toBe(true);

    // A 401/403-class error fires the stream's onError. The last ok is STILL in the map,
    // but a lost stream must never keep painting it — the glyph degrades to `~`.
    act(() => {
      requireShape().error = new Error('401 Unauthorized');
      requireStream().onError?.(new Error('401 Unauthorized'));
    });
    expect(certifies(result.current, 'span')).toBe(false);
  });

  it('SILENT DISCONNECT: a dropped connection (no callback) degrades ✓ → ~ via the poll', async () => {
    const seed = { span: 'ok' as const };
    const { result } = renderHook(() => useLiveGlyphResolver('room-1', seed));
    await flush();
    expect(electric.state.shape).toBeDefined();

    emit([{ object_id: 'span', status: 'ok', generation: 1 }], true);
    expect(certifies(result.current, 'span')).toBe(true);

    // The hook registered a 1s connectivity poll; fire it directly (see beforeEach).
    const poll = pollCallbacks.find((entry) => entry.ms === 1_000)?.cb;
    if (!poll) throw new Error('the hook did not register a 1s connectivity poll');

    // The connection drops silently — no error, no subscribe callback (the exact
    // "silent/dead shape retains last ok" path). The connectivity poll must catch it.
    act(() => {
      requireShape().connected = false;
      poll();
    });
    expect(certifies(result.current, 'span')).toBe(false);

    // Reconnect + a fresh up-to-date snapshot restores live authority → ✓ again.
    act(() => {
      requireShape().connected = true;
      poll();
    });
    emit([{ object_id: 'span', status: 'ok', generation: 2 }], true);
    expect(certifies(result.current, 'span')).toBe(true);
  });

  it('UNWIRED FIXTURE: seed === undefined returns undefined (every glyph ~, no subscription)', async () => {
    const { result } = renderHook(() => useLiveGlyphResolver('room-1', undefined));
    await flush();
    expect(result.current).toBeUndefined();
    expect(certifies(result.current, 'span')).toBe(false);
    expect(electric.state.shape).toBeUndefined();
  });
});
