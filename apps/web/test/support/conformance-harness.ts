import {
  type CovenantAnchor,
  type CovenantDocReader,
  certifyAnchor,
  resolveCovenant,
} from '@atrium/core';
import { expect, it } from 'vitest';
import * as Y from 'yjs';

/**
 * THE SHARED, READER-PARAMETERIZED CONFORMANCE HARNESS (#189 fix — coverage
 * cannot diverge).
 *
 * The #189 gauntlet found the PRODUCTION conformance omitted three controls the
 * REFERENCE-double conformance carried (off-boundary SV redistribution, boundary
 * tombstone, unrelated-deletion) — so the two suites' coverage had drifted. This
 * module is the single definition of the reader contract: it registers the
 * IDENTICAL assertions and is run against BOTH the reference double and the
 * production reader (see `covenant-shared-conformance.test.ts`). Adding a class
 * here adds it to both; neither can silently under-cover the other again.
 *
 * A `ReaderFactory` builds a reader over a live `Y.Doc` with an optional capturing
 * selection — the one seam the two readers share. Everything meaning-bearing (the
 * digest, the OK/DRIFT verdict) is `@atrium/core`'s and identical for both.
 */
export type HarnessSelection = { path: number[]; start: number; end: number };
export type HarnessReader = CovenantDocReader & { makeUnavailable(): void };
export type ReaderFactory = (doc: Y.Doc, selection?: HarnessSelection) => HarnessReader;

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

/**
 * Register the full reader conformance contract against `make`. Called once per
 * reader (production + reference double) so the coverage is provably identical.
 */
export function runReaderConformance(label: string, make: ReaderFactory): void {
  const capturing = (
    doc: Y.Doc,
    sel: HarnessSelection = { path: [0, 0, 0], ...SPAN },
  ): HarnessReader => make(doc, sel);

  const certify = (reader: HarnessReader): CovenantAnchor => {
    const anchor = certifyAnchor(reader, {
      objectId: 'o_span',
      roomId: 'room_1',
      certifier: ALICE,
      certifiedAt: AT,
    });
    if (anchor === null) throw new Error('capture failed');
    return anchor;
  };
  const status = (reader: HarnessReader, anchor: CovenantAnchor) =>
    resolveCovenant(reader, anchor).covenantStatus;

  const L = (name: string) => `[${label}] ${name}`;

  // ── the advertised drift classes ───────────────────────────────────────────
  it(L('class 7: byte-identical (no edit) → OK'), () => {
    const { doc } = makeDoc();
    const reader = capturing(doc);
    expect(status(reader, certify(reader))).toBe('ok');
  });
  it(L('class 1: a typed character inside the span → DRIFT'), () => {
    const { doc, body } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    body.insert(9, 'X');
    expect(status(reader, anchor)).toBe('drift');
  });
  it(L('class 2a: ancestor heading level changed → DRIFT'), () => {
    const { doc, heading } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    heading.setAttribute('level', '3');
    expect(status(reader, anchor)).toBe('drift');
  });
  it(L('class 2b: an OUTER ancestor (blockquote indent) changed → DRIFT'), () => {
    const { doc, blockquote } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    blockquote.setAttribute('indent', '2');
    expect(status(reader, anchor)).toBe('drift');
  });
  it(L('class 2c: an ancestor align changed → DRIFT'), () => {
    const { doc, blockquote } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    blockquote.setAttribute('align', 'center');
    expect(status(reader, anchor)).toBe('drift');
  });
  it(L('class 3a: a STRADDLING mark stops straddling → DRIFT'), () => {
    const { doc, body } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    body.format(6, 2, { bold: null });
    expect(status(reader, anchor)).toBe('drift');
  });
  it(L('class 3b: a STRING-VALUED mark payload changed (yellow→red) → DRIFT'), () => {
    const { doc, body } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    body.format(19, 4, { highlight: 'red' });
    expect(status(reader, anchor)).toBe('drift');
  });
  it(L('class 4a: a mention target re-pointed → DRIFT'), () => {
    const { doc, body } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    body.delete(14, 1);
    body.insertEmbed(14, { embedType: 'mention', target: 'u_bob', label: 'Alice' });
    expect(status(reader, anchor)).toBe('drift');
  });
  it(L('class 4b: a mention LABEL changed, same target → DRIFT'), () => {
    const { doc, body } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    body.delete(14, 1);
    body.insertEmbed(14, { embedType: 'mention', target: 'u_alice', label: 'Alicia' });
    expect(status(reader, anchor)).toBe('drift');
  });
  it(L('class 4c: an image src swapped → DRIFT'), () => {
    const { doc, body } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    body.delete(16, 1);
    body.insertEmbed(16, { embedType: 'image', src: 'https://x/b.png' });
    expect(status(reader, anchor)).toBe('drift');
  });
  it(L('class 4d: a nested-doc CHILD content edit → DRIFT'), () => {
    const { doc, body } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    body.delete(18, 1);
    body.insertEmbed(18, { embedType: 'nestedDoc', child: 'CHANGED nested body' });
    expect(status(reader, anchor)).toBe('drift');
  });
  it(L('class 5: an enclosed embed deleted → DRIFT'), () => {
    const { doc, body } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    body.delete(16, 1);
    expect(status(reader, anchor)).toBe('drift');
  });
  it(L('class 6a: the doc became unavailable → DRIFT, fragment null'), () => {
    const { doc } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    reader.makeUnavailable();
    const res = resolveCovenant(reader, anchor);
    expect(res.covenantStatus).toBe('drift');
    expect(res.renderedFragment).toBeNull();
  });
  it(L('class 6b: the whole span deleted + GC → DRIFT, fragment null'), () => {
    const { doc } = makeDoc();
    doc.gc = true;
    const reader = capturing(doc);
    const anchor = certify(reader);
    doc.getXmlFragment('doc').delete(0, 1);
    const res = resolveCovenant(reader, anchor);
    expect(res.covenantStatus).toBe('drift');
    expect(res.renderedFragment).toBeNull();
  });
  it(L('a revert to the certified content resolves OK again'), () => {
    const { doc, body } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    body.insert(9, 'X');
    expect(status(reader, anchor)).toBe('drift');
    body.delete(9, 1);
    expect(status(reader, anchor)).toBe('ok');
  });

  // ── class B: resolution from persisted boundaries ────────────────────────────
  it(L('class B: a FRESH reader with no span state resolves from the ledger'), () => {
    const { doc } = makeDoc();
    const anchor = certify(capturing(doc));
    expect(status(make(doc), anchor)).toBe('ok');
  });
  it(L('class B: after reload, an edit inside the span → DRIFT'), () => {
    const { doc, body } = makeDoc();
    const anchor = certify(capturing(doc));
    const reload = make(doc);
    body.insert(9, 'Z');
    expect(status(reload, anchor)).toBe('drift');
  });
  it(
    L('class B: empty-span-sibling — typing into the ORIGINAL after a sibling at 0 → DRIFT'),
    () => {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment('doc');
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', '2');
      const body = new Y.XmlText();
      frag.insert(0, [heading]);
      heading.insert(0, [body]);
      const anchor = certify(make(doc, { path: [0, 0], start: 0, end: 0 }));
      expect(status(make(doc), anchor)).toBe('ok');

      const sibling = new Y.XmlElement('heading');
      sibling.setAttribute('level', '2');
      sibling.insert(0, [new Y.XmlText()]);
      frag.insert(0, [sibling]);
      body.insert(0, 'snuck in');
      expect(status(make(doc), anchor)).toBe('drift');
    },
  );

  // ── class C: snapshot verified against the live doc ──────────────────────────
  it(L('class C: a forged revision (999) → DRIFT'), () => {
    const { doc } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    expect(status(reader, { ...anchor, revision: 999 })).toBe('drift');
  });
  it(L('class C: a forged state vector → DRIFT'), () => {
    const { doc } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    expect(status(reader, { ...anchor, stateVector: 'forged' })).toBe('drift');
  });
  it(L('class C: a forged delete set → DRIFT'), () => {
    const { doc } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    const forged = Buffer.from(JSON.stringify({ '99999': [[0, 5]] })).toString('base64');
    expect(status(reader, { ...anchor, deleteSet: forged })).toBe('drift');
  });

  // ── flip-the-input: every anchor field is wired ─────────────────────────────
  const fresh = () => {
    const { doc } = makeDoc();
    const reader = capturing(doc);
    return { reader, anchor: certify(reader) };
  };
  it(L('flip: revision'), () => {
    const { reader, anchor } = fresh();
    expect(status(reader, { ...anchor, revision: anchor.revision + 500 })).toBe('drift');
  });
  it(L('flip: stateVector'), () => {
    const { reader, anchor } = fresh();
    expect(status(reader, { ...anchor, stateVector: 'AAAAAAAA' })).toBe('drift');
  });
  it(L('flip: deleteSet'), () => {
    const { reader, anchor } = fresh();
    const forged = Buffer.from(JSON.stringify({ '4242': [[0, 3]] })).toString('base64');
    expect(status(reader, { ...anchor, deleteSet: forged })).toBe('drift');
  });
  it(L('flip: relStart'), () => {
    const { reader, anchor } = fresh();
    expect(status(reader, { ...anchor, relStart: '!!!not-base64!!!' })).toBe('drift');
  });
  it(L('flip: relEnd'), () => {
    const { reader, anchor } = fresh();
    expect(status(reader, { ...anchor, relEnd: anchor.relStart })).toBe('drift');
  });
  it(L('flip: enclosedItems (a ghost item)'), () => {
    const { reader, anchor } = fresh();
    expect(
      status(reader, {
        ...anchor,
        enclosedItems: [...anchor.enclosedItems, { id: '9:9', kind: 'text' }],
      }),
    ).toBe('drift');
  });
  it(L('flip: renderedDigest'), () => {
    const { reader, anchor } = fresh();
    expect(status(reader, { ...anchor, renderedDigest: 'f'.repeat(64) })).toBe('drift');
  });

  // ── EXACT content, no prose fold ────────────────────────────────────────────
  it(L('EXACT: delete the space between a mention and an image → DRIFT'), () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insertEmbed(0, { embedType: 'mention', target: 'u_alice', label: 'Alice' });
    body.insert(1, ' ');
    body.insertEmbed(2, { embedType: 'image', src: 'https://x/a.png' });
    const reader = make(doc, { path: [0, 0], start: 0, end: 3 });
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');
    body.delete(1, 1);
    expect(status(reader, anchor)).toBe('drift');
  });
  it(L('EXACT: a double space inside the span → DRIFT'), () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insert(0, 'ship it');
    const reader = make(doc, { path: [0, 0], start: 0, end: 7 });
    const anchor = certify(reader);
    body.insert(4, ' ');
    expect(status(reader, anchor)).toBe('drift');
  });
  it(L('EXACT: inject a zero-width space into a mention target → DRIFT'), () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insertEmbed(0, { embedType: 'mention', target: 'u_alice', label: 'Alice' });
    const reader = make(doc, { path: [0, 0], start: 0, end: 1 });
    const anchor = certify(reader);
    body.delete(0, 1);
    body.insertEmbed(0, { embedType: 'mention', target: 'u_ali​ce', label: 'Alice' });
    expect(status(reader, anchor)).toBe('drift');
  });

  // ── strict snapshot verification ────────────────────────────────────────────
  it(L('strict: a ZEROED revision + EMPTIED state vector → DRIFT'), () => {
    const { doc } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    const emptySV = b64(Y.encodeStateVector(new Y.Doc()));
    expect(status(reader, { ...anchor, revision: 0, stateVector: emptySV })).toBe('drift');
  });
  it(L('strict: a non-empty captured deleteSet REPLACED BY EMPTY → DRIFT'), () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insert(0, 'shipXit');
    body.delete(4, 1);
    const reader = make(doc, { path: [0, 0], start: 0, end: 6 });
    const anchor = certify(reader);
    const capturedDS = JSON.parse(Buffer.from(anchor.deleteSet, 'base64').toString('utf8'));
    expect(Object.keys(capturedDS).length).toBeGreaterThan(0);
    expect(status(reader, anchor)).toBe('ok');
    const emptied = Buffer.from(JSON.stringify({})).toString('base64');
    expect(status(reader, { ...anchor, deleteSet: emptied })).toBe('drift');
  });

  // ── embed-boundary straddle ─────────────────────────────────────────────────
  it(L('straddle: a mark straddling an EMBED at the span start, retargeted → DRIFT'), () => {
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
    const reader = make(doc, { path: [0, 0], start: 2, end: 5 });
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');
    body.format(0, 2, { bold: null });
    expect(status(reader, anchor)).toBe('drift');
  });

  // ── canonical + NFC nested-embed child ──────────────────────────────────────
  const certifyChild = (child: unknown): CovenantAnchor => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insertEmbed(0, { embedType: 'nestedDoc', child });
    return certify(make(doc, { path: [0, 0], start: 0, end: 1 }));
  };
  it(L('child: same object child in a different key order → SAME digest'), () => {
    expect(certifyChild({ title: 'Plan', author: 'Alice' }).renderedDigest).toBe(
      certifyChild({ author: 'Alice', title: 'Plan' }).renderedDigest,
    );
  });
  it(L('child: a genuinely different object child → DIFFERENT digest'), () => {
    expect(certifyChild({ title: 'Plan', author: 'Alice' }).renderedDigest).not.toBe(
      certifyChild({ title: 'Plan', author: 'Bob' }).renderedDigest,
    );
  });
  it(L('child: a STRING child composed vs decomposed → SAME digest (NFC)'), () => {
    expect(certifyChild('café').renderedDigest).toBe(certifyChild('café').renderedDigest);
  });
  it(L('child: an OBJECT child with a composed vs decomposed leaf → SAME digest'), () => {
    expect(certifyChild({ title: 'café' }).renderedDigest).toBe(
      certifyChild({ title: 'café' }).renderedDigest,
    );
  });
  it(L('child: a genuinely different child leaf → DIFFERENT digest'), () => {
    expect(certifyChild({ title: 'café' }).renderedDigest).not.toBe(
      certifyChild({ title: 'latte' }).renderedDigest,
    );
  });

  // ── provenance is intentionally NOT a drift input ───────────────────────────
  it(L('provenance: changing objectId/roomId/certifier/certifiedAt leaves the verdict OK'), () => {
    const { doc } = makeDoc();
    const reader = capturing(doc);
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');
    expect(
      status(reader, {
        ...anchor,
        objectId: 'o_other',
        roomId: 'room_2',
        certifier: { kind: 'human', userId: 'u_bob' },
        certifiedAt: '2099-01-01T00:00:00.000Z',
      }),
    ).toBe('ok');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // THE THREE CONTROLS the production suite had OMITTED (#189 coverage close). Run
  // against BOTH readers now, so coverage cannot diverge again.
  // ════════════════════════════════════════════════════════════════════════════
  it(L('control: an SV frontier that is NOT a real per-client boundary → DRIFT'), () => {
    const doc = new Y.Doc();
    doc.clientID = 424242;
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insert(0, 'shipitnow'); // one item, len 9 → text boundary at clock 11
    const reader = make(doc, { path: [0, 0], start: 0, end: 9 });
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');

    const t = new Y.Doc();
    t.clientID = 424242;
    const tf = t.getXmlFragment('doc');
    const tp = new Y.XmlElement('paragraph');
    const tb = new Y.XmlText();
    tf.insert(0, [tp]);
    tp.insert(0, [tb]);
    tb.insert(0, 'ship'); // frontier 2 (para,body) + 4 = 6, OFF the live boundary set {0,1,2,11}
    const tSV = Y.decodeStateVector(Y.encodeStateVector(t));
    let tSum = 0;
    for (const c of tSV.values()) tSum += c;
    expect(tSum).toBe(6); // guard: the tampered frontier really is off-boundary
    expect(
      status(reader, { ...anchor, stateVector: b64(Y.encodeStateVector(t)), revision: tSum }),
    ).toBe('drift');
  });
  it(L('control: a BOUNDARY tombstone dropped from the deleteSet → DRIFT'), () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insert(0, 'XABCDEY'); // 7 chars
    body.delete(0, 1); // tombstone at offset 0 (== span start)
    body.delete(5, 1); // tombstone at offset 5 (== span end); visible 'ABCDE'
    const reader = make(doc, { path: [0, 0], start: 0, end: 5 });
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');
    const capturedDS = JSON.parse(Buffer.from(anchor.deleteSet, 'base64').toString('utf8'));
    expect(Object.keys(capturedDS).length).toBeGreaterThan(0);
    const emptied = Buffer.from(JSON.stringify({})).toString('base64');
    expect(status(reader, { ...anchor, deleteSet: emptied })).toBe('drift');
  });
  it(L('control: a legitimate unrelated deletion ELSEWHERE still resolves OK'), () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const body = new Y.XmlText();
    frag.insert(0, [para]);
    para.insert(0, [body]);
    body.insert(0, 'ABCDEFGHIJ'); // span [0,5) = 'ABCDE'
    const reader = make(doc, { path: [0, 0], start: 0, end: 5 });
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');
    body.delete(6, 3); // 'GHI' — strictly OUTSIDE and not adjacent to the span
    expect(status(reader, anchor)).toBe('ok');
  });
}
