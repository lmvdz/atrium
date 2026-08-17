import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { type CovenantAnchor, certifyAnchor, resolveCovenant } from '../src/index.js';
import { YjsCovenantDocReader } from './support/yjs-reader.js';

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/**
 * THE `CovenantDocReader` CONFORMANCE SUITE.
 *
 * `covenant.test.ts` pins the pure primitive against a stub; THIS suite is the
 * CONTRACT the production reader (#181/#183) must satisfy. Every advertised drift
 * class has a test that mutates a REAL Yjs document through the REAL reference
 * reader (`support/yjs-reader.ts`) and asserts `resolveCovenant` MOVES to DRIFT —
 * so a reader that reintroduces a round-1 hole (hardcoded `straddles:'none'`, only
 * the heading `level`, ignored embed children, flattened string marks, a
 * fixed-index span, an ornamental snapshot) FAILS this suite instead of shipping a
 * false `✓`. Round-1's "test theater" — cases that mutated something EASIER than
 * the class they claimed (a heading level standing in for all ancestor formatting,
 * a fully-enclosed bold standing in for a straddling mark) — are replaced here by
 * mutations that exercise the exact hole the gauntlet executed.
 *
 * Each mark/ancestor/content mutation is an IN-PLACE Yjs edit (no item replaced),
 * so the drift can ONLY come from the reader rendering the change — never
 * incidentally from the enclosed-item identity axis. Embed-field completeness is
 * proved directly (two docs differing only in the field digest differently) AND
 * end-to-end (mutating the embed drifts).
 *
 * ## The document shape
 *
 *   fragment('doc')
 *     └ <blockquote indent align>                         ← ancestor (all attrs)
 *        └ <heading level>                                 ← ancestor
 *           └ Y.XmlText body:
 *               "Ready " · "ship it"(bold) · " " · [mention target,label] ·
 *               " " · [image src] · " " · [nestedDoc child] · " now"(highlight)
 *
 * The certified span is the character range [8, 21): it starts INSIDE the bold run
 * (so the bold straddles start), ends INSIDE the highlight run (straddles end),
 * and encloses all three embeds — one span that touches every class.
 */

const ALICE = { kind: 'human', userId: 'u_alice' } as const;
const AT = '2026-08-16T12:00:00.000Z';
const SPAN = { start: 8, end: 21 } as const;

interface Built {
  doc: Y.Doc;
  body: Y.XmlText;
  heading: Y.XmlElement;
  blockquote: Y.XmlElement;
}

function makeDoc(): Built {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('doc');
  const blockquote = new Y.XmlElement('blockquote');
  blockquote.setAttribute('indent', '1');
  blockquote.setAttribute('align', 'left');
  const heading = new Y.XmlElement('heading');
  heading.setAttribute('level', '2');
  const body = new Y.XmlText();
  frag.insert(0, [blockquote]);
  blockquote.insert(0, [heading]);
  heading.insert(0, [body]);
  body.insert(0, 'Ready ');
  body.insert(6, 'ship it');
  body.insert(13, ' ');
  body.insertEmbed(14, { embedType: 'mention', target: 'u_alice', label: 'Alice' });
  body.insert(15, ' ');
  body.insertEmbed(16, { embedType: 'image', src: 'https://x/a.png' });
  body.insert(17, ' ');
  body.insertEmbed(18, { embedType: 'nestedDoc', child: 'nested body' });
  body.insert(19, ' now');
  body.format(6, 7, { bold: true }); // "ship it"
  body.format(19, 4, { highlight: 'yellow' }); // " now", string-valued mark
  return { doc, body, heading, blockquote };
}

/** A reader that will CAPTURE the span at [8,21) from this doc. */
function capturingReader(doc: Y.Doc): YjsCovenantDocReader {
  return new YjsCovenantDocReader(doc, { path: [0, 0, 0], start: SPAN.start, end: SPAN.end });
}

function certify(reader: YjsCovenantDocReader): CovenantAnchor {
  const anchor = certifyAnchor(reader, {
    objectId: 'o_span',
    roomId: 'room_1',
    certifier: ALICE,
    certifiedAt: AT,
  });
  if (anchor === null) throw new Error('capture failed');
  return anchor;
}

function status(reader: YjsCovenantDocReader, anchor: CovenantAnchor) {
  return resolveCovenant(reader, anchor).covenantStatus;
}

describe('CovenantDocReader conformance — the honest reference over a real Y.Doc', () => {
  it('class 7: byte-identical (no edit) → OK', () => {
    const { doc } = makeDoc();
    const reader = capturingReader(doc);
    expect(status(reader, certify(reader))).toBe('ok');
  });

  it('class 1: a typed character inside the span → DRIFT', () => {
    const { doc, body } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    body.insert(9, 'X'); // inside "ship it"
    expect(status(reader, anchor)).toBe('drift');
  });

  // ── class 2: ALL ancestor formatting, not just heading level ────────────────
  it('class 2a: ancestor heading level changed → DRIFT', () => {
    const { doc, heading } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    heading.setAttribute('level', '3');
    expect(status(reader, anchor)).toBe('drift');
  });
  it('class 2b: an OUTER ancestor (blockquote indent) changed → DRIFT (round-1 missed this)', () => {
    const { doc, blockquote } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    blockquote.setAttribute('indent', '2');
    expect(status(reader, anchor)).toBe('drift');
  });
  it('class 2c: an ancestor align changed → DRIFT', () => {
    const { doc, blockquote } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    blockquote.setAttribute('align', 'center');
    expect(status(reader, anchor)).toBe('drift');
  });

  // ── class 3: marks — the straddle and the string payload the round-1 reader dropped
  it('class 3a: a STRADDLING mark stops straddling (bold before the span removed) → DRIFT', () => {
    // In-place unformat of chars [6,8) — OUTSIDE the span. The enclosed text and
    // its marks are byte-identical; ONLY the boundary straddle changes from
    // `start` to `none`. A reader hardcoding `straddles:'none'` would NOT drift.
    const { doc, body } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    body.format(6, 2, { bold: null });
    expect(status(reader, anchor)).toBe('drift');
  });
  it('class 3b: a STRING-VALUED mark payload changed (highlight yellow→red) → DRIFT', () => {
    // In-place format change, no item replaced. A reader flattening string marks
    // to `{}` renders yellow and red identically and would NOT drift.
    const { doc, body } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    body.format(19, 4, { highlight: 'red' });
    expect(status(reader, anchor)).toBe('drift');
  });
  it('the reader CAPTURES the string mark payload (yellow vs red digest differently)', () => {
    const yellow = certify(capturingReader(makeDoc().doc));
    const red = (() => {
      const { doc, body } = makeDoc();
      body.format(19, 4, { highlight: 'red' });
      return certify(capturingReader(doc));
    })();
    expect(yellow.renderedDigest).not.toBe(red.renderedDigest);
  });

  // ── class 4: embed internals + CHILDREN ─────────────────────────────────────
  it('class 4a: a mention target re-pointed → DRIFT', () => {
    const { doc, body } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    body.delete(14, 1);
    body.insertEmbed(14, { embedType: 'mention', target: 'u_bob', label: 'Alice' });
    expect(status(reader, anchor)).toBe('drift');
  });
  it('class 4b: a mention LABEL (embed child content) changed, same target → DRIFT', () => {
    const { doc, body } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    body.delete(14, 1);
    body.insertEmbed(14, { embedType: 'mention', target: 'u_alice', label: 'Alicia' });
    expect(status(reader, anchor)).toBe('drift');
  });
  it('class 4c: an image src swapped → DRIFT', () => {
    const { doc, body } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    body.delete(16, 1);
    body.insertEmbed(16, { embedType: 'image', src: 'https://x/b.png' });
    expect(status(reader, anchor)).toBe('drift');
  });
  it('class 4d: a nested-doc CHILD content edit → DRIFT (the docDigest moves)', () => {
    const { doc, body } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    body.delete(18, 1);
    body.insertEmbed(18, { embedType: 'nestedDoc', child: 'CHANGED nested body' });
    expect(status(reader, anchor)).toBe('drift');
  });
  it('the reader CAPTURES embed children (a differing nested-doc child digests differently)', () => {
    const a = certify(capturingReader(makeDoc().doc));
    const b = (() => {
      const { doc, body } = makeDoc();
      body.delete(18, 1);
      body.insertEmbed(18, { embedType: 'nestedDoc', child: 'a different nested body' });
      return certify(capturingReader(doc));
    })();
    expect(a.renderedDigest).not.toBe(b.renderedDigest);
  });

  // ── class 5: identity — a deleted enclosed item ─────────────────────────────
  it('class 5: an enclosed embed deleted → DRIFT (identity set + digest)', () => {
    const { doc, body } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    body.delete(16, 1); // remove the image embed
    expect(status(reader, anchor)).toBe('drift');
  });

  // ── class 6: fail-closed ────────────────────────────────────────────────────
  it('class 6a: the doc became unavailable → DRIFT, fragment null (fail-closed)', () => {
    const { doc } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    reader.makeUnavailable();
    const res = resolveCovenant(reader, anchor);
    expect(res.covenantStatus).toBe('drift');
    expect(res.renderedFragment).toBeNull();
  });
  it('class 6b: the whole span deleted + GC → unresolvable → DRIFT, fragment null', () => {
    const { doc } = makeDoc();
    doc.gc = true;
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    doc.getXmlFragment('doc').delete(0, 1); // delete the blockquote subtree
    const res = resolveCovenant(reader, anchor);
    expect(res.covenantStatus).toBe('drift');
    expect(res.renderedFragment).toBeNull();
  });

  it('a revert to the certified content resolves OK again', () => {
    const { doc, body } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    body.insert(9, 'X');
    expect(status(reader, anchor)).toBe('drift');
    body.delete(9, 1);
    expect(status(reader, anchor)).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// class B — the span resolves from the PERSISTED boundaries, after a reload, and
// a sibling inserted at the same index cannot redirect the anchor to it.
// ─────────────────────────────────────────────────────────────────────────────
describe('resolution from persisted boundaries (class B)', () => {
  it('a FRESH reader with no in-memory span state resolves the anchor from the ledger', () => {
    const { doc } = makeDoc();
    const anchor = certify(capturingReader(doc));
    // The production path: a reader constructed only from the live doc, resolving
    // an anchor loaded from Postgres. No captureSelection() was ever called on it.
    const reload = new YjsCovenantDocReader(doc);
    expect(status(reload, anchor)).toBe('ok');
  });

  it('after reload, an edit inside the span → DRIFT (the persisted positions are live)', () => {
    const { doc, body } = makeDoc();
    const anchor = certify(capturingReader(doc));
    const reload = new YjsCovenantDocReader(doc);
    body.insert(9, 'Z');
    expect(status(reload, anchor)).toBe('drift');
  });

  it('empty-span-sibling: certify an empty heading, insert an empty sibling at index 0, type into the ORIGINAL → DRIFT (not a false ✓ against the sibling)', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', '2');
    const body = new Y.XmlText(); // empty
    frag.insert(0, [heading]);
    heading.insert(0, [body]);
    // certify the empty span [0,0) of the ORIGINAL heading's body
    const anchor = certify(new YjsCovenantDocReader(doc, { path: [0, 0], start: 0, end: 0 }));
    expect(status(new YjsCovenantDocReader(doc), anchor)).toBe('ok'); // still empty ⇒ OK

    // insert a SECOND empty heading at fragment index 0 (the original shifts to 1)
    const sibling = new Y.XmlElement('heading');
    sibling.setAttribute('level', '2');
    sibling.insert(0, [new Y.XmlText()]);
    frag.insert(0, [sibling]);

    // type into the ORIGINAL body — a fixed-index reader would read the empty
    // sibling and report OK; the honest reader tracks the original ⇒ DRIFT.
    body.insert(0, 'snuck in');
    expect(status(new YjsCovenantDocReader(doc), anchor)).toBe('drift');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// class C — the captured snapshot is VERIFIED against the live doc, not trusted.
// ─────────────────────────────────────────────────────────────────────────────
describe('snapshot verified against the live doc (class C)', () => {
  it('a forged revision (999) the reader cannot confirm → DRIFT, on the REAL reader', () => {
    const { doc } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    expect(status(reader, { ...anchor, revision: 999 })).toBe('drift');
  });
  it('a forged state vector → DRIFT', () => {
    const { doc } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    expect(status(reader, { ...anchor, stateVector: 'forged' })).toBe('drift');
  });
  it('a forged delete set → DRIFT', () => {
    const { doc } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    // A delete set naming a deletion the live doc never made.
    const forged = Buffer.from(JSON.stringify({ '99999': [[0, 5]] })).toString('base64');
    expect(status(reader, { ...anchor, deleteSet: forged })).toBe('drift');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FLIP-THE-INPUT on the REAL reader — every anchor field that participates in
// resolution moves the verdict when mutated. A field that cannot move it is
// unwired; each of these moves it, so each is load-bearing.
// ─────────────────────────────────────────────────────────────────────────────
describe('flip-the-input on the real Yjs reader — every field is wired', () => {
  const fresh = () => {
    const { doc } = makeDoc();
    const reader = capturingReader(doc);
    return { reader, anchor: certify(reader) };
  };

  it('revision', () => {
    const { reader, anchor } = fresh();
    expect(status(reader, { ...anchor, revision: anchor.revision + 500 })).toBe('drift');
  });
  it('stateVector', () => {
    const { reader, anchor } = fresh();
    expect(status(reader, { ...anchor, stateVector: 'AAAAAAAA' })).toBe('drift');
  });
  it('deleteSet', () => {
    const { reader, anchor } = fresh();
    const forged = Buffer.from(JSON.stringify({ '4242': [[0, 3]] })).toString('base64');
    expect(status(reader, { ...anchor, deleteSet: forged })).toBe('drift');
  });
  it('relStart (a broken position no longer resolves the span)', () => {
    const { reader, anchor } = fresh();
    expect(status(reader, { ...anchor, relStart: '!!!not-base64!!!' })).toBe('drift');
  });
  it('relEnd (moving the end boundary changes the enclosed content)', () => {
    const { reader, anchor } = fresh();
    // Re-point relEnd at the start ⇒ an empty/shrunk span ⇒ a different digest.
    expect(status(reader, { ...anchor, relEnd: anchor.relStart })).toBe('drift');
  });
  it('enclosedItems (a ghost item in the identity set)', () => {
    const { reader, anchor } = fresh();
    expect(
      status(reader, {
        ...anchor,
        enclosedItems: [...anchor.enclosedItems, { id: '9:9', kind: 'text' }],
      }),
    ).toBe('drift');
  });
  it('renderedDigest', () => {
    const { reader, anchor } = fresh();
    expect(status(reader, { ...anchor, renderedDigest: 'f'.repeat(64) })).toBe('drift');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EXACT content, on the REAL reader (round-3 CRITICAL). The prose fold that let
// mutated content resolve `ok` is gone; whitespace between two embeds is content.
// ─────────────────────────────────────────────────────────────────────────────
describe('EXACT content on the real Yjs reader — no prose fold (round-3 CRITICAL)', () => {
  // grok's sharpest case: mention · " " · image. The space is a text run BETWEEN
  // two embeds; deleting it collided the two embeds under the old fold (the run
  // trimmed to '' and was dropped, enclosedItems listed only the embeds, and the
  // digest did not move → false ✓). Under NFC-only the space is content.
  function embedSpaceEmbed(): { doc: Y.Doc; body: Y.XmlText } {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insertEmbed(0, { embedType: 'mention', target: 'u_alice', label: 'Alice' });
    body.insert(1, ' ');
    body.insertEmbed(2, { embedType: 'image', src: 'https://x/a.png' });
    return { doc, body };
  }

  it('delete the space between a mention and an image → DRIFT (the collide-embeds attack)', () => {
    const { doc, body } = embedSpaceEmbed();
    const reader = new YjsCovenantDocReader(doc, { path: [0, 0], start: 0, end: 3 });
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok'); // unchanged
    body.delete(1, 1); // remove the space
    expect(status(reader, anchor)).toBe('drift');
  });

  it('a double space inside the span → DRIFT (whitespace runs are not collapsed)', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insert(0, 'ship it');
    const reader = new YjsCovenantDocReader(doc, { path: [0, 0], start: 0, end: 7 });
    const anchor = certify(reader);
    body.insert(4, ' '); // "ship  it" (double space)
    expect(status(reader, anchor)).toBe('drift');
  });

  it('inject a zero-width space into a mention target → DRIFT (agent-peer write attack)', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insertEmbed(0, { embedType: 'mention', target: 'u_alice', label: 'Alice' });
    const reader = new YjsCovenantDocReader(doc, { path: [0, 0], start: 0, end: 1 });
    const anchor = certify(reader);
    body.delete(0, 1);
    body.insertEmbed(0, { embedType: 'mention', target: 'u_ali​ce', label: 'Alice' });
    expect(status(reader, anchor)).toBe('drift');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STRICT snapshot verification (round-3 HIGH). The captured snapshot must be the
// certify-time value, not merely a consistent prefix / a weakened subset.
// ─────────────────────────────────────────────────────────────────────────────
describe('strict snapshot verification — weakened values are rejected (round-3 HIGH)', () => {
  it('a ZEROED revision + EMPTIED state vector → DRIFT (was a consistent prefix of every doc)', () => {
    const { doc } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    // (revision:0, stateVector:<empty>) is internally consistent (sum 0 == 0) and a
    // prefix of every live doc — the old vacuous pass. The span's real items are not
    // covered by an empty SV, so it is now DRIFT.
    const emptySV = b64(Y.encodeStateVector(new Y.Doc()));
    expect(status(reader, { ...anchor, revision: 0, stateVector: emptySV })).toBe('drift');
  });

  it('a non-empty captured deleteSet REPLACED BY EMPTY → DRIFT (weakening rejected)', () => {
    // A doc with a real pre-certify deletion, so the captured deleteSet is non-empty.
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insert(0, 'shipXit');
    body.delete(4, 1); // delete the 'X' (strictly inside) → a real deletion in the delete set
    const reader = new YjsCovenantDocReader(doc, { path: [0, 0], start: 0, end: 6 });
    const anchor = certify(reader);
    // Sanity: the captured deleteSet really is non-empty.
    const capturedDS = JSON.parse(Buffer.from(anchor.deleteSet, 'base64').toString('utf8'));
    expect(Object.keys(capturedDS).length).toBeGreaterThan(0);
    expect(status(reader, anchor)).toBe('ok'); // the honest anchor resolves OK
    // Weaken the deleteSet to empty; the completeness check now fails → DRIFT.
    const emptied = Buffer.from(JSON.stringify({})).toString('base64');
    expect(status(reader, { ...anchor, deleteSet: emptied })).toBe('drift');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Embed-boundary straddle (round-3 MEDIUM). A mark straddling an EMBED boundary
// (not an inside-text boundary) must be detected, or a retarget across it is a
// byte-identical lie.
// ─────────────────────────────────────────────────────────────────────────────
describe('embed-boundary straddle (round-3 MEDIUM)', () => {
  function bar(): { doc: Y.Doc; body: Y.XmlText } {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insert(0, 'AB'); // idx 0,1
    body.insertEmbed(2, { embedType: 'tag', id: 't1' }); // idx 2
    body.insert(3, 'CD'); // idx 3,4
    body.format(0, 5, { bold: true }); // bold runs continuously ACROSS the embed
    return { doc, body };
  }

  it('a mark straddling an EMBED at the span start, retargeted to stop crossing → DRIFT', () => {
    const { doc, body } = bar();
    // Span [2,5): the START boundary sits ON the embed; the in-span "CD" bold run
    // straddles the start because bold runs continuously across the embed from "AB".
    const reader = new YjsCovenantDocReader(doc, { path: [0, 0], start: 2, end: 5 });
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');
    // Unbold ONLY the out-of-span "AB". The in-span "CD" text + its bold mark are
    // byte-identical and the embed identity is unchanged (bold is not embed identity);
    // ONLY the straddle flag flips start→none. A reader ignoring embed-boundary
    // straddle (the round-2 hole) would render both as 'none' and NOT drift.
    body.format(0, 2, { bold: null });
    expect(status(reader, anchor)).toBe('drift');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Canonical nested-embed child (round-3 MEDIUM). An OBJECT child must be hashed
// key-order-independently, or insertion order false-stales.
// ─────────────────────────────────────────────────────────────────────────────
describe('canonical nested-embed child hash (round-3 MEDIUM)', () => {
  function docWithChild(child: Record<string, unknown>): Y.Doc {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insertEmbed(0, { embedType: 'nestedDoc', child });
    return doc;
  }
  const certifyChild = (child: Record<string, unknown>): CovenantAnchor =>
    certify(new YjsCovenantDocReader(docWithChild(child), { path: [0, 0], start: 0, end: 1 }));

  it('the same object child in a different key order → SAME digest (insertion order is not content)', () => {
    const a = certifyChild({ title: 'Plan', author: 'Alice' });
    const b = certifyChild({ author: 'Alice', title: 'Plan' });
    expect(a.renderedDigest).toBe(b.renderedDigest);
  });

  it('a genuinely different object child → DIFFERENT digest (canonicalization is not blindness)', () => {
    const a = certifyChild({ title: 'Plan', author: 'Alice' });
    const b = certifyChild({ title: 'Plan', author: 'Bob' });
    expect(a.renderedDigest).not.toBe(b.renderedDigest);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVENANCE is not a content-resolution input (round-3 DOCUMENT — not a bug).
// objectId/roomId/certifier/certifiedAt are receipt identity, frozen immutable by
// the ledger (0050/0051). resolveCovenant answers "did the CONTENT drift" and must
// NOT treat them as drift inputs. This test documents that intent so it is not
// re-flagged: changing all four does not move the OK verdict.
// ─────────────────────────────────────────────────────────────────────────────
describe('provenance fields are intentionally NOT drift inputs (round-3 DOCUMENT)', () => {
  it('changing objectId / roomId / certifier / certifiedAt leaves the verdict OK', () => {
    const { doc } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');
    const reprovenanced: CovenantAnchor = {
      ...anchor,
      objectId: 'o_other',
      roomId: 'room_2',
      certifier: { kind: 'human', userId: 'u_bob' },
      certifiedAt: '2099-01-01T00:00:00.000Z',
    };
    // Content is unchanged, so the covenant still holds — provenance is not content.
    expect(status(reader, reprovenanced)).toBe('ok');
  });
});
