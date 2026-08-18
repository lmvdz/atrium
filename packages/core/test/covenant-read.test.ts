import { describe, expect, it } from 'vitest';
import {
  type CapturedSelection,
  type CovenantAnchor,
  type CovenantDocReader,
  CovenantReadAuthority,
  certifyAnchor,
  type EnclosedItem,
  type RenderedFragment,
  type RenderedNode,
  type ResolvedSpan,
} from '../src/index.js';

/**
 * SL-4 (#191): the read authority + the ASYNC FAIL-CLOSED contract. Every state
 * the ticket enumerates is pinned here, and each not-theater assertion is written
 * so a NAIVE authority — one that returns `ok` by default while pending, lets a
 * reader throw escape, or reads a missing anchor as `ok` — FAILS it. The load-
 * bearing case is `pending ⇒ ~` (never `ok`, never a throw): a sync reader that
 * calls `read()` before the async `resolve()` settles must see `unresolved`.
 *
 * The verdict itself (ok vs drift over a resolved span) is proven exhaustively in
 * covenant.test.ts / covenant-conformance.test.ts; here we prove the SEAM around
 * it — how the async resolution, the missing anchor, the unavailable doc, the
 * throw, and the pending window each map to the three-valued status.
 */

const ALICE = { kind: 'human', userId: 'u_alice' } as const;
const AT = '2026-08-16T12:00:00.000Z';

// A minimal faithful live document, mirroring covenant.test.ts's StubDoc: it holds
// one snapshot and resolves the span only when the anchor's context matches AND its
// items still exist, else `null` (fail-closed). Used to mint anchors and to back the
// async SpanResolver.
class StubDoc implements CovenantDocReader {
  constructor(
    public revision: number,
    public stateVector: string,
    public deleteSet: string,
    public fragment: RenderedFragment,
    public enclosedItems: EnclosedItem[],
    public liveIds: Set<string> = new Set(enclosedItems.map((i) => i.id)),
    public available = true,
  ) {}

  captureSelection(): CapturedSelection | null {
    if (!this.available) return null;
    return {
      revision: this.revision,
      relStart: 'rel-start',
      relEnd: 'rel-end',
      stateVector: this.stateVector,
      deleteSet: this.deleteSet,
      fragment: this.fragment,
      enclosedItems: this.enclosedItems,
    };
  }

  authoritativeContext() {
    if (!this.available) return null;
    return { revision: this.revision, stateVector: this.stateVector, deleteSet: this.deleteSet };
  }

  resolveSpan(anchor: CovenantAnchor): ResolvedSpan | null {
    if (!this.available) return null;
    if (this.enclosedItems.some((i) => !this.liveIds.has(i.id))) return null;
    const snapshotVerified =
      anchor.revision === this.revision &&
      anchor.stateVector === this.stateVector &&
      anchor.deleteSet === this.deleteSet;
    return { fragment: this.fragment, enclosedItems: this.enclosedItems, snapshotVerified };
  }
}

function sampleFragment(): RenderedFragment {
  return {
    ancestors: [{ type: 'heading', attrs: { level: '2' } }],
    nodes: [
      { kind: 'text', text: 'ship it', marks: [{ type: 'bold', attrs: {}, straddles: 'start' }] },
      { kind: 'embed', embedType: 'mention', identity: { target: 'u_alice' }, marks: [] },
    ],
  };
}

function sampleDoc(): StubDoc {
  const enclosed: EnclosedItem[] = [
    { id: 'i_text', kind: 'text' },
    { id: 'i_mention', kind: 'embed' },
  ];
  return new StubDoc(7, 'sv-base', 'ds-base', sampleFragment(), enclosed);
}

function anchorFor(doc: StubDoc, objectId = 'o_span'): CovenantAnchor {
  const anchor = certifyAnchor(doc, {
    objectId,
    roomId: 'room_1',
    certifier: ALICE,
    certifiedAt: AT,
  });
  if (anchor === null) throw new Error('capture failed in fixture');
  return anchor;
}

/** An async SpanResolver backed by a StubDoc (the honest resolve path). */
const resolverFor = (doc: StubDoc) => async (anchor: CovenantAnchor) => doc.resolveSpan(anchor);

/** A deferred promise, so a test can hold the async resolution PENDING at will. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('CovenantReadAuthority — the async fail-closed states (#191 acceptance)', () => {
  it('anchor over UNCHANGED content ⇒ ok (the only `✓`)', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
    });
    const r = await authority.resolve('o_span');
    expect(r.covenantStatus).toBe('ok');
    expect(r.revision).toBe(7);
    expect(r.renderedFragment).not.toBeNull();
    // The sync read now reflects the definitive verdict.
    expect(authority.read('o_span').covenantStatus).toBe('ok');
  });

  it('anchor over a DRIFTED live span ⇒ drift (content moved underneath the `✓`)', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    // Drift the live content after certifying: the digest no longer matches.
    doc.fragment = {
      ancestors: doc.fragment.ancestors,
      nodes: [{ kind: 'text', text: 'ship it now', marks: [] }],
    };
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
    });
    expect((await authority.resolve('o_span')).covenantStatus).toBe('drift');
  });

  it('NO anchor for the object ⇒ drift, never ok, never unresolved (fail-closed)', async () => {
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => null,
      resolveSpan: async () => {
        throw new Error('resolveSpan must not be called when there is no anchor');
      },
    });
    const r = await authority.resolve('o_missing');
    expect(r.covenantStatus).toBe('drift');
    // not-theater: a naive `ok`-by-default / `unresolved`-passthrough impl fails here.
    expect(r.covenantStatus).not.toBe('ok');
    expect(r.covenantStatus).not.toBe('unresolved');
  });

  it('UNAVAILABLE / stalled doc (resolver ⇒ null) ⇒ drift', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    doc.available = false; // the live doc handle is gone
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
    });
    const r = await authority.resolve('o_span');
    expect(r.covenantStatus).toBe('drift');
    expect(r.covenantStatus).not.toBe('ok');
  });

  it('a resolver that THROWS becomes drift, never propagates, never ok', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: async () => {
        throw new Error('reader blew up (a `_item.id` deref on a root type)');
      },
    });
    // not-theater: a naive impl without the guard would REJECT here; this must resolve.
    const r = await authority.resolve('o_span');
    expect(r.covenantStatus).toBe('drift');
    expect(r.covenantStatus).not.toBe('ok');
  });

  it('a ledger read (loadAnchor) that THROWS becomes drift, never propagates', async () => {
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => {
        throw new Error('ledger query failed');
      },
      resolveSpan: async () => null,
    });
    const r = await authority.resolve('o_span');
    expect(r.covenantStatus).toBe('drift');
  });

  it('ASYNC-PENDING ⇒ `~` (unresolved): a sync read before resolve settles is NEVER ok', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const gate = deferred<ResolvedSpan | null>();
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: () => gate.promise, // never settles until we say so
    });

    // Kick resolution and immediately read synchronously — resolution is IN FLIGHT.
    const inflight = authority.resolve('o_span');
    const whilePending = authority.read('o_span');
    expect(whilePending.covenantStatus).toBe('unresolved');
    // not-theater: the load-bearing refusal. A pending object must NOT paint `✓`,
    // and must NOT be prematurely called `drift` either.
    expect(whilePending.covenantStatus).not.toBe('ok');
    expect(whilePending.covenantStatus).not.toBe('drift');
    expect(whilePending.renderedFragment).toBeNull();

    // Now let the async resolution complete — the sync read flips to the real verdict.
    gate.resolve(doc.resolveSpan(anchor));
    await inflight;
    expect(authority.read('o_span').covenantStatus).toBe('ok');
  });

  it('`peek` returns `~` immediately for an unseen object, then the real glyph after settle', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
    });
    // First peek kicks resolution and returns `~` synchronously (pending).
    expect(authority.peek('o_span').covenantStatus).toBe('unresolved');
    // Let the microtask-driven resolution settle.
    await authority.resolve('o_span');
    expect(authority.read('o_span').covenantStatus).toBe('ok');
  });
});

describe('CovenantReadAuthority — cross-call consistency + flip-the-input (#191 acceptance #5)', () => {
  it('the rendered fragment is IDENTICAL across two independent call sites for one object', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
    });
    await authority.resolve('o_span');
    const a = authority.read('o_span');
    const b = authority.read('o_span');
    // Same cached result object ⇒ byte-identical fragment at every call site.
    expect(a).toBe(b);
    expect(a.renderedFragment).toBe(b.renderedFragment);
    expect(JSON.stringify(a.renderedFragment)).toBe(JSON.stringify(b.renderedFragment));
  });

  it('two INDEPENDENT authorities over the same anchor+doc render the identical fragment', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const one = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
    });
    const two = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
    });
    const [ra, rb] = await Promise.all([one.resolve('o_span'), two.resolve('o_span')]);
    expect(ra.covenantStatus).toBe('ok');
    expect(rb.covenantStatus).toBe('ok');
    // Determinism of the reader + digest ⇒ structurally identical fragment.
    expect(JSON.stringify(ra.renderedFragment)).toBe(JSON.stringify(rb.renderedFragment));
  });

  it('flip-the-input: a SECOND independent caller at the same DRIFTED anchor returns `~`/drift, NEVER ok', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    // Drift the content so the anchor no longer holds.
    doc.fragment = {
      ancestors: doc.fragment.ancestors,
      nodes: [{ kind: 'text', text: 'tampered', marks: [] }],
    };

    const first = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
    });
    const second = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
    });

    // The second caller reads BEFORE resolving ⇒ `unresolved` (`~`), not `ok`.
    expect(second.read('o_span').covenantStatus).toBe('unresolved');

    // And after resolving, the drifted anchor is `drift` for BOTH callers — never `ok`.
    expect((await first.resolve('o_span')).covenantStatus).toBe('drift');
    expect((await second.resolve('o_span')).covenantStatus).toBe('drift');
    expect(second.read('o_span').covenantStatus).not.toBe('ok');
  });

  it('concurrent resolves of one object share a single in-flight resolution (one reader call)', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    let resolverCalls = 0;
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: async (a) => {
        resolverCalls += 1;
        return doc.resolveSpan(a);
      },
    });
    const [a, b] = await Promise.all([authority.resolve('o_span'), authority.resolve('o_span')]);
    expect(resolverCalls).toBe(1); // deduped
    expect(a).toBe(b); // identical result object
  });
});

/**
 * SL-4 gauntlet FIX (#191): the WARM-cache holes both foreign lineages converged on.
 * The COLD-cache paths above are correct and must not regress; these pin the four
 * defects the FAIL enumerated. The first two run on the SHIPPED (pre-fix) API and so
 * are the not-theater proofs — each FAILS on base 9cab798 (which stamps the wrong `✓`
 * / leaves the fragment mutable) and passes here.
 */
describe('CovenantReadAuthority — SL-4 warm-cache defects (#191 fix)', () => {
  // ── HIGH: bind the requested object to the loaded anchor ─────────────────────
  it('object mismatch: a loaded anchor for a DIFFERENT object ⇒ drift, never stamps the requested `✓`', async () => {
    const doc = sampleDoc();
    // The loader hands back an anchor whose objectId is `o_other` (a loader / cache /
    // cross-room mix-up), but the caller asked about `o_span`.
    const anchorForOther = anchorFor(doc, 'o_other');
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchorForOther,
      resolveSpan: resolverFor(doc),
    });
    const r = await authority.resolve('o_span');
    // not-theater: base stamps `o_span` `ok` (resolveCovenant ignores provenance ids);
    // the fix binds objectId at the authority boundary ⇒ drift.
    expect(r.covenantStatus).toBe('drift');
    expect(r.covenantStatus).not.toBe('ok');
    expect(r.objectId).toBe('o_span');
  });

  it('room mismatch: `expectedRoomId` set + a foreign-room anchor ⇒ drift', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc); // roomId 'room_1'
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
      expectedRoomId: 'room_2', // the authority is bound to a DIFFERENT room
    });
    expect((await authority.resolve('o_span')).covenantStatus).toBe('drift');
  });

  // ── MEDIUM: deep-freeze the returned fragment ────────────────────────────────
  it('the returned renderedFragment is DEEP-frozen — a consumer mutation cannot rewrite every reader’s `✓`', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
    });
    const r = await authority.resolve('o_span');
    expect(r.covenantStatus).toBe('ok');
    expect(r.renderedFragment).not.toBeNull();
    const frag = r.renderedFragment as RenderedFragment;
    // not-theater: base `Object.freeze`s the RESULT shallowly and never freezes the
    // fragment, so `.nodes` / `.ancestors` / a node stay mutable under status `ok`.
    expect(Object.isFrozen(frag)).toBe(true);
    expect(Object.isFrozen(frag.nodes)).toBe(true);
    expect(Object.isFrozen(frag.ancestors)).toBe(true);
    expect(Object.isFrozen(frag.nodes[0])).toBe(true);
    expect(() => {
      (frag.nodes as RenderedNode[]).push({ kind: 'text', text: 'evil', marks: [] });
    }).toThrow();
    expect(() => {
      (frag.nodes[0] as { text: string }).text = 'evil';
    }).toThrow();
  });

  // ── CRITICAL: read() must NEVER serve a stale `ok` (sync SV-freshness) ────────
  it('SV-freshness: a cached `ok` whose live token advances ⇒ read() returns `~` (never the stale `ok`)', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    let token = 'sv-1';
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
      liveFreshness: () => token,
    });
    expect((await authority.resolve('o_span')).covenantStatus).toBe('ok');
    // Fresh: the live token still matches the one captured at resolve time.
    expect(authority.read('o_span').covenantStatus).toBe('ok');
    // The live span advances under the `✓` (a peer edit): the token moves.
    token = 'sv-2';
    // THE CARDINAL RULE: the sync read must NOT serve the stale `ok`.
    expect(authority.read('o_span').covenantStatus).toBe('unresolved');
    expect(authority.read('o_span').covenantStatus).not.toBe('ok');
  });

  it('SV-freshness then re-resolve: the kicked re-resolve concludes the REAL (drifted) verdict', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    let token = 'sv-1';
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
      liveFreshness: () => token,
    });
    await authority.resolve('o_span');
    // Drift the actual content AND advance the token, as a real edit would.
    doc.fragment = {
      ancestors: doc.fragment.ancestors,
      nodes: [{ kind: 'text', text: 'x', marks: [] }],
    };
    token = 'sv-2';
    // read() demotes to `~` and kicks a re-resolve; awaiting it concludes drift.
    expect(authority.read('o_span').covenantStatus).toBe('unresolved');
    await authority.resolve('o_span');
    expect(authority.read('o_span').covenantStatus).toBe('drift');
  });

  it('staleness bound: a `null` freshness sample (doc gone / cannot prove) ⇒ read() returns `~`, never the stale `✓`', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    let token: string | null = 'sv-1';
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
      liveFreshness: () => token,
    });
    expect((await authority.resolve('o_span')).covenantStatus).toBe('ok');
    token = null; // the live handle dropped — freshness is unprovable
    expect(authority.read('o_span').covenantStatus).not.toBe('ok');
    expect(authority.read('o_span').covenantStatus).toBe('unresolved');
  });

  it('staleness bound: a STALLED re-resolve keeps read() at `~` — it never reverts to the stale `✓`', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    let token = 'sv-1';
    let calls = 0;
    const stall = deferred<ResolvedSpan | null>();
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: () => {
        calls += 1;
        // First resolve returns `ok`; the kicked refresh (call 2) STALLS forever.
        return calls === 1 ? Promise.resolve(doc.resolveSpan(anchor)) : stall.promise;
      },
      liveFreshness: () => token,
    });
    expect((await authority.resolve('o_span')).covenantStatus).toBe('ok');
    token = 'sv-2'; // drift; the refresh this read kicks will stall
    expect(authority.read('o_span').covenantStatus).toBe('unresolved');
    // Even after the microtask queue drains, the stalled refresh has not settled — and
    // the read stays `~`, never the indefinite stale `✓`.
    await Promise.resolve();
    await Promise.resolve();
    expect(authority.read('o_span').covenantStatus).toBe('unresolved');
    expect(authority.read('o_span').covenantStatus).not.toBe('ok');
  });

  // ── CRITICAL: generation guard — a pre-drift compute cannot recache a stale `ok` ─
  it('invalidate(objectId) drops the cached `✓` synchronously ⇒ read() returns `~`', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
    });
    expect((await authority.resolve('o_span')).covenantStatus).toBe('ok');
    authority.invalidate('o_span');
    expect(authority.read('o_span').covenantStatus).toBe('unresolved');
    expect(authority.read('o_span').covenantStatus).not.toBe('ok');
  });

  it('generation guard: a resolve that JOINED a pre-invalidate in-flight compute cannot recache the stale `ok`', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const gate = deferred<ResolvedSpan | null>();
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: () => gate.promise, // held pending until the drift lands
    });
    const inflight = authority.resolve('o_span'); // compute starts at generation 0
    const joined = authority.resolve('o_span'); // JOINS the same in-flight (generation 0)
    expect(joined).toBe(inflight);
    // The span drifts and SL-6 / #182 invalidates BEFORE the in-flight compute settles.
    authority.invalidate('o_span');
    // The pre-drift compute now settles `ok` — it must NOT repopulate the cache.
    gate.resolve(doc.resolveSpan(anchor));
    await inflight;
    expect(authority.read('o_span').covenantStatus).toBe('unresolved');
    expect(authority.read('o_span').covenantStatus).not.toBe('ok');
  });

  // ── HIGH: invalidated in-flight resolve — awaiters must NOT get the dropped `ok` ──
  it('invalidated in-flight resolve: the AWAITERS of the superseded promise get `~`, never the dropped stale `ok`', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const gate = deferred<ResolvedSpan | null>();
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: () => gate.promise, // held pending until the drift lands
    });
    const inflight = authority.resolve('o_span'); // compute starts at generation 0
    const joined = authority.resolve('o_span'); // JOINS the same in-flight (generation 0)
    expect(joined).toBe(inflight);
    // The span drifts and SL-6 / #182 invalidates BEFORE the in-flight compute settles.
    authority.invalidate('o_span');
    // The pre-drift compute now settles `ok`. The generation guard already refuses to
    // RECACHE it — but its AWAITERS (the very readers that called resolve) must not be
    // handed the superseded verdict either.
    gate.resolve(doc.resolveSpan(anchor));
    const settled = await inflight;
    // not-theater: base returns `entry.result` (the stale `ok`) to every awaiter; the
    // fix returns `unresolved` (`~`) — a re-resolve, never the dropped `ok`.
    expect(settled.covenantStatus).not.toBe('ok');
    expect(settled.covenantStatus).toBe('unresolved');
    expect(settled.renderedFragment).toBeNull();
    // And the cache was not repopulated (the generation guard), so read stays `~`.
    expect(authority.read('o_span').covenantStatus).toBe('unresolved');
  });

  // ── HIGH: server static mode must be fail-closed until #182 ───────────────────
  it('failClosedWithoutFreshness: a cached `ok` with NO freshness port is served as `~` (server static mode)', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
      // The server's mode: no sync doc handle ⇒ no `liveFreshness` port, and #182's
      // `invalidate`-on-drift is not yet wired, so a cached `ok` cannot be proven fresh.
      failClosedWithoutFreshness: true,
    } as ConstructorParameters<typeof CovenantReadAuthority>[0]);
    expect((await authority.resolve('o_span')).covenantStatus).toBe('ok');
    // not-theater: base ignores the flag ⇒ `isFresh` returns `true` ⇒ `read()` serves
    // the cached `ok` (the fail-open the gauntlet caught). The fix serves `~`.
    expect(authority.read('o_span').covenantStatus).not.toBe('ok');
    expect(authority.read('o_span').covenantStatus).toBe('unresolved');
  });

  it('the DEFAULT (invalidate-driven) mode is unchanged: without the flag, a cached `ok` still serves', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
      // no failClosedWithoutFreshness, no port ⇒ trust-until-invalidate (unchanged).
    });
    expect((await authority.resolve('o_span')).covenantStatus).toBe('ok');
    expect(authority.read('o_span').covenantStatus).toBe('ok');
    // An explicit invalidate still drops it (the invalidate-driven contract).
    authority.invalidate('o_span');
    expect(authority.read('o_span').covenantStatus).toBe('unresolved');
  });

  it('generation guard: a FRESH resolve after invalidate does repopulate (the guard only drops the pre-drift one)', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
    });
    await authority.resolve('o_span');
    authority.invalidate('o_span');
    expect(authority.read('o_span').covenantStatus).toBe('unresolved'); // dropped
    // A fresh resolve under the new generation caches again (content still unchanged ⇒ ok).
    expect((await authority.resolve('o_span')).covenantStatus).toBe('ok');
    expect(authority.read('o_span').covenantStatus).toBe('ok');
  });

  // ── E7 (#199 Fix 4): the failClosedWithoutFreshness read() NEVER vouches for a cached
  // `ok` — there is no `sweepLive`/`markSweepLive` gate to "open" trust (removed as dead
  // on the production wiring). Freshness is driven by `invalidate` + a fresh `resolve()`.
  it('failClosedWithoutFreshness: read() never serves a cached `ok`; resolve() still yields the real verdict', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const authority = new CovenantReadAuthority({
      loadAnchor: async () => anchor,
      resolveSpan: resolverFor(doc),
      failClosedWithoutFreshness: true, // server mode: no sync doc handle
    });
    // A genuine `ok` resolves…
    expect((await authority.resolve('o_span')).covenantStatus).toBe('ok');
    // …but the sync read() demotes it to `~` (it cannot prove freshness on its own).
    expect(authority.read('o_span').covenantStatus).not.toBe('ok');
    // Re-resolving does not change the read() contract — there is no boolean to flip.
    expect((await authority.resolve('o_span')).covenantStatus).toBe('ok');
    expect(authority.read('o_span').covenantStatus).not.toBe('ok');
    // There is no `markSweepLive` API any more — the dead trust-gate was removed.
    expect((authority as unknown as { markSweepLive?: unknown }).markSweepLive).toBeUndefined();
  });

  it('invalidateAll: the teardown hook drops EVERY cached object at once (read returns `~`)', async () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const authority = new CovenantReadAuthority({
      loadAnchor: async (objectId) => ({ ...anchor, objectId }),
      resolveSpan: resolverFor(doc),
    });
    await authority.resolve('o_a');
    await authority.resolve('o_b');
    expect(authority.read('o_a').covenantStatus).toBe('ok');
    expect(authority.read('o_b').covenantStatus).toBe('ok');
    authority.invalidateAll();
    expect(authority.read('o_a').covenantStatus).toBe('unresolved');
    expect(authority.read('o_b').covenantStatus).toBe('unresolved');
  });
});
