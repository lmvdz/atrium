import { describe, expect, it } from 'vitest';
import { __documentRetryHandlerForTest as documentRetryHandler } from '@/app/prototype/electric-transport';

/**
 * THE SEND-ERROR HANDLER'S CONTRACT (#202, E2 fix).
 *
 * y-electric's `send()` (node_modules/@electric-sql/y-electric/src/y-electric.ts
 * ~459-489) returns THIS handler's value as its own return value whenever a send
 * fails, and `sendOperations()` (~365-388) reads that boolean as "did the write
 * land":
 *
 *     const sending = this.pendingChanges
 *     this.pendingChanges = null            // ~366: cleared before the send
 *     const success = await send(...)       // === handler's return on failure
 *     if (!success) { this.batch(sending); this.disconnect() }  // ~377-380: restore
 *
 * So `true` from the handler means "landed": the batch — already nulled out of
 * `pendingChanges` — is NOT restored, and the update is silently dropped. Since
 * the handler is only ever called when a send FAILED, `true` is never honest. The
 * fix returns `false` on every failure, which restores the batch (retried on
 * reconnect for a transient failure; inert after the disconnect for a permanent
 * one). These tests pin that: the handler never reports a failed write as landed,
 * and a faithful replay of the library's own batch logic keeps the update pending
 * on a 429/5xx rather than clearing it.
 */

/** Mirrors `send()`'s catch semantics (y-electric.ts ~468-488). */
async function contractSend(
  handler: typeof documentRetryHandler,
  response: Response | undefined,
): Promise<boolean> {
  try {
    if (!response?.ok) throw new Error('Server did not return 2xx');
    return true;
  } catch (error) {
    return (await handler({ response, error })) ?? false;
  }
}

/** Mirrors the `pendingChanges` handling of `sendOperations()` (~365-380). */
async function sendOnce(
  handler: typeof documentRetryHandler,
  response: Response | undefined,
): Promise<{ pending: Uint8Array | null; cleared: boolean; success: boolean }> {
  const update = new Uint8Array([1, 2, 3, 4, 5]);
  let pending: Uint8Array | null = update;
  const sending = pending;
  pending = null; // ~366: pendingChanges = null, before the send

  const success = await contractSend(handler, response);
  if (!success) {
    pending = sending; // ~378: this.batch(sending) restores the batch
  }
  return { pending, cleared: pending === null, success };
}

function resp(status: number): Response {
  // A minimal Response with the status the door returned.
  return new Response(null, { status });
}

describe('documentRetryHandler never reports a failed send as landed', () => {
  const transient: Array<[string, Response | undefined]> = [
    ['a dropped connection (no response)', undefined],
    ['429 rate limited', resp(429)],
    ['500 server error', resp(500)],
    ['503 unavailable', resp(503)],
  ];

  for (const [label, response] of transient) {
    it(`returns false on ${label} so the batch is preserved`, async () => {
      expect(await documentRetryHandler({ response, error: new Error('x') })).toBe(false);
    });
  }

  const permanent: Array<[string, number]> = [
    ['401 not signed in', 401],
    ['403 not a member', 403],
    ['400 malformed', 400],
    ['413 too large', 413],
  ];

  for (const [label, status] of permanent) {
    it(`returns false on ${label} so the provider disconnects (not "landed")`, async () => {
      expect(await documentRetryHandler({ response: resp(status), error: new Error('x') })).toBe(
        false,
      );
    });
  }
});

describe('a transient failure does NOT clear pending / advance past the update', () => {
  it('a 429 keeps the update pending, replaying the library batch logic', async () => {
    const { pending, cleared, success } = await sendOnce(documentRetryHandler, resp(429));
    expect(success).toBe(false); // not reported landed
    expect(cleared).toBe(false); // pendingChanges NOT nulled
    expect(pending).toEqual(new Uint8Array([1, 2, 3, 4, 5])); // the exact batch, restored
  });

  it('a 500 keeps the update pending', async () => {
    const { pending, cleared, success } = await sendOnce(documentRetryHandler, resp(500));
    expect(success).toBe(false);
    expect(cleared).toBe(false);
    expect(pending).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('a network drop keeps the update pending', async () => {
    const { pending, cleared, success } = await sendOnce(documentRetryHandler, undefined);
    expect(success).toBe(false);
    expect(cleared).toBe(false);
    expect(pending).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('the OLD behavior (return true on 429) would have DROPPED it — guarding the regression', async () => {
    const buggy: typeof documentRetryHandler = async () => true;
    const { pending, cleared, success } = await sendOnce(buggy, resp(429));
    expect(success).toBe(true); // reported landed…
    expect(cleared).toBe(true); // …so the batch is cleared and lost
    expect(pending).toBeNull();
  });
});
