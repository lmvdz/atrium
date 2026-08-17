/* ═══════════════════════════════════════════════════════════════════════════
 * THE SHAPE PROXY (#201) — the read-side twin of E2's write door.
 *
 * Electric is a sync engine, not an authorization layer. It has NO IDEA WHO IS
 * ASKING: it answers any shape request, for any table in its publication, with
 * any `where` clause the caller writes. That is not a defect in Electric — it is
 * what a sync engine is — and it is why its port is published nowhere and why
 * every browser read arrives here first.
 *
 * Three things happen before anything reaches Electric, and all three are the
 * point:
 *
 *  1. **The session is authenticated.** Same `currentSession()` every page uses,
 *     over the same cookie, with the same "unverified is not a session" rule.
 *  2. **The room is authorized.** `loadRoomMembership` — a `memberships` row, a
 *     live room, a surviving `workspace_members` row. Exactly the three
 *     conditions migration 0053's append function checks on the WRITE side, so
 *     a member who may not write also may not read and the two gates cannot
 *     drift apart into a room somebody can read but not write, or worse.
 *  3. **The predicate is pinned SERVER-side.** `table`, `where` and `params` are
 *     composed here from the authorized room id. Whatever the client sent for
 *     them is DISCARDED, not merged and not validated — see below.
 *
 * ## Why the client's `where` is discarded rather than checked
 *
 * `@electric-sql/y-electric` sends `table`, `where` and `params` of its own
 * (`apps/web/app/prototype/electric-transport.ts` sets them), so they arrive on
 * every request and something has to be done with them. Validating them would be
 * a denylist: it works until somebody finds a predicate the checker reads
 * differently from Postgres, and then the room boundary is gone. Composing them
 * from the authorized room id is the allowlist form — there is no request shape
 * that produces a `where` this route did not write.
 *
 * The same reasoning covers `columns`: unspecified means all of them, and the
 * two ydoc tables have no column a member may not see. A client-supplied
 * projection would be one more input with no upside.
 *
 * ## What IS forwarded
 *
 * Only Electric's sync-protocol cursor: `offset`, `handle`, `live`, `cursor`,
 * `replica`. An allowlist, again — an unknown parameter is dropped rather than
 * passed through, because the next Electric release's new parameter is not one
 * this route has reasoned about.
 * ═══════════════════════════════════════════════════════════════════════════ */

import 'server-only';

import { loadRoomMembership } from '@atrium/auth';
import { db } from '@/lib/db';
import { buildShapeTarget, SHAPE_TABLES } from '@/lib/electric-shape';
import { electricSecret, electricUrl } from '@/lib/env';
import { currentSession } from '@/lib/session';

/**
 * Read per request, never prerendered, never cached at the edge. A cached shape
 * response is one room's document served to another room's reader.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Response headers Electric sets that the client's protocol depends on.
 *
 * Copied by name rather than by passing the whole header set through: an
 * upstream `set-cookie` or `access-control-allow-origin: *` relayed onto this
 * origin would be a genuine hole, and "copy everything except the bad ones" is
 * the denylist shape this file exists to avoid.
 */
const RELAYED_HEADERS = [
  'content-type',
  'electric-cursor',
  'electric-handle',
  'electric-offset',
  'electric-schema',
  'electric-has-data',
  'electric-up-to-date',
];

/**
 * `ydoc_updates.room` is a `uuid`, so anything else is not a room id.
 *
 * Checked BEFORE the membership lookup rather than left to Postgres: a
 * non-uuid reaches the driver as `invalid input syntax for type uuid`, which
 * escapes as an unhandled 500 — a different status for a malformed room than
 * for an unauthorized one, which is a distinction a prober can read. Same shape
 * as migration 0004's actor-id regex, and for the same reason.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(status: number, message: string): Response {
  return Response.json(
    { message },
    { status, headers: { 'cache-control': 'no-store, no-cache, must-revalidate' } },
  );
}

export async function GET(request: Request): Promise<Response> {
  const upstream = electricUrl();
  if (!upstream) {
    // A deployment with no sync fabric is a running deployment; it just has no
    // live documents. 503 rather than 500: nothing is broken, something is
    // absent, and the client should render the room without a live doc.
    return refuse(503, 'this deployment has no Electric sync service configured');
  }

  const session = await currentSession();
  if (!session?.emailVerified) {
    // The same rule `requireSession` applies on a page, minus the redirect: a
    // fetch wants a status, not an HTML sign-in form. An unverified address is
    // not a session here either — one rule, three entry points (page, socket
    // upgrade, this).
    return refuse(401, 'sign in to read this room’s document');
  }

  const params = new URL(request.url).searchParams;

  const table = params.get('table') ?? 'ydoc_updates';
  if (!SHAPE_TABLES.has(table)) {
    return refuse(400, `"${table}" is not a document stream this room publishes`);
  }

  const room = params.get('room');
  if (!room) {
    // Named explicitly rather than inferred from the client's `where`, which is
    // the whole trick: the room this request is authorized against and the room
    // the predicate selects are the same string, read once.
    return refuse(400, 'a shape read must name the room it is for (?room=…)');
  }
  // A malformed room and an unauthorized one answer the SAME 404, so the status
  // code tells a prober nothing it did not already know.
  if (!UUID.test(room)) return refuse(404, 'no such room');

  const membership = await loadRoomMembership(db(), room, session.userId);
  if (!membership) {
    // 404, not 403: whether a room exists is itself something a non-member does
    // not get to learn, and every other read path in this app answers the same
    // way. A 403 here would turn this route into a room-slug oracle.
    return refuse(404, 'no such room');
  }

  // The predicate is composed from the room this request was authorized
  // against — see `lib/electric-shape.ts` for why the client's own `where` is
  // discarded rather than checked.
  const target = buildShapeTarget({
    upstream,
    table,
    room,
    incoming: params,
    secret: electricSecret(),
  });

  let response: Response;
  try {
    response = await fetch(target, {
      // Electric's own cache headers are for Electric's clients; this hop must
      // not be cached by Next's fetch cache, which would serve one reader's
      // long-poll answer to the next.
      cache: 'no-store',
      signal: request.signal,
      headers: { accept: 'application/json' },
    });
  } catch {
    // The secret is in the URL, so the error is NOT relayed: a fetch failure
    // message can carry the request target, and that target carries the
    // credential.
    return refuse(502, 'the sync service could not be reached');
  }

  const headers = new Headers({ 'cache-control': 'no-store, no-cache, must-revalidate' });
  for (const name of RELAYED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (response.headers.has('retry-after')) {
    headers.set('retry-after', response.headers.get('retry-after') as string);
  }

  return new Response(response.body, { status: response.status, headers });
}
