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
