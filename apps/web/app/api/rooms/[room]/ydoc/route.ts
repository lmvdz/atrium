/* ═══════════════════════════════════════════════════════════════════════════
 * THE WRITE DOOR (#202) — the ONLY write ingress to the Yjs document stream.
 *
 * Electric syncs READS and never writes (see `app/electric/v1/shape/route.ts`,
 * the read twin), so the app owns the append endpoint. `@electric-sql/y-electric`
 * PUTs each batched update here as `application/octet-stream`; this route
 * authenticates the session, rate-limits the caller, and hands the bytes to
 * `appendYdocUpdate`, which authorizes the room membership and appends the row
 * ATTRIBUTED TO THE SESSION. The decision lives in `lib/ydoc-append.ts` so it is
 * tested against a real Postgres rather than described here; this file is the
 * thin Request/Response and rate-limit shell around it.
 *
 * PUT, not POST: that is the verb y-electric's `send()` uses. Same-origin by
 * construction (`resolveElectricSendUrl` refuses an absolute URL), because the
 * write is authorized by the session cookie and a cookie only rides a same-origin
 * request — the exact argument the read door's `electricShapePath` makes.
 * ═══════════════════════════════════════════════════════════════════════════ */

import { attemptWithIp, clientIp, createThrottle, type Throttle } from '@atrium/auth';
import { headers } from 'next/headers';
import { db } from '@/lib/db';
import { proxyStrategy } from '@/lib/env';
import { currentSession } from '@/lib/session';
import { appendYdocUpdate } from '@/lib/ydoc-append';

/** Read per request, never prerendered, never cached — a write is not cacheable. */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The largest update body this door will accept.
 *
 * A Yjs update — even a batched one — is small; an unbounded body is a memory
 * DoS with a valid session behind it. 4 MiB is generous for any real edit and
 * far under what would hurt. A body over it is refused BEFORE it is read into
 * memory (the header is checked first) and again after, in case the header lied.
 */
const MAX_OP_BYTES = 4 * 1024 * 1024;

/**
 * Rate limits, in process and best-effort, the same shape as the sign-in
 * throttle (`app/(auth)/actions.ts`) and with the same caveats (reset on
 * restart, doubled by a second web process — init.md budgets one). Two
 * dimensions: per authenticated writer, and per caller IP for the case where one
 * account drives many rooms or one NAT hides many accounts. Generous enough that
 * ordinary editing never trips it, tight enough that a runaway client cannot
 * pin the append path. Kept on `globalThis` so hot reload does not hand out a
 * fresh empty counter on every edit.
 */
const limiters = ((): { byUser: Throttle; byIp: Throttle } => {
  const key = Symbol.for('atrium.web.throttles.ydoc');
  const holder = globalThis as unknown as { [key]?: ReturnType<typeof build> };
  function build() {
    return {
      byUser: createThrottle({ limit: 600, windowMs: 60_000 }),
      byIp: createThrottle({ limit: 1200, windowMs: 60_000 }),
    };
  }
  holder[key] ??= build();
  return holder[key];
})();

function refuse(status: number, message: string): Response {
  return Response.json(
    { message },
    { status, headers: { 'cache-control': 'no-store, no-cache, must-revalidate' } },
  );
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ room: string }> },
): Promise<Response> {
  const { room } = await context.params;

  // Authenticate first, so an unauthenticated flood is refused before it can
  // occupy an authenticated writer's rate-limit bucket.
  const session = await currentSession();
  if (!session?.emailVerified) {
    return refuse(401, 'sign in to write to this room’s document');
  }

  // Rate-limit the authenticated writer and their address. The IP is believed
  // only as far as `ATRIUM_TRUSTED_PROXY_HOPS` says to (clientIp); a null address
  // is a shared bucket, never a pass (attemptWithIp).
  const ip = clientIp(await headers(), { strategy: proxyStrategy() });
  if (!attemptWithIp({ byKey: limiters.byUser, byIp: limiters.byIp }, session.userId, ip)) {
    return refuse(429, 'too many document writes — slow down');
  }

  // Refuse an oversized body before reading it, then guard against a lying
  // Content-Length after.
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_OP_BYTES) {
    return refuse(413, 'that document update is too large');
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_OP_BYTES) {
    return refuse(413, 'that document update is too large');
  }

  const outcome = await appendYdocUpdate({ db: db(), session, room, op: body });
  if (outcome.status === 200) {
    return Response.json(
      { id: outcome.id },
      { status: 200, headers: { 'cache-control': 'no-store, no-cache, must-revalidate' } },
    );
  }
  return refuse(outcome.status, outcome.message);
}
