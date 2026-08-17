import { describe, expect, it } from 'vitest';
import {
  type CapturedSelection,
  type CovenantAnchor,
  type CovenantDocReader,
  CovenantReadAuthority,
  certifyAnchor,
  type EnclosedItem,
  type RenderedFragment,
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
