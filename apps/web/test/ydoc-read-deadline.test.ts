import { describe, expect, it, vi } from 'vitest';

/**
 * THE WRITE DOOR'S READ DEADLINE (#202 round 2) — a stalled body is 408'd.
 *
 * `readBodyBounded` aborts a body that has not finished within its read deadline
 * by throwing `BodyReadTimeoutError` (a trickle/slowloris body never crosses the
 * size cap and never reports `done`, so without the deadline it would pin the
 * handler and its FD open — the rate limiter caps read STARTS, not concurrency).
 * This proves the route maps that abort to 408 and never reaches the append
 * decision. The deadline mechanics themselves are proven directly in
 * ydoc-body-cap.test.ts; here we only assert the route's response mapping, so
 * `readBodyBounded` is stubbed to throw the real error class immediately rather
 * than driving a real 10 s stall through the handler.
 */

const appendSpy = vi.fn(async (..._args: unknown[]) => ({ status: 200 as const, id: 'row-1' }));

vi.mock('@/lib/bounded-body', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bounded-body')>('@/lib/bounded-body');
  return {
    ...actual,
    // Keep the real BodyReadTimeoutError (the route checks `instanceof` it);
    // only force the read to time out.
    readBodyBounded: vi.fn(async () => {
      throw new actual.BodyReadTimeoutError(10_000);
    }),
  };
});
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

describe('PUT /api/rooms/[room]/ydoc — a stalled body is refused 408', () => {
  it('408s when the bounded read exceeds its deadline, without appending', async () => {
    const { PUT } = await import('@/app/api/rooms/[room]/ydoc/route');
    const request = {
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>(),
    } as unknown as Request;

    const response = await PUT(request, { params: Promise.resolve({ room: 'room-1' }) });

    expect(response.status).toBe(408);
    expect(appendSpy).not.toHaveBeenCalled();
  });
});
