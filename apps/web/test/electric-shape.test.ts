import { describe, expect, it } from 'vitest';
import { buildShapeTarget, FORWARDED_PARAMS, SHAPE_TABLES } from '../lib/electric-shape.js';

/**
 * The shape proxy's composition step (#201) — the read-side twin of E2's write
 * door, tested by flipping the input and watching the output.
 *
 * Electric authenticates nobody and authorizes nothing: it answers any shape
 * request for any table in its publication with any `where` the caller writes.
 * The room boundary for reads therefore lives entirely in this composition, and
 * a mistake here is SILENT — a relayed `where` does not throw, it just returns
 * somebody else's document. So every assertion below hands the builder a
 * hostile query string and checks what actually came out, rather than checking
 * that the source contains the word `where`.
 */

const UPSTREAM = 'http://electric:3000';
const ROOM = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function target(query: string, room = ROOM): URL {
  return buildShapeTarget({
    upstream: UPSTREAM,
    table: 'ydoc_updates',
    room,
    incoming: new URLSearchParams(query),
    secret: 'shh',
  });
}

describe('the predicate is the server’s, whatever the client sent', () => {
  it('pins table, where and params from the authorized room', () => {
    const url = target('');
    expect(url.origin + url.pathname).toBe('http://electric:3000/v1/shape');
    expect(url.searchParams.get('table')).toBe('ydoc_updates');
    expect(url.searchParams.get('where')).toBe('room = $1');
    expect(url.searchParams.get('params[1]')).toBe(ROOM);
  });

  /**
   * THE MUTATION THAT MATTERS. `@electric-sql/y-electric` sends `table`, `where`
   * and `params` of its own on every request, so they always arrive and
   * something has to be done with them. If the builder ever merged instead of
   * overwrote, this is the request that would read another room's document —
   * and nothing else in the system would notice.
   */
  it('discards a client-supplied where that names another room', () => {
    const url = target(`where=room+%3D+%241&params%5B1%5D=${OTHER}`);
    expect(url.searchParams.get('where')).toBe('room = $1');
    expect(url.searchParams.get('params[1]')).toBe(ROOM);
    expect(url.searchParams.getAll('params[1]')).toEqual([ROOM]);
  });

  it('discards a client-supplied where that selects everything', () => {
    const url = target('where=true+OR+1%3D1');
    expect(url.searchParams.get('where')).toBe('room = $1');
  });

  it('discards a client-supplied table, even a legitimate one', () => {
    // `ydoc_awareness` is a table the proxy WILL serve — the caller picks it by
    // passing it as `table`, which the route validates against SHAPE_TABLES and
    // then hands in explicitly. What must not happen is the builder reading it
    // off the query string behind the route's back.
    const url = target('table=ydoc_awareness');
    expect(url.searchParams.get('table')).toBe('ydoc_updates');
  });

  it('pins the columns projection server-side and discards the client’s', () => {
    // `columns` is now REQUIRED, not optional: `ydoc_updates.op_digest` is a
    // GENERATED STORED column (migration 0054) and Electric 400s an all-columns
    // read of a table that has one. So the proxy pins the exact list (the primary
    // key plus the Yjs `op`, never the generated digest) and discards whatever the
    // client sent — the same allowlist shape as `where`.
    expect(target('columns=op').searchParams.get('columns')).toBe('id,op');
    expect(target('columns=op,op_digest,writer_user_id').searchParams.get('columns')).toBe('id,op');
    expect(target('').searchParams.get('columns')).toBe('id,op');
  });

  it('pins the awareness projection to its own real columns', () => {
    const url = buildShapeTarget({
      upstream: UPSTREAM,
      table: 'ydoc_awareness',
      room: ROOM,
      incoming: new URLSearchParams('columns=op'),
      secret: 'shh',
    });
    expect(url.searchParams.get('columns')).toBe('client_id,room,op,updated');
  });

  it('never lets a client overwrite the secret', () => {
    expect(target('secret=guessed').searchParams.get('secret')).toBe('shh');
  });

  it('sends no secret when the deployment configured none', () => {
    const url = buildShapeTarget({
      upstream: UPSTREAM,
      table: 'ydoc_updates',
      room: ROOM,
      incoming: new URLSearchParams('secret=guessed'),
      secret: null,
    });
    expect(url.searchParams.get('secret')).toBeNull();
  });
});

describe('the cursor parameters are an allowlist, not a denylist', () => {
  it('forwards every sync-protocol parameter the client set', () => {
    const url = target('offset=0_0&handle=h1&live=true&cursor=9&replica=full');
    expect(Object.fromEntries(FORWARDED_PARAMS.map((n) => [n, url.searchParams.get(n)]))).toEqual({
      offset: '0_0',
      handle: 'h1',
      live: 'true',
      cursor: '9',
      replica: 'full',
    });
  });

  it('omits the ones the client did not set rather than sending empties', () => {
    const url = target('offset=0_0');
    expect(url.searchParams.get('offset')).toBe('0_0');
    expect(url.searchParams.has('handle')).toBe(false);
    expect(url.searchParams.has('live')).toBe(false);
  });

  /**
   * HANDLE-REPLAY ISOLATION (#201). A `handle` names a shape instance, and the
   * attack is: a member of room A replays room B's shape handle here after losing
   * B. This proxy's half of the defence is that a forwarded handle NEVER displaces
   * the server-pinned definition — so the replayed handle always reaches Electric
   * beside room A's `where`, and Electric's handle-vs-definition check answers 409
   * rather than streaming B's bytes (see the FORWARDED_PARAMS docblock for the
   * verified client-side contract). Here we prove the half we own: even with a
   * hostile handle AND a hostile where naming the other room, table/where/params
   * are still room A's.
   */
  it('forwards a client handle but never lets it displace the pinned definition', () => {
    const url = target(`handle=someone-elses-shape&where=room+%3D+%241&params%5B1%5D=${OTHER}`);
    expect(url.searchParams.get('handle')).toBe('someone-elses-shape');
    expect(url.searchParams.get('where')).toBe('room = $1');
    expect(url.searchParams.get('params[1]')).toBe(ROOM);
    expect(url.searchParams.get('table')).toBe('ydoc_updates');
  });

  /**
   * The default direction. A parameter nobody here has reasoned about — the next
   * Electric release's, or one invented by a caller — is dropped, so widening
   * what the proxy relays takes an edit to `FORWARDED_PARAMS` rather than an
   * upstream changelog entry nobody read.
   */
  it('drops anything it has not reasoned about', () => {
    const url = target('experimental_include=users&api_secret=x&sql=DROP');
    for (const name of ['experimental_include', 'api_secret', 'sql']) {
      expect(url.searchParams.has(name), `${name} must not be forwarded`).toBe(false);
    }
  });
});

describe('the tables the proxy serves', () => {
  it('is exactly the document stream and its presence table', () => {
    expect([...SHAPE_TABLES].sort()).toEqual(['ydoc_awareness', 'ydoc_updates']);
  });

  it('does not include the ledger, which is the covenant’s own store', () => {
    // Belt and braces with the publication (migration 0053): a `✓` is a row in
    // the gated Postgres ledger and never travels on the sync wire.
    expect(SHAPE_TABLES.has('core_events')).toBe(false);
    expect(SHAPE_TABLES.has('covenant_anchors')).toBe(false);
  });
});
