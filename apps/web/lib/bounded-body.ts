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
 * A `null` body (no request entity) reads as empty — the append door rejects an
 * empty update on its own terms downstream.
 */
export async function readBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
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
