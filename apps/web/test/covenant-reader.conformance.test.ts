import { type CovenantAnchor, certifyAnchor, resolveCovenant } from '@atrium/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ConversationDoc } from '@/app/prototype/yjs-conversation';
import {
  CovenantDocReaderProd,
  canonicalizeLeafValue,
  readerForLiveDoc,
} from '@/lib/covenant-reader';
import { NaiveCovenantDocReader } from './support/naive-covenant-reader';

/**
 * THE CONFORMANCE CONTRACT, RE-RUN THROUGH THE PRODUCTION READER (#189 / SL-2).
 *
 * `packages/core/test/covenant-conformance.test.ts` is the contract every reader
 * must satisfy; it drives the reference double. This file drives the PRODUCTION
 * reader (`apps/web/lib/covenant-reader.ts`) through the SAME assertions — every
 * advertised drift class, class B (persisted boundaries), class C (verified
 * snapshot), the flip-the-input wiring, EXACT content, strict snapshot, embed
 * straddle, canonical + NFC nested-child, and provenance-is-not-content — over the
 * real (TipTap / y-prosemirror) `Y.XmlText` op shape.
 *
 * It THEN adds the three routed-hardening not-theater proofs ((a)/(b)/(c)) — each
 * FAILS against a naive `String(obj)` / no-embed-marks / no-deadline reader and
 * PASSES here — and a live-#183-doc binding test (a torn-down `ConversationDoc`
 * handle fails closed to DRIFT).
 *
 * NOTE ON #183's REAL SHAPE (reported to #189): the merged #183 `ConversationDoc`
 * is MESSAGE-LEVEL — a `Y.Array` of JSON messages — with NO sub-message rich-text
 * (`Y.XmlText`) spans; those arrive with co-editing at #184/#185. Per #189's scope
 * boundary ("if the real embed shape is still too thin … build the reader to handle
 * it AND add a synthetic conformance case, and say so"), the conformance docs below
 * are synthetic y-prosemirror docs exercising the production embed shape the reader
 * will meet, and the live-doc binding test uses the real `ConversationDoc` handle.
 */

const ALICE = { kind: 'human', userId: 'u_alice' } as const;
const AT = '2026-08-16T12:00:00.000Z';
const SPAN = { start: 8, end: 21 } as const;
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

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
  body.format(6, 7, { bold: true });
  body.format(19, 4, { highlight: 'yellow' });
  return { doc, body, heading, blockquote };
}

const capturingReader = (doc: Y.Doc): CovenantDocReaderProd =>
  new CovenantDocReaderProd(doc, { path: [0, 0, 0], start: SPAN.start, end: SPAN.end });

function certify(reader: CovenantDocReaderProd): CovenantAnchor {
  const anchor = certifyAnchor(reader, {
    objectId: 'o_span',
    roomId: 'room_1',
    certifier: ALICE,
    certifiedAt: AT,
  });
  if (anchor === null) throw new Error('capture failed');
  return anchor;
}

const status = (reader: CovenantDocReaderProd, anchor: CovenantAnchor) =>
  resolveCovenant(reader, anchor).covenantStatus;

// ═════════════════════════════════════════════════════════════════════════════
// The full conformance suite — ported verbatim to the PRODUCTION reader.
// ═════════════════════════════════════════════════════════════════════════════

describe('PROD reader conformance — the honest production reader over a real Y.Doc', () => {
  it('class 7: byte-identical (no edit) → OK', () => {
    const { doc } = makeDoc();
    const reader = capturingReader(doc);
    expect(status(reader, certify(reader))).toBe('ok');
  });

  it('class 1: a typed character inside the span → DRIFT', () => {
    const { doc, body } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    body.insert(9, 'X');
    expect(status(reader, anchor)).toBe('drift');
  });

  it('class 2a: ancestor heading level changed → DRIFT', () => {
    const { doc, heading } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    heading.setAttribute('level', '3');
    expect(status(reader, anchor)).toBe('drift');
  });
  it('class 2b: an OUTER ancestor (blockquote indent) changed → DRIFT', () => {
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

  it('class 3a: a STRADDLING mark stops straddling → DRIFT', () => {
    const { doc, body } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    body.format(6, 2, { bold: null });
    expect(status(reader, anchor)).toBe('drift');
  });
  it('class 3b: a STRING-VALUED mark payload changed (highlight yellow→red) → DRIFT', () => {
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

  it('class 5: an enclosed embed deleted → DRIFT (identity set + digest)', () => {
    const { doc, body } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    body.delete(16, 1);
    expect(status(reader, anchor)).toBe('drift');
  });

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
    doc.getXmlFragment('doc').delete(0, 1);
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

describe('PROD reader — resolution from persisted boundaries (class B)', () => {
  it('a FRESH reader with no in-memory span state resolves the anchor from the ledger', () => {
    const { doc } = makeDoc();
    const anchor = certify(capturingReader(doc));
    const reload = new CovenantDocReaderProd(doc);
    expect(status(reload, anchor)).toBe('ok');
  });
  it('after reload, an edit inside the span → DRIFT (the persisted positions are live)', () => {
    const { doc, body } = makeDoc();
    const anchor = certify(capturingReader(doc));
    const reload = new CovenantDocReaderProd(doc);
    body.insert(9, 'Z');
    expect(status(reload, anchor)).toBe('drift');
  });
  it('empty-span-sibling: typing into the ORIGINAL after a sibling inserted at 0 → DRIFT', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', '2');
    const body = new Y.XmlText();
    frag.insert(0, [heading]);
    heading.insert(0, [body]);
    const anchor = certify(new CovenantDocReaderProd(doc, { path: [0, 0], start: 0, end: 0 }));
    expect(status(new CovenantDocReaderProd(doc), anchor)).toBe('ok');

    const sibling = new Y.XmlElement('heading');
    sibling.setAttribute('level', '2');
    sibling.insert(0, [new Y.XmlText()]);
    frag.insert(0, [sibling]);

    body.insert(0, 'snuck in');
    expect(status(new CovenantDocReaderProd(doc), anchor)).toBe('drift');
  });
});

describe('PROD reader — snapshot verified against the live doc (class C)', () => {
  it('a forged revision (999) → DRIFT', () => {
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
    const forged = Buffer.from(JSON.stringify({ '99999': [[0, 5]] })).toString('base64');
    expect(status(reader, { ...anchor, deleteSet: forged })).toBe('drift');
  });
});

describe('PROD reader — flip-the-input: every anchor field is wired', () => {
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

describe('PROD reader — EXACT content, no prose fold (round-3 CRITICAL)', () => {
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
  it('delete the space between a mention and an image → DRIFT (collide-embeds attack)', () => {
    const { doc, body } = embedSpaceEmbed();
    const reader = new CovenantDocReaderProd(doc, { path: [0, 0], start: 0, end: 3 });
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');
    body.delete(1, 1);
    expect(status(reader, anchor)).toBe('drift');
  });
  it('a double space inside the span → DRIFT (whitespace runs not collapsed)', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insert(0, 'ship it');
    const reader = new CovenantDocReaderProd(doc, { path: [0, 0], start: 0, end: 7 });
    const anchor = certify(reader);
    body.insert(4, ' ');
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
    const reader = new CovenantDocReaderProd(doc, { path: [0, 0], start: 0, end: 1 });
    const anchor = certify(reader);
    body.delete(0, 1);
    body.insertEmbed(0, { embedType: 'mention', target: 'u_ali​ce', label: 'Alice' });
    expect(status(reader, anchor)).toBe('drift');
  });
});

describe('PROD reader — strict snapshot verification (round-3 HIGH)', () => {
  it('a ZEROED revision + EMPTIED state vector → DRIFT', () => {
    const { doc } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    const emptySV = b64(Y.encodeStateVector(new Y.Doc()));
    expect(status(reader, { ...anchor, revision: 0, stateVector: emptySV })).toBe('drift');
  });
  it('a non-empty captured deleteSet REPLACED BY EMPTY → DRIFT', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insert(0, 'shipXit');
    body.delete(4, 1);
    const reader = new CovenantDocReaderProd(doc, { path: [0, 0], start: 0, end: 6 });
    const anchor = certify(reader);
    const capturedDS = JSON.parse(Buffer.from(anchor.deleteSet, 'base64').toString('utf8'));
    expect(Object.keys(capturedDS).length).toBeGreaterThan(0);
    expect(status(reader, anchor)).toBe('ok');
    const emptied = Buffer.from(JSON.stringify({})).toString('base64');
    expect(status(reader, { ...anchor, deleteSet: emptied })).toBe('drift');
  });
});

describe('PROD reader — embed-boundary straddle (round-3 MEDIUM)', () => {
  function bar(): { doc: Y.Doc; body: Y.XmlText } {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insert(0, 'AB');
    body.insertEmbed(2, { embedType: 'tag', id: 't1' });
    body.insert(3, 'CD');
    body.format(0, 5, { bold: true });
    return { doc, body };
  }
  it('a mark straddling an EMBED at the span start, retargeted to stop crossing → DRIFT', () => {
    const { doc, body } = bar();
    const reader = new CovenantDocReaderProd(doc, { path: [0, 0], start: 2, end: 5 });
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');
    body.format(0, 2, { bold: null });
    expect(status(reader, anchor)).toBe('drift');
  });
});

describe('PROD reader — canonical + NFC nested-embed child', () => {
  function docWithChild(child: unknown): Y.Doc {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insertEmbed(0, { embedType: 'nestedDoc', child });
    return doc;
  }
  const certifyChild = (child: unknown): CovenantAnchor =>
    certify(new CovenantDocReaderProd(docWithChild(child), { path: [0, 0], start: 0, end: 1 }));

  it('the same object child in a different key order → SAME digest', () => {
    expect(certifyChild({ title: 'Plan', author: 'Alice' }).renderedDigest).toBe(
      certifyChild({ author: 'Alice', title: 'Plan' }).renderedDigest,
    );
  });
  it('a genuinely different object child → DIFFERENT digest', () => {
    expect(certifyChild({ title: 'Plan', author: 'Alice' }).renderedDigest).not.toBe(
      certifyChild({ title: 'Plan', author: 'Bob' }).renderedDigest,
    );
  });
  it('a STRING child composed vs decomposed → SAME digest (NFC)', () => {
    expect(certifyChild('café').renderedDigest).toBe(certifyChild('café').renderedDigest);
  });
  it('an OBJECT child with a composed vs decomposed string leaf → SAME digest', () => {
    expect(certifyChild({ title: 'café' }).renderedDigest).toBe(
      certifyChild({ title: 'café' }).renderedDigest,
    );
  });
  it('a genuinely different child leaf still → DIFFERENT digest', () => {
    expect(certifyChild({ title: 'café' }).renderedDigest).not.toBe(
      certifyChild({ title: 'latte' }).renderedDigest,
    );
  });
});

describe('PROD reader — provenance fields are intentionally NOT drift inputs', () => {
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
    expect(status(reader, reprovenanced)).toBe('ok');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// THE THREE ROUTED HARDENINGS — not-theater proofs (naive FAILS, production PASSES).
// ═════════════════════════════════════════════════════════════════════════════

/** A mention embed carrying a NESTED, non-`child` OBJECT field (`meta`). */
function docWithNestedObjectEmbed(meta: Record<string, unknown>): Y.Doc {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('doc');
  const para = new Y.XmlElement('paragraph');
  const body = new Y.XmlText();
  frag.insert(0, [para]);
  para.insert(0, [body]);
  // `meta` is a nested object — the production embed shape (a TipTap image/figure
  // node's `attrs`). `child` is deliberately NOT used, so this exercises the
  // NON-child structural path (a), not the child-digest path.
  body.insertEmbed(0, { embedType: 'image', src: 'https://x/a.png', meta });
  return doc;
}

describe('HARDENING (a): structural canonicalization of deep embed fields — NEVER String(obj)', () => {
  const sel = { path: [0, 0], start: 0, end: 1 };
  const prodDigest = (meta: Record<string, unknown>) =>
    certify(new CovenantDocReaderProd(docWithNestedObjectEmbed(meta), sel)).renderedDigest;
  const naiveDigest = (meta: Record<string, unknown>) =>
    certify(new NaiveCovenantDocReader(docWithNestedObjectEmbed(meta), sel)).renderedDigest;

  const metaA = { width: 640, height: 480 };
  const metaB = { width: 1920, height: 1080 };

  it('PRODUCTION: two distinct nested-object embeds digest DIFFERENTLY (no collision)', () => {
    expect(prodDigest(metaA)).not.toBe(prodDigest(metaB));
  });
  it('NAIVE theater: String(obj) collapses both to "[object Object]" → SAME digest (false ✓)', () => {
    // The exact hole: distinct nested objects collide, so a mutation of the field
    // would resolve `ok`. The production assertion above is what closes it.
    expect(naiveDigest(metaA)).toBe(naiveDigest(metaB));
  });
  it('PRODUCTION: the same nested object in a different key order → SAME digest (canonical)', () => {
    expect(prodDigest({ width: 640, height: 480 })).toBe(prodDigest({ height: 480, width: 640 }));
  });
  it('PRODUCTION: type is content — nested { v: 1 } (number) vs { v: "1" } (string) DIFFER', () => {
    expect(prodDigest({ v: 1 })).not.toBe(prodDigest({ v: '1' }));
  });
  it('PRODUCTION end-to-end: mutating a nested-object embed field → DRIFT', () => {
    const doc = docWithNestedObjectEmbed(metaA);
    const reader = new CovenantDocReaderProd(doc, sel);
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');
    const para = doc.getXmlFragment('doc').get(0) as Y.XmlElement;
    const body = para.get(0) as Y.XmlText;
    body.delete(0, 1);
    body.insertEmbed(0, { embedType: 'image', src: 'https://x/a.png', meta: metaB });
    expect(status(reader, anchor)).toBe('drift');
  });
});

describe('HARDENING (b): an embed format() mutation reaches the digest → DRIFT', () => {
  // Asserted on the DIGEST directly (as the core round-4 suite does) to ISOLATE the
  // embed-mark axis: an end-to-end format() also adds items into the span (the
  // snapshot-coverage axis), which would drift on BOTH readers and mask the gap.
  it('PRODUCTION: a LINK on a certified IMAGE embed moves the digest', () => {
    const plain = certify(capturingReader(makeDoc().doc)).renderedDigest;
    const linked = (() => {
      const { doc, body } = makeDoc();
      body.format(16, 1, { link: { href: 'https://evil.example' } });
      return certify(capturingReader(doc)).renderedDigest;
    })();
    expect(linked).not.toBe(plain);
  });
  it('NAIVE theater: embed marks dropped → the link does NOT move the digest (false ✓)', () => {
    const plain = certify(
      new NaiveCovenantDocReader(makeDoc().doc, { path: [0, 0, 0], start: 8, end: 21 }),
    ).renderedDigest;
    const linked = (() => {
      const { doc, body } = makeDoc();
      body.format(16, 1, { link: { href: 'https://evil.example' } });
      return certify(new NaiveCovenantDocReader(doc, { path: [0, 0, 0], start: 8, end: 21 }))
        .renderedDigest;
    })();
    expect(linked).toBe(plain);
  });
  it('PRODUCTION: a HIGHLIGHT on a certified MENTION chip moves the digest', () => {
    const plain = certify(capturingReader(makeDoc().doc)).renderedDigest;
    const lit = (() => {
      const { doc, body } = makeDoc();
      body.format(14, 1, { highlight: 'red' });
      return certify(capturingReader(doc)).renderedDigest;
    })();
    expect(lit).not.toBe(plain);
  });
  it('PRODUCTION end-to-end: retargeting a straddling mark off an embed-only span → DRIFT', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insert(0, 'X');
    body.insertEmbed(1, { embedType: 'mention', target: 'u_alice' });
    body.insert(2, 'Y');
    body.format(0, 3, { bold: true });
    const reader = new CovenantDocReaderProd(doc, { path: [0, 0], start: 1, end: 2 });
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');
    body.format(0, 1, { bold: null });
    body.format(2, 1, { bold: null });
    expect(status(reader, anchor)).toBe('drift');
  });
});

describe('HARDENING (c): a genuinely async, cancellable, monotonic deadline → DRIFT, never a late ok', () => {
  /** A source that NEVER becomes ready (a permanently-catching-up / dropped stream). */
  const neverReady = (): { poll(): Y.Doc | null } => ({ poll: () => null });

  /** A source that becomes ready only after `ms` (a slow, eventually-caught-up stream). */
  function readyAfter(ms: number, doc: Y.Doc): { poll(): Y.Doc | null } {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, ms);
    return { poll: () => (ready ? doc : null) };
  }

  it('SYNC fail-closed: a never-ready source → resolveCovenant DRIFT, promptly, no busy-spin', () => {
    const anchor = certify(capturingReader(makeDoc().doc));
    const reader = new CovenantDocReaderProd(neverReady(), undefined, { deadlineMs: 20 });
    const t0 = Date.now();
    expect(reader.resolveSpan(anchor)).toBeNull();
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('drift');
    expect(Date.now() - t0).toBeLessThan(200); // single poll — no hang, no spin
  });

  it('PRODUCTION async: a NEVER-ready source → resolveSpanAsync null (⇒ DRIFT) at the deadline', async () => {
    const anchor = certify(capturingReader(makeDoc().doc));
    const reader = new CovenantDocReaderProd(neverReady(), undefined, { deadlineMs: 30 });
    const t0 = Date.now();
    expect(await reader.resolveSpanAsync(anchor)).toBeNull();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(25); // it actually waited the deadline
    expect(elapsed).toBeLessThan(1500); // and returned promptly (no hang)
  });

  it('PRODUCTION async: a SLOW-eventually-ready source PAST the deadline → null, NEVER a late ok', async () => {
    const { doc } = makeDoc();
    const anchor = certify(capturingReader(doc));
    // Ready at ~120ms, deadline 25ms ⇒ the doc arrives well AFTER the deadline.
    const reader = new CovenantDocReaderProd(readyAfter(120, doc), undefined, { deadlineMs: 25 });
    const res = await reader.resolveSpanAsync(anchor);
    expect(res).toBeNull(); // the late doc is refused — no late ok
  });

  it('PRODUCTION async: a source ready WITHIN the deadline → resolves (proves the loop yields the event loop)', async () => {
    // A busy-spin could never let the setTimeout that flips readiness fire, so the
    // source would never become ready and this would hang: passing PROVES non-blocking.
    const { doc } = makeDoc();
    const reader0 = capturingReader(doc);
    const anchor = certify(reader0);
    const reader = new CovenantDocReaderProd(
      readyAfter(10, doc),
      { path: [0, 0, 0], ...SPAN },
      {
        deadlineMs: 1000,
      },
    );
    const res = await reader.resolveSpanAsync(anchor);
    expect(res).not.toBeNull();
    expect(res?.snapshotVerified).toBe(true); // became ready in time → would resolve ok
  });

  it('PRODUCTION async: an aborted signal → null at once (cancellable)', async () => {
    const anchor = certify(capturingReader(makeDoc().doc));
    const reader = new CovenantDocReaderProd(neverReady(), undefined, { deadlineMs: 5000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 15);
    const t0 = Date.now();
    expect(await reader.resolveSpanAsync(anchor, ac.signal)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000); // cancelled long before the 5s deadline
  });

  it('PRODUCTION async: authoritativeContext/captureSelection on a stalled source → null (no ✓ signed)', async () => {
    const reader = new CovenantDocReaderProd(
      neverReady(),
      { path: [0, 0], start: 0, end: 1 },
      {
        deadlineMs: 20,
      },
    );
    expect(await reader.authoritativeContextAsync()).toBeNull();
    expect(await reader.captureSelectionAsync()).toBeNull();
  });

  it('NAIVE theater: no deadline → a slow-past-deadline source yields a LATE ok (the hole)', async () => {
    // The foil: with deadlineEnabled=false the naive reader waits indefinitely and
    // accepts the doc that arrives AFTER the deadline — exactly the late ok the
    // production deadline refuses above. Same source, opposite outcome ⇒ load-bearing.
    const { doc } = makeDoc();
    const reader0 = capturingReader(doc);
    const anchor = certify(reader0);
    const naive = new NaiveCovenantDocReader(
      readyAfter(40, doc),
      { path: [0, 0, 0], ...SPAN },
      {
        deadlineMs: 10, // ignored — deadlineEnabled is false
      },
    );
    const res = await naive.resolveSpanAsync(anchor);
    expect(res).not.toBeNull(); // accepted the LATE doc — the production reader returned null
    expect(res?.snapshotVerified).toBe(true);
  });

  it('NAIVE theater: no deadline → a never-ready source NEVER self-terminates (loses the race to a timer)', async () => {
    const anchor = certify(capturingReader(makeDoc().doc));
    const naive = new NaiveCovenantDocReader(neverReady(), undefined, { deadlineMs: 10 });
    const settled = naive.resolveSpanAsync(anchor).then(() => 'settled' as const);
    const timedOut = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 100));
    // If the deadline were honored it would settle; without one, the timer wins.
    expect(await Promise.race([settled, timedOut])).toBe('timeout');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// INJECTIVITY (#189 CRITICAL) — distinct content ⇒ DISTINCT digest, no false ✓.
// Each collision the gauntlet named is closed: the digest MOVES for it on the
// production reader, where the base (String(obj) / docDigest-shadow / untyped)
// reader collapsed two distinct contents onto one.
// ═════════════════════════════════════════════════════════════════════════════

describe('INJECTIVITY: the leaf encoder is injective across the gauntlet collisions', () => {
  const enc = canonicalizeLeafValue;
  it('scalar "x" ≠ object { value: "x" }', () => {
    expect(enc('x')).not.toBe(enc({ value: 'x' }));
  });
  it('null ≠ NaN ≠ Infinity (a bare JSON.stringify folds all three toward "null")', () => {
    expect(new Set([enc(null), enc(Number.NaN), enc(Number.POSITIVE_INFINITY)]).size).toBe(3);
    expect(enc(Number.NEGATIVE_INFINITY)).not.toBe(enc(Number.POSITIVE_INFINITY));
  });
  it('bigint 1n ≠ the string "bigint:1"', () => {
    expect(enc(1n)).not.toBe(enc('bigint:1'));
  });
  it('number 1 ≠ string "1" (type is content)', () => {
    expect(enc(1)).not.toBe(enc('1'));
  });
  it('Date / Map / Set do NOT collapse to {} (nor to each other)', () => {
    const shapes = [enc(new Date(0)), enc(new Map([['a', 1]])), enc(new Set([1])), enc({})];
    expect(new Set(shapes).size).toBe(4);
    expect(enc(new Date(0))).not.toBe(enc(new Date(1)));
    expect(enc(new Map([['a', 1]]))).not.toBe(enc(new Map([['a', 2]])));
    expect(enc(new Set([1]))).not.toBe(enc(new Set([2])));
  });
  it('keys are NFC-normalized BEFORE sorting (composed vs decomposed key → SAME encoding)', () => {
    // 'café' composed (U+00E9) vs decomposed (e + U+0301) as a KEY must fold.
    expect(enc({ café: 1 })).toBe(enc({ café: 1 }));
  });
  it('an unsupported value (function) FAILS CLOSED — throws, never a shared token', () => {
    expect(() => enc(() => 0)).toThrow(/unsupported leaf value/);
    expect(() => enc(Symbol('x'))).toThrow(/unsupported leaf value/);
  });
});

describe('INJECTIVITY: distinct content digests distinctly through the production reader', () => {
  const sel = { path: [0, 0], start: 0, end: 1 };

  /** An embed carrying an arbitrary extra field, certified through the production reader. */
  function certifyEmbed(embed: Record<string, unknown>): CovenantAnchor {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insertEmbed(0, embed);
    return certify(new CovenantDocReaderProd(doc, sel));
  }

  it('an ancestor object attribute { meta:{v:1} } vs { meta:{v:2} } → DIFFERENT digest (the :335 String collision)', () => {
    const withMeta = (v: number): CovenantAnchor => {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment('doc');
      const para = new Y.XmlElement('paragraph');
      // y-prosemirror stores a node's attrs as an object attribute — the shape the
      // base reader collapsed with String(v).
      para.setAttribute('meta', { v } as unknown as string);
      const body = new Y.XmlText();
      frag.insert(0, [para]);
      para.insert(0, [body]);
      body.insert(0, 'x');
      return certify(new CovenantDocReaderProd(doc, { path: [0, 0], start: 0, end: 1 }));
    };
    expect(withMeta(1).renderedDigest).not.toBe(withMeta(2).renderedDigest);
  });

  it("grok's headline: a sibling `docDigest` field can NEVER shadow the real child digest", () => {
    // Two embeds with the SAME caller-supplied `docDigest` sibling but DIFFERENT
    // child content. `docDigest` is placed AFTER `child` so the base reader's loop
    // sets the real child digest and then OVERWRITES it with String(docDigest) —
    // dropping the child → SAME digest (innocent→EVIL stayed ok). Namespaced now.
    const innocent = certifyEmbed({ embedType: 'nestedDoc', child: 'innocent', docDigest: 'X' });
    const evil = certifyEmbed({ embedType: 'nestedDoc', child: 'EVIL', docDigest: 'X' });
    expect(innocent.renderedDigest).not.toBe(evil.renderedDigest);
  });

  it("grok's headline, end-to-end: mutating the child under a fixed `docDigest` sibling → DRIFT", () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insertEmbed(0, { embedType: 'nestedDoc', child: 'innocent', docDigest: 'X' });
    const reader = new CovenantDocReaderProd(doc, sel);
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');
    body.delete(0, 1);
    body.insertEmbed(0, { embedType: 'nestedDoc', child: 'EVIL', docDigest: 'X' });
    expect(status(reader, anchor)).toBe('drift');
  });

  it('a scalar mark "x" and an object mark { value:"x" } digest DIFFERENTLY', () => {
    // Build two docs whose only difference is a scalar vs object mark on the embed.
    const mk = (markValue: unknown): CovenantAnchor => {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment('doc');
      const para = new Y.XmlElement('paragraph');
      const body = new Y.XmlText();
      frag.insert(0, [para]);
      para.insert(0, [body]);
      body.insertEmbed(0, { embedType: 'image', src: 'a' });
      body.format(0, 1, { note: markValue } as Record<string, unknown>);
      return certify(new CovenantDocReaderProd(doc, sel));
    };
    expect(mk('x').renderedDigest).not.toBe(mk({ value: 'x' }).renderedDigest);
  });

  it('an in-place mutation moves the DIGEST itself (not only the enclosed-item identity — the masking codex found)', () => {
    // A text edit inside the span (no embed touched, so enclosed-item identity is
    // unchanged) must still move the digest — proving the digest, not merely the
    // identity set, is doing the detecting.
    const digestOf = (mutate?: (b: Y.XmlText) => void): string => {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment('doc');
      const para = new Y.XmlElement('paragraph');
      const body = new Y.XmlText();
      frag.insert(0, [para]);
      para.insert(0, [body]);
      body.insert(0, 'ship it');
      mutate?.(body);
      return certify(new CovenantDocReaderProd(doc, { path: [0, 0], start: 0, end: body.length }))
        .renderedDigest;
    };
    expect(digestOf()).not.toBe(digestOf((b) => b.insert(4, 'X')));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LIVE #183 BINDING — the reader over the real ConversationDoc handle, fail-closed
// when the handle tears down. (The certified span lives in a Y.XmlText body on the
// same doc; #183's message-level Y.Array grows rich-text spans at #184/#185.)
// ═════════════════════════════════════════════════════════════════════════════

describe('live #183 ConversationDoc binding — watches the CORRECT content share', () => {
  // The conversation's rich-text bodies (#194) live under a NAMED content share,
  // NOT a planted `getXmlFragment('doc')`. The base reader hardcoded 'doc' and so
  // could never see a mutation to the real content (the #189 MEDIUM). The binding
  // now resolves against the caller-provided share; these prove it (a) sees a
  // content mutation there and (b) fails closed when that share is absent.
  const CONTENT_SHARE = 'conversation-body';
  const contentRoot = (doc: Y.Doc): Y.XmlFragment | null => {
    const f = doc.getXmlFragment(CONTENT_SHARE);
    return f.length > 0 ? f : null; // absent / empty content ⇒ fail closed
  };

  /** Seat a rich-text body under the conversation's real content share. */
  function seatBody(convo: ConversationDoc): Y.XmlText {
    const frag = convo.doc.getXmlFragment(CONTENT_SHARE);
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insert(0, 'ship it');
    return body;
  }

  it('a CONTENT mutation in the bound share is SEEN → DRIFT (the base plant ignored it)', () => {
    const convo = new ConversationDoc();
    const body = seatBody(convo);
    const provider = () => (convo.isDestroyed() ? null : convo.doc);
    const reader = readerForLiveDoc(
      provider,
      { path: [0, 0], start: 0, end: 7 },
      {
        resolveRoot: contentRoot,
      },
    );
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');
    // Edit the real conversation content — the reader watches THIS share, so it drifts.
    body.insert(4, 'X');
    expect(status(reader, anchor)).toBe('drift');
  });

  it('span precision: an UNRELATED deletion elsewhere in the body does NOT de-certify it', () => {
    const convo = new ConversationDoc();
    const frag = convo.doc.getXmlFragment(CONTENT_SHARE);
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insert(0, 'ship it ZZZ'); // span [0,7)='ship it'; index 7=' ' (gap); 8-10='ZZZ'
    const provider = () => (convo.isDestroyed() ? null : convo.doc);
    const reader = readerForLiveDoc(
      provider,
      { path: [0, 0], start: 0, end: 7 },
      {
        resolveRoot: contentRoot,
      },
    );
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');
    body.delete(8, 3); // delete 'ZZZ' at offset 8 (> end 7, with the space at 7 as a gap)
    expect(status(reader, anchor)).toBe('ok');
  });

  it('a torn-down ConversationDoc → DRIFT (stream gone), fragment null', () => {
    const convo = new ConversationDoc();
    seatBody(convo);
    const provider = () => (convo.isDestroyed() ? null : convo.doc);
    const reader = readerForLiveDoc(
      provider,
      { path: [0, 0], start: 0, end: 7 },
      {
        resolveRoot: contentRoot,
      },
    );
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');

    convo.destroy();
    const res = resolveCovenant(reader, anchor);
    expect(res.covenantStatus).toBe('drift');
    expect(res.renderedFragment).toBeNull();
  });

  it('the content share is ABSENT → capture fails closed (no anchor minted over an empty plant)', () => {
    const convo = new ConversationDoc(); // no body seated under CONTENT_SHARE
    const provider = () => (convo.isDestroyed() ? null : convo.doc);
    const reader = readerForLiveDoc(
      provider,
      { path: [0, 0], start: 0, end: 7 },
      {
        resolveRoot: contentRoot,
      },
    );
    expect(reader.captureSelection()).toBeNull();
    expect(
      certifyAnchor(reader, { objectId: 'o', roomId: 'r', certifier: ALICE, certifiedAt: AT }),
    ).toBeNull();
  });
});
