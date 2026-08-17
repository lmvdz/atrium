/**
 * A bounded read of a request body (#202, E2 fix).
 *
 * `request.arrayBuffer()` buffers the WHOLE body into memory before anyone can
 * check its size, so a Content-Length check in front of it is not a guard: a
 * chunked `Transfer-Encoding` request carries no Content-Length, sails past the
 * header check, and is then fully buffered anyway. The only honest cap is one
 * enforced on the bytes AS THEY ARRIVE.
 *
 * This reads the body stream chunk by chunk and STOPS the moment the running
 * total would exceed `maxBytes` — cancelling the stream so the sender is not
 * drained. It never holds more than `maxBytes` plus one in-flight chunk. Over
 * the cap it returns `null` (the caller refuses); at or under the cap it returns
 * the assembled bytes.
 *
 * The "cap plus one in-flight chunk" bound assumes the runtime hands us BOUNDED
 * chunks — Node's HTTP stack delivers the body in reads of roughly 64 KiB, so a
 * single `reader.read()` never lands more than a small, fixed slice. The cap is
 * therefore checked AFTER a chunk arrives, not before: peak memory is
 * `maxBytes + one_chunk`, not `maxBytes + whole_body`. A hypothetical runtime
 * that returned the entire body as one chunk would still be capped (we refuse
 * the moment the total crosses `maxBytes`), but the one in-flight chunk it
 * handed us would already be that whole body — so this bound is Node's, not a
 * universal guarantee.
 *
 * ## The read DEADLINE — the size cap is not enough on its own (#202 round 2)
 *
 * The size cap bounds how MANY bytes a single read costs, but not how LONG a
 * read may occupy a handler. A trickle body — one byte every few seconds, or a
 * connection that opens, sends a header, and then never sends the body — never
 * crosses the size cap and never reports `done`, so without a deadline
 * `reader.read()` would await forever, pinning the handler and its file
 * descriptor. The route's rate limiter is a START-rate cap (N reads begun per
 * minute), not a concurrency cap, so nothing upstream stops many such hung
 * reads from piling up until the process exhausts handlers/FDs — reachable by
 * any one authenticated member.
 *
 * So the whole read is raced against `deadlineMs`. If the body is not fully read
 * within it, the reader is cancelled (releasing its lock) and a
 * `BodyReadTimeoutError` is thrown, so the route can answer 408 and the handler
 * is freed rather than held. The default is deliberately generous: a legitimate
 * ≤4 MiB update finishes in well under a second on any real connection, and even
 * a slow mobile link clears 4 MiB inside the deadline — the deadline exists to
 * kill a body that is not making progress, not to race a slow-but-honest client.
 */

/** The reader outlived the deadline; the route maps this to 408. */
export class BodyReadTimeoutError extends Error {
  constructor(deadlineMs: number) {
    super(`request body not fully read within ${deadlineMs}ms`);
    this.name = 'BodyReadTimeoutError';
  }
}

/**
 * How long the whole bounded read may take before it is aborted.
 *
 * A ≤4 MiB Yjs update completes in a fraction of a second on any real link
 * (4 MiB in 10 s is ~3.4 Mbps — below any modern broadband or 4G floor), so a
 * body that has not finished in 10 s is not a slow honest client, it is a stall.
 * Small enough that a trickle attacker cannot hold a handler for minutes;
 * generous enough that no legitimate update trips it.
 */
export const DEFAULT_READ_DEADLINE_MS = 10_000;

export async function readBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  deadlineMs: number = DEFAULT_READ_DEADLINE_MS,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  // The deadline for the WHOLE read. When it fires we cancel the reader, which
  // resolves the in-flight `reader.read()` (as `done`) and releases the pull, so
  // the loop wakes and observes `timedOut` rather than awaiting a trickle body
  // forever. `cancel()` also frees the underlying stream and its file descriptor.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel('request body read deadline exceeded').catch(() => {});
  }, deadlineMs);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      // Check the deadline BEFORE `done`: a deadline-driven cancel() resolves the
      // read as `done`, and treating that as a clean end-of-body would silently
      // return a truncated body instead of refusing the stalled request.
      if (timedOut) throw new BodyReadTimeoutError(deadlineMs);
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        // Over the cap: stop pulling and let the sender know we are done, rather
        // than draining an unbounded body we have already decided to refuse.
        await reader.cancel('request body exceeds cap').catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
