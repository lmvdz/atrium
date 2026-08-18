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
 * The EXACT columns each table's shape selects — PINNED server-side, per table,
 * the same allowlist discipline as `where` (#204/T1).
 *
 * ## Why this is required, not an optimisation (the generated-column trap)
 *
 * A shape read with NO `columns` list means "all columns", and Electric REFUSES
 * that for `ydoc_updates` with a `400`: migration 0054 added `op_digest` as a
 * `bytea GENERATED ALWAYS AS (sha256(op)) STORED` column, and Electric's shape
 * snapshot cannot stream a generated column (measured against electricsql/electric
 * 1.7.11 — an unqualified shape read of `ydoc_updates` answers 400, a read that
 * names the real replicated columns answers 200). So the columns list is not a
 * projection nicety here; it is what makes the read succeed at all. The list names
 * exactly the columns y-electric reads (`op`) plus the primary key Electric
 * requires the shape to carry (`id` for `ydoc_updates`; `client_id, room` for
 * `ydoc_awareness`), and DELIBERATELY OMITS `op_digest` — the generated column —
 * along with the writer stamp and stream_seq the client never reads.
 *
 * ## Why pinned SERVER-side rather than trusted from the client
 *
 * `@electric-sql/y-electric` can send its own `columns` (the transport at
 * `app/prototype/electric-transport.ts` now does), so — exactly like `where` — a
 * client value arrives and something has to be done with it. Composing it here
 * from the authorized table is the allowlist form: there is no request shape that
 * widens the projection beyond what this map names, and (unlike a generated
 * column) a client cannot ask for a column that makes Electric 400 the whole
 * stream for every reader of that room.
 */
export const SHAPE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // `id` is the primary key Electric requires the shape to carry; `op` is the Yjs
  // update bytea y-electric folds. `op_digest` (generated), the writer stamp, and
  // `stream_seq` are deliberately absent — the client reads none of them.
  ydoc_updates: ['id', 'op'],
  // Awareness has no generated column, so a bare read would not 400 — but the
  // projection is pinned for the same reason as `where`: the client never widens
  // it. `client_id, room` are the composite primary key; `op` is the presence
  // payload; `updated` is its freshness.
  ydoc_awareness: ['client_id', 'room', 'op', 'updated'],
};

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
  // ── SERVER-PINNED, in lines no request can reach ──────────────────────────
  target.searchParams.set('table', options.table);
  target.searchParams.set('where', 'room = $1');
  target.searchParams.set('params[1]', options.room);
  // The columns projection is pinned too — see SHAPE_COLUMNS: for `ydoc_updates`
  // it is REQUIRED (a bare read 400s on the generated `op_digest` column, 0054),
  // and for both tables it is the allowlist form of `where` (a client `columns`
  // is discarded, never merged). A table with no pinned list falls back to
  // Electric's default (all columns), which is only safe for a table with no
  // generated column — the two this proxy serves are both listed.
  const columns = SHAPE_COLUMNS[options.table];
  if (columns) target.searchParams.set('columns', columns.join(','));

  for (const name of FORWARDED_PARAMS) {
    const value = options.incoming.get(name);
    if (value !== null) target.searchParams.set(name, value);
  }

  if (options.secret) target.searchParams.set('secret', options.secret);
  return target;
}
