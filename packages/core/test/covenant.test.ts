import { describe, expect, it } from 'vitest';
import {
  type CapturedSelection,
  type CovenantAnchor,
  type CovenantDocReader,
  canonicalRendered,
  certifyAnchor,
  type EnclosedItem,
  type RenderedFragment,
  renderedDigestOf,
  resolveCovenant,
  sha256Hex,
} from '../src/index.js';

/**
 * The covenant anchor + `resolveCovenant`, pinned at the pure core level. The
 * document is a stub reader that genuinely consumes EVERY anchor field, so a
 * flip of any field moves the verdict — the "if flipping an input doesn't move
 * the output the field isn't wired" discipline, made mechanical. A companion
 * suite (`covenant-conformance.test.ts`) proves the same against a real in-memory
 * Y.Doc through the reference reader.
 */

const ALICE = { kind: 'human', userId: 'u_alice' } as const;
const AT = '2026-08-16T12:00:00.000Z';

/**
 * A stub live document. It holds ONE known snapshot keyed by (revision,
 * stateVector, deleteSet); `resolveSpan` returns the current fragment only when
 * the anchor's resolution context matches that snapshot AND every anchored item
 * still exists — otherwise `null`, the fail-closed signal. This is the minimal
 * faithful model of what a Yjs reader does: resolve positions against a
 * historical revision, or fail if the doc moved out from under them / GC'd them.
 */
class StubDoc implements CovenantDocReader {
  constructor(
    public revision: number,
    public stateVector: string,
    public deleteSet: string,
    public fragment: RenderedFragment,
    public enclosedItems: EnclosedItem[],
    /** Ids the doc still knows; a GC removes an id from this set. */
    public liveIds: Set<string> = new Set(enclosedItems.map((i) => i.id)),
    /** When false, the doc handle itself is unavailable. */
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

  resolveSpan(anchor: CovenantAnchor) {
    if (!this.available) return null;
    // Any anchored item that has been GC'd ⇒ unresolvable (fail-closed null).
    if (this.enclosedItems.some((i) => !this.liveIds.has(i.id))) return null;
    // Resolution context is VERIFIED, not trusted (class C): a foreign revision /
    // state vector / delete set fails verification, and resolveCovenant turns an
    // unverified snapshot into DRIFT regardless of the digest.
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
      { kind: 'embed', embedType: 'image', identity: { src: 'https://x/a.png' }, marks: [] },
    ],
  };
}

function sampleDoc(): StubDoc {
  const fragment = sampleFragment();
  const enclosed: EnclosedItem[] = [
    { id: 'i_text', kind: 'text' },
    { id: 'i_mention', kind: 'embed' },
    { id: 'i_image', kind: 'embed' },
  ];
  return new StubDoc(7, 'sv-base', 'ds-base', fragment, enclosed);
}

function anchorFor(doc: StubDoc): CovenantAnchor {
  const anchor = certifyAnchor(doc, {
    objectId: 'o_span',
    roomId: 'room_1',
    certifier: ALICE,
    certifiedAt: AT,
  });
  if (anchor === null) throw new Error('capture failed in fixture');
  return anchor;
}

describe('sha256Hex — the digest is a correct SHA-256 (FIPS-180-4 vectors)', () => {
  it('hashes the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('hashes "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('hashes the 56-byte multi-block vector', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });
  it('hashes multi-byte UTF-8 the same way every run (deterministic, no globals)', () => {
    expect(sha256Hex('✓ résumé 🚀')).toBe(sha256Hex('✓ résumé 🚀'));
    expect(sha256Hex('✓')).not.toBe(sha256Hex('~'));
  });
});

describe('certifyAnchor — the digest is computed here, not accepted from the reader', () => {
  it('captures the complete anchor with a digest over the rendered fragment', () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    expect(anchor.revision).toBe(7);
    expect(anchor.stateVector).toBe('sv-base');
    expect(anchor.deleteSet).toBe('ds-base');
    expect(anchor.enclosedItems).toHaveLength(3);
    expect(anchor.renderedDigest).toBe(renderedDigestOf(doc.fragment));
    expect(anchor.renderedDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  it('returns null when the selection cannot even be captured (no `✓` over a lie)', () => {
    const doc = sampleDoc();
    doc.available = false;
    expect(
      certifyAnchor(doc, { objectId: 'o', roomId: 'r', certifier: ALICE, certifiedAt: AT }),
    ).toBeNull();
  });
});

describe('resolveCovenant — byte-identical re-render is the only OK (class 7)', () => {
  it('resolves OK when nothing moved', () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const res = resolveCovenant(doc, anchor);
    expect(res.covenantStatus).toBe('ok');
    expect(res.revision).toBe(7);
    expect(res.renderedFragment).not.toBeNull();
  });
});

describe('resolveCovenant — each drift class moves the verdict to DRIFT', () => {
  it('class 1: an enclosed item’s text changed', () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    (doc.fragment.nodes[0] as { text: string }).text = 'ship it now';
    expect(resolveCovenant(doc, anchor).covenantStatus).toBe('drift');
  });

  it('class 2: ancestor formatting changed (heading level)', () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    (doc.fragment.ancestors[0] as { attrs: Record<string, string> }).attrs.level = '3';
    expect(resolveCovenant(doc, anchor).covenantStatus).toBe('drift');
  });

  it('class 3: a mark straddling the boundary changed', () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const mark = (doc.fragment.nodes[0] as { marks: { straddles: string }[] }).marks[0] as {
      straddles: string;
    };
    mark.straddles = 'both'; // grew to also straddle the end
    expect(resolveCovenant(doc, anchor).covenantStatus).toBe('drift');
  });

  it('class 4a: an embed internal — mention target — changed', () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    (doc.fragment.nodes[1] as { identity: Record<string, string> }).identity.target = 'u_bob';
    expect(resolveCovenant(doc, anchor).covenantStatus).toBe('drift');
  });

  it('class 4b: an embed internal — image URL — changed', () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    (doc.fragment.nodes[2] as { identity: Record<string, string> }).identity.src =
      'https://x/b.png';
    expect(resolveCovenant(doc, anchor).covenantStatus).toBe('drift');
  });

  it('class 5: an enclosed item was deleted (identity set changed)', () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    // The image node is removed from BOTH the rendered fragment and the identity
    // set — caught on the identity axis before the digest is even consulted.
    doc.fragment.nodes.pop();
    doc.enclosedItems.pop();
    expect(resolveCovenant(doc, anchor).covenantStatus).toBe('drift');
  });

  it('class 6a: the doc is unavailable → DRIFT, never OK (fail-closed)', () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    doc.available = false;
    const res = resolveCovenant(doc, anchor);
    expect(res.covenantStatus).toBe('drift');
    expect(res.renderedFragment).toBeNull();
  });

  it('class 6b: an anchored item was GC’d → unresolvable → DRIFT', () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    doc.liveIds.delete('i_mention');
    expect(resolveCovenant(doc, anchor).covenantStatus).toBe('drift');
  });
});

describe('flip-the-input — mutating ANY anchor field moves the verdict', () => {
  // The proof that each field is WIRED: certify against a clean doc, corrupt one
  // field of the persisted anchor, and require DRIFT. A field that does not move
  // the verdict is a field the anchor carries for show.
  it('revision', () => {
    const doc = sampleDoc();
    const res = resolveCovenant(doc, { ...anchorFor(doc), revision: 8 });
    expect(res.covenantStatus).toBe('drift');
  });
  it('stateVector', () => {
    const doc = sampleDoc();
    const res = resolveCovenant(doc, { ...anchorFor(doc), stateVector: 'sv-forged' });
    expect(res.covenantStatus).toBe('drift');
  });
  it('deleteSet', () => {
    const doc = sampleDoc();
    const res = resolveCovenant(doc, { ...anchorFor(doc), deleteSet: 'ds-forged' });
    expect(res.covenantStatus).toBe('drift');
  });
  it('enclosedItems', () => {
    const doc = sampleDoc();
    const anchor = anchorFor(doc);
    const res = resolveCovenant(doc, {
      ...anchor,
      enclosedItems: [...anchor.enclosedItems, { id: 'i_ghost', kind: 'text' }],
    });
    expect(res.covenantStatus).toBe('drift');
  });
  it('renderedDigest', () => {
    const doc = sampleDoc();
    const res = resolveCovenant(doc, {
      ...anchorFor(doc),
      renderedDigest: 'f'.repeat(64),
    });
    expect(res.covenantStatus).toBe('drift');
  });
});

describe('canonicalRendered — deterministic regardless of key insertion order', () => {
  it('two fragments equal up to key order digest identically', () => {
    const a: RenderedFragment = {
      ancestors: [{ type: 'p', attrs: { a: '1', b: '2' } }],
      nodes: [{ kind: 'text', text: 'x', marks: [] }],
    };
    const b: RenderedFragment = {
      ancestors: [{ type: 'p', attrs: { b: '2', a: '1' } }],
      nodes: [{ kind: 'text', text: 'x', marks: [] }],
    };
    expect(canonicalRendered(a)).toBe(canonicalRendered(b));
    expect(renderedDigestOf(a)).toBe(renderedDigestOf(b));
  });
});

describe('deterministic canonicalization — same logical content ⇒ same digest (class E)', () => {
  const wrap = (nodes: RenderedFragment['nodes']): RenderedFragment => ({ ancestors: [], nodes });

  it('NFC-normalizes strings (composed vs decomposed accents agree)', () => {
    const composedText = 'resume'.replace('e', 'é').normalize('NFC'); // é as one code point
    const decomposedText = composedText.normalize('NFD'); // e + combining acute (U+0301)
    expect(composedText).not.toBe(decomposedText); // genuinely different byte strings
    const composed = wrap([{ kind: 'text', text: composedText, marks: [] }]);
    const decomposed = wrap([{ kind: 'text', text: decomposedText, marks: [] }]);
    expect(renderedDigestOf(composed)).toBe(renderedDigestOf(decomposed));
  });

  it('sorts marks[] — mark order is not rendered meaning', () => {
    const one = wrap([
      {
        kind: 'text',
        text: 'x',
        marks: [
          { type: 'bold', attrs: {}, straddles: 'none' },
          { type: 'italic', attrs: {}, straddles: 'none' },
        ],
      },
    ]);
    const two = wrap([
      {
        kind: 'text',
        text: 'x',
        marks: [
          { type: 'italic', attrs: {}, straddles: 'none' },
          { type: 'bold', attrs: {}, straddles: 'none' },
        ],
      },
    ]);
    expect(renderedDigestOf(one)).toBe(renderedDigestOf(two));
  });

  it('coalesces adjacent same-mark text runs — Yjs op-splitting is not meaning', () => {
    const split = wrap([
      { kind: 'text', text: 'ship ', marks: [{ type: 'bold', attrs: {}, straddles: 'none' }] },
      { kind: 'text', text: 'it', marks: [{ type: 'bold', attrs: {}, straddles: 'none' }] },
    ]);
    const whole = wrap([
      { kind: 'text', text: 'ship it', marks: [{ type: 'bold', attrs: {}, straddles: 'none' }] },
    ]);
    expect(renderedDigestOf(split)).toBe(renderedDigestOf(whole));
  });

  it('does NOT coalesce across different marks (a real change still moves the digest)', () => {
    const differing = wrap([
      { kind: 'text', text: 'ship ', marks: [{ type: 'bold', attrs: {}, straddles: 'none' }] },
      { kind: 'text', text: 'it', marks: [] },
    ]);
    const allBold = wrap([
      { kind: 'text', text: 'ship it', marks: [{ type: 'bold', attrs: {}, straddles: 'none' }] },
    ]);
    expect(renderedDigestOf(differing)).not.toBe(renderedDigestOf(allBold));
  });

  it('a real content change still moves the digest (normalization is not blindness)', () => {
    const a = wrap([{ kind: 'text', text: 'ship it', marks: [] }]);
    const b = wrap([{ kind: 'text', text: 'ship it now', marks: [] }]);
    expect(renderedDigestOf(a)).not.toBe(renderedDigestOf(b));
  });
});

describe('EXACT content: NFC-only normalization — the prose fold is GONE (round-3 CRITICAL)', () => {
  const wrap = (nodes: RenderedFragment['nodes']): RenderedFragment => ({ ancestors: [], nodes });
  const text = (t: string): RenderedFragment => wrap([{ kind: 'text', text: t, marks: [] }]);

  // Each of these resolved `ok` under the removed `normalizeForReceipt` prose fold;
  // under EXACT content each MUST move the digest (→ DRIFT when re-resolved).
  it('whitespace is content: `ship it` vs `ship  it` (double space) → different digest', () => {
    expect(renderedDigestOf(text('ship it'))).not.toBe(renderedDigestOf(text('ship  it')));
  });
  it('a newline is content: `ship it` vs `ship\\nit` → different digest', () => {
    expect(renderedDigestOf(text('ship it'))).not.toBe(renderedDigestOf(text('ship\nit')));
  });
  it('leading/trailing whitespace is content (no trim): ` x ` vs `x` → different digest', () => {
    expect(renderedDigestOf(text(' x '))).not.toBe(renderedDigestOf(text('x')));
  });
  it('apostrophes are content: straight vs curly apostrophe → different digest', () => {
    expect(renderedDigestOf(text("won't"))).not.toBe(renderedDigestOf(text('won’t')));
  });
  it('an injected ZERO-WIDTH SPACE is content (the mention-target attack) → different digest', () => {
    const clean = wrap([
      { kind: 'embed', embedType: 'mention', identity: { target: 'u_alice' }, marks: [] },
    ]);
    const zwsp = wrap([
      { kind: 'embed', embedType: 'mention', identity: { target: 'u_ali​ce' }, marks: [] },
    ]);
    expect(renderedDigestOf(clean)).not.toBe(renderedDigestOf(zwsp));
  });
  it('an image src with an invisible char is content → different digest', () => {
    const clean = wrap([
      { kind: 'embed', embedType: 'image', identity: { src: 'https://x/a.png' }, marks: [] },
    ]);
    const inv = wrap([
      { kind: 'embed', embedType: 'image', identity: { src: 'https://x/a​png' }, marks: [] },
    ]);
    expect(renderedDigestOf(clean)).not.toBe(renderedDigestOf(inv));
  });
  it('markdown is NOT unfolded: `foo bar` vs `[foo](bar)` → different digest', () => {
    expect(renderedDigestOf(text('foo bar'))).not.toBe(renderedDigestOf(text('[foo](bar)')));
  });

  // The ONE thing NFC SHOULD fold: canonical (composed vs decomposed) equivalence.
  it('NFC still folds canonical equivalence: composed `é` vs decomposed `é` → SAME digest', () => {
    const composed = 'café'; // é as U+00E9
    const decomposed = 'café'; // e + combining acute U+0301
    expect(composed).not.toBe(decomposed);
    expect(renderedDigestOf(text(composed))).toBe(renderedDigestOf(text(decomposed)));
  });
});

describe('fail-closed on throw — a reader that throws yields DRIFT, never OK (class D)', () => {
  const anchorFixture = (): CovenantAnchor => anchorFor(sampleDoc());

  it('a reader whose resolveSpan throws ⇒ DRIFT, not an unhandled exception', () => {
    const throwing: CovenantDocReader = {
      captureSelection: () => null,
      resolveSpan: () => {
        throw new Error('boom (a _item.id deref on a root type)');
      },
    };
    const res = resolveCovenant(throwing, anchorFixture());
    expect(res.covenantStatus).toBe('drift');
    expect(res.renderedFragment).toBeNull();
  });

  it('a reader that returns a malformed fragment ⇒ DRIFT (renderedDigestOf parses it)', () => {
    const malformed: CovenantDocReader = {
      captureSelection: () => null,
      // `nodes` is not an array — RenderedFragment.parse throws inside renderedDigestOf.
      resolveSpan: () => ({
        fragment: { ancestors: [], nodes: undefined as unknown as RenderedFragment['nodes'] },
        enclosedItems: [],
        snapshotVerified: true,
      }),
    };
    const res = resolveCovenant(malformed, anchorFixture());
    expect(res.covenantStatus).toBe('drift');
  });

  it('a malformed ANCHOR (bad shape) ⇒ DRIFT, never a throw out of resolveCovenant', () => {
    const doc = sampleDoc();
    const bad = { ...anchorFor(doc), renderedDigest: 'not-a-sha' } as unknown as CovenantAnchor;
    const res = resolveCovenant(doc, bad);
    expect(res.covenantStatus).toBe('drift');
  });
});

describe('snapshot is verified, not trusted (class C)', () => {
  it('a forged revision the reader cannot confirm ⇒ DRIFT even with a matching digest', () => {
    const doc = sampleDoc();
    const res = resolveCovenant(doc, { ...anchorFor(doc), revision: 999 });
    expect(res.covenantStatus).toBe('drift');
  });
  it('a forged state vector ⇒ DRIFT', () => {
    const doc = sampleDoc();
    const res = resolveCovenant(doc, { ...anchorFor(doc), stateVector: 'forged' });
    expect(res.covenantStatus).toBe('drift');
  });
});
