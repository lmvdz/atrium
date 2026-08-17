import 'server-only';

/* ───────────────────────────────────────────────────────────────────────────
 * WHAT THE SHAPE PROXY SENDS UPSTREAM (#201).
 *
 * Split out of `app/electric/v1/shape/route.ts` so the decision can be TESTED
 * rather than described. The route does authentication and authorization; this
 * file does the one thing that is pure — turning "an authorized room and a
 * client's query string" into the exact URL Electric is asked for — and it is
 * the part where a mistake is silent. A relayed `where`, a forwarded `columns`,
 * a passed-through unknown parameter: none of those throw, they just widen what
 * comes back, and only a test that flips the input and watches the output can
 * say they do not happen.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The two tables a room's live document is made of, and the only tables the
 * proxy will ever name.
 *
 * Electric's publication (migration 0053) is the second, independent copy of
 * this list, enforced by Postgres — a caller who somehow got past this set would
 * still be refused by the database, which answers `503 … missing from the
 * publication … and the ELECTRIC_MANUAL_TABLE_PUBLISHING setting prevents
 * Electric from adding it`. Two mechanisms, neither relying on the other.
 */
export const SHAPE_TABLES: ReadonlySet<string> = new Set(['ydoc_updates', 'ydoc_awareness']);

/**
 * Electric's sync-protocol cursor parameters — everything a legitimate client
 * needs to say, and nothing that selects data.
 *
 * `offset` is where the client is up to, `handle` names the shape instance,
 * `live` asks for a long poll, `cursor` breaks a CDN's response cache, `replica`
 * chooses full-row vs changed-column mode. None of them can widen what the
 * request returns beyond the `where` this module pins.
 *
 * An ALLOWLIST, and that is the load-bearing word: the next Electric release's
 * new parameter is one nobody here has reasoned about, so it is dropped by
 * default rather than relayed by default.
 *
 * ## Why forwarding `handle` does not leak another room's document (#201)
 *
 * A `handle` names a shape INSTANCE, and the worry is a handle-replay: a member
 * of room A who once had room B's shape `handle` replays it here, hoping Electric
 * honours the handle over the `where` and streams B's bytes. It does not, for a
 * reason this proxy controls and a reason Electric guarantees, and both had to
 * hold:
 *
 *   1. THIS PROXY re-pins `table`, `where` and `params[1]` from the authorized
 *      room on EVERY request, including one that carries a `handle` — the handle
 *      is forwarded, but never in place of the pinned definition. So a replayed
 *      B-handle always reaches Electric ALONGSIDE room A's `where`. (Asserted in
 *      `test/electric-shape.test.ts` — a handle for another room does not
 *      displace the pinned predicate.)
 *   2. ELECTRIC treats the handle as an opaque, server-assigned instance id and
 *      validates it against the shape DEFINITION on the request. A handle whose
 *      stored definition does not match the sent `where`/`table`/`params` gets a
 *      409, not the old shape's data. VERIFIED against the installed
 *      `@electric-sql/client` 1.5.26 protocol contract: on a 409 the client marks
 *      the stale handle expired, adopts the new handle from the `electric-handle`
 *      response header, resets to `offset=-1`, emits a `must-refetch`, and
 *      refetches from scratch — it never streams the mismatched handle's bytes
 *      (`dist/chunk-*.mjs`: the 409 branch in the live and snapshot fetch paths;
 *      `canonicalShapeKey` keys shape identity on the definition, not the handle).
 *      The handle is not a client-computed hash of the definition, so the client
 *      cannot forge a matching one; the server owns the mapping.
 *
 * The 409 itself is emitted by the Electric SERVER, whose source is not in this
 * repo, so (2) is a contract read off the client rather than a branch we can
 * unit-test here. (1) is ours and is tested. If a future Electric ever changed
 * (2) — honouring a handle over a mismatched `where` — the room boundary would
 * then rest on (1) plus binding the handle to the session room; that is the note
 * left for whoever bumps the Electric major.
 */
export const FORWARDED_PARAMS = ['offset', 'handle', 'live', 'cursor', 'replica'] as const;

/**
 * Compose the upstream shape URL for an ALREADY-AUTHORIZED room.
 *
 * The caller has authenticated the session and confirmed the membership; this
 * function's whole job is that the predicate reaching Electric is the one the
 * server wrote. `table`, `where` and `params` are composed here from `room` —
 * whatever the client sent for them is DISCARDED, not merged and not validated.
 *
 * Validating a client `where` would be a denylist: it works until somebody finds
 * a predicate the checker reads differently from Postgres, and then the room
 * boundary is gone. There is no request shape that produces a `where` this
 * function did not write.
 *
 * @param upstream Electric's internal origin, already stripped of a trailing slash.
 * @param table    one of `SHAPE_TABLES`; the caller rejects anything else.
 * @param room     the room id the caller authorized — the same string, read once.
 * @param incoming the client's query string, read for cursor parameters only.
 * @param secret   Electric's API secret, when one is configured.
 */
export function buildShapeTarget(options: {
  upstream: string;
  table: string;
  room: string;
  incoming: URLSearchParams;
  secret?: string | null;
}): URL {
  const target = new URL(`${options.upstream}/v1/shape`);
  // ── SERVER-PINNED, in three lines no request can reach ────────────────────
  target.searchParams.set('table', options.table);
  target.searchParams.set('where', 'room = $1');
  target.searchParams.set('params[1]', options.room);

  for (const name of FORWARDED_PARAMS) {
    const value = options.incoming.get(name);
    if (value !== null) target.searchParams.set(name, value);
  }

  if (options.secret) target.searchParams.set('secret', options.secret);
  return target;
}
