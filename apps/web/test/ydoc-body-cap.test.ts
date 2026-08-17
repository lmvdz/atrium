import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readBodyBounded } from '@/lib/bounded-body';

/**
 * THE WRITE DOOR'S BODY CAP (#202, E2 fix) — enforced on the ACTUAL read.
 *
 * The DoS the gauntlet found: the size refusal ran only when a Content-Length
 * header was present. A chunked `Transfer-Encoding` request carries none, so it
 * sailed past the header check and `request.arrayBuffer()` buffered the whole
 * body anyway — an unbounded memory allocation behind one verified session. The
 * fix caps the streamed bytes as they arrive (`readBodyBounded`) regardless of
 * any header, aborting the read the moment the running total crosses the cap.
 *
 * These prove the streamed cap directly (no whole-body buffering), and prove the
 * route refuses a HEADER-LESS oversize body — the exact request that used to slip
 * through — without ever calling the append function.
 */

const CAP = 4 * 1024 * 1024;

/**
 * A stream of `chunkCount` chunks of `chunkBytes` each, counting how many chunks
 * were actually pulled. A bounded reader must stop early on an oversize stream —
 * `pulled` staying well under `chunkCount` is the proof it did not buffer whole.
 */
function countingStream(chunkCount: number, chunkBytes: number) {
  const counter = { pulled: 0, cancelled: false };
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= chunkCount) {
        controller.close();
        return;
      }
      counter.pulled += 1;
      emitted += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() {
      counter.cancelled = true;
    },
  });
  return { stream, counter };
}

describe('readBodyBounded', () => {
  it('returns the bytes for an under-cap body', async () => {
    const { stream } = countingStream(3, 1024);
    const body = await readBodyBounded(stream, CAP);
    expect(body).not.toBeNull();
    expect(body?.byteLength).toBe(3 * 1024);
  });

  it('aborts an oversize stream without draining it whole', async () => {
    // 10 MiB offered in 1 MiB chunks against a 4 MiB cap.
    const { stream, counter } = countingStream(10, 1024 * 1024);
    const body = await readBodyBounded(stream, CAP);
    expect(body).toBeNull(); // over cap → refused
    // It must have stopped near the cap (~4 chunks + at most a prefetch), not
    // pulled all ten. `< 8` proves early abort without pinning the exact
    // backpressure read-ahead, which the stream may vary by one.
    expect(counter.pulled).toBeLessThan(8);
    expect(counter.cancelled).toBe(true);
  });

  it('reads a null body as empty', async () => {
    const body = await readBodyBounded(null, CAP);
    expect(body).not.toBeNull();
    expect(body?.byteLength).toBe(0);
  });

  it('accepts a body exactly at the cap', async () => {
    const { stream } = countingStream(1, CAP);
    const body = await readBodyBounded(stream, CAP);
    expect(body?.byteLength).toBe(CAP);
  });
});

// --- The route handler over a chunked (header-less) oversize body -------------

const appendSpy = vi.fn(async (..._args: unknown[]) => ({ status: 200 as const, id: 'row-1' }));

vi.mock('@/lib/ydoc-append', () => ({
  appendYdocUpdate: (...args: unknown[]) => appendSpy(...args),
}));
vi.mock('@/lib/session', () => ({
  currentSession: async () => ({
    sessionId: 's1',
    userId: 'u1',
    email: 'u1@example.test',
    displayName: 'u1',
    emailVerified: true,
    principalKind: 'human',
    activeWorkspaceId: null,
  }),
}));
vi.mock('@/lib/db', () => ({ db: () => ({}) }));
vi.mock('@/lib/env', () => ({ proxyStrategy: () => ({ kind: 'unconfigured' }) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

describe('PUT /api/rooms/[room]/ydoc — the body cap on the actual read', () => {
  beforeEach(() => {
    appendSpy.mockClear();
  });

  it('413s a chunked (no Content-Length) oversize body without buffering it whole or appending', async () => {
    const { PUT } = await import('@/app/api/rooms/[room]/ydoc/route');
    const { stream, counter } = countingStream(10, 1024 * 1024); // 10 MiB, no header

    // A header-less request: `headers` has no content-length, `body` is the stream.
    const request = { headers: new Headers(), body: stream } as unknown as Request;
    const response = await PUT(request, { params: Promise.resolve({ room: 'room-1' }) });

    expect(response.status).toBe(413);
    expect(counter.pulled).toBeLessThan(8); // aborted near cap, not drained whole (10)
    expect(appendSpy).not.toHaveBeenCalled(); // refused before the append decision
  });

  it('accepts a small chunked body and reaches the append function', async () => {
    const { PUT } = await import('@/app/api/rooms/[room]/ydoc/route');
    const { stream } = countingStream(1, 8); // 8 bytes

    const request = { headers: new Headers(), body: stream } as unknown as Request;
    const response = await PUT(request, { params: Promise.resolve({ room: 'room-1' }) });

    expect(response.status).toBe(200);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    const arg = appendSpy.mock.calls[0]?.[0] as { op: Uint8Array };
    expect(arg.op.byteLength).toBe(8);
  });
});
