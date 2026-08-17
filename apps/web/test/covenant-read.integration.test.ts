import { type CovenantAnchor, certifyAnchor } from '@atrium/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readerSpanResolver, webCovenantReadAuthority } from '@/lib/covenant-read';
import { CovenantDocReaderProd, type DocSource } from '@/lib/covenant-reader';

/**
 * SL-4 (#191) END-TO-END: the read authority driven through the REAL production
 * reader (#189) and its genuinely-async, monotonic, deadline-bounded resolve —
 * proving the async fail-closed contract with production plumbing, not a fake
 * resolver. The two temporal states the ticket turns on are pinned here against a
 * live `Y.Doc` + a controllable {@link DocSource}:
 *
 *   - a NEVER-ready source, while its deadline is still running ⇒ the authority's
 *     `resolve()` is IN FLIGHT and a sync `read()` returns `~` (unresolved), never
 *     `ok`;
 *   - the SAME source once its deadline has fired ⇒ `resolveSpanAsync` returns
 *     `null` ⇒ the authority is `drift` (unavailable/stalled), never `ok`.
 *
 * Plus the honest ok/drift end-to-end over a real doc, and the cross-call fragment
 * identity (acceptance #5). The reader's own conformance is covenant-reader.
 * conformance.test.ts; this proves the SEAM composes it correctly.
 */

const ALICE = { kind: 'human', userId: 'u_alice' } as const;
const AT = '2026-08-16T12:00:00.000Z';
const SPAN = { start: 8, end: 21 } as const;

interface Built {
  doc: Y.Doc;
  body: Y.XmlText;
}

function makeDoc(): Built {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('doc');
  const blockquote = new Y.XmlElement('blockquote');
  blockquote.setAttribute('indent', '1');
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
  body.insert(15, ' now');
  body.format(6, 7, { bold: true });
  return { doc, body };
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

/** A source that is never ready (a stalled / gone stream). */
const neverReady: DocSource = { poll: () => null };

describe('covenant read authority × production reader — async fail-closed end-to-end (#191)', () => {
  it('UNCHANGED content over a live doc ⇒ ok; the sync read reflects it', async () => {
    const { doc } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    const authority = webCovenantReadAuthority({ loadAnchor: async () => anchor, reader });
    expect((await authority.resolve('o_span')).covenantStatus).toBe('ok');
    expect(authority.read('o_span').covenantStatus).toBe('ok');
  });

  it('a typed character (drift) over a live doc ⇒ drift', async () => {
    const { doc, body } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    body.insert(9, 'X'); // mutate inside the span after certifying
    const authority = webCovenantReadAuthority({ loadAnchor: async () => anchor, reader });
    expect((await authority.resolve('o_span')).covenantStatus).toBe('drift');
  });

  it('ASYNC-PENDING ⇒ `~`: while a never-ready source is inside its deadline, sync read is unresolved (never ok)', async () => {
    const { doc } = makeDoc();
    const anchor = certify(capturingReader(doc));
    // A reader over a NEVER-ready source with a real (non-trivial) deadline: the async
    // resolve stays IN FLIGHT until the deadline fires.
    const stalled = new CovenantDocReaderProd(neverReady, undefined, { deadlineMs: 50 });
    const authority = webCovenantReadAuthority({ loadAnchor: async () => anchor, reader: stalled });

    const inflight = authority.resolve('o_span');
    // Synchronously, before the deadline: resolution is pending ⇒ `~`.
    const whilePending = authority.read('o_span');
    expect(whilePending.covenantStatus).toBe('unresolved');
    expect(whilePending.covenantStatus).not.toBe('ok');
    expect(whilePending.covenantStatus).not.toBe('drift');

    // Once the deadline fires, the stalled source resolves to `null` ⇒ drift (definitive).
    expect((await inflight).covenantStatus).toBe('drift');
    expect(authority.read('o_span').covenantStatus).toBe('drift');
  });

  it('UNAVAILABLE / stalled source ⇒ drift at the deadline, never a late ok', async () => {
    const { doc } = makeDoc();
    const anchor = certify(capturingReader(doc));
    const stalled = new CovenantDocReaderProd(neverReady, undefined, { deadlineMs: 20 });
    const authority = webCovenantReadAuthority({ loadAnchor: async () => anchor, reader: stalled });
    expect((await authority.resolve('o_span')).covenantStatus).toBe('drift');
  });

  it('readerSpanResolver adapts a stalled reader to a null-yielding port (⇒ drift)', async () => {
    const anchor = certify(capturingReader(makeDoc().doc));
    const stalled = new CovenantDocReaderProd(neverReady, undefined, { deadlineMs: 20 });
    const resolve = readerSpanResolver(stalled);
    expect(await resolve(anchor)).toBeNull();
  });

  it('cross-call fragment identity (#5): two reads of the same object share one frozen result', async () => {
    const { doc } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    const authority = webCovenantReadAuthority({ loadAnchor: async () => anchor, reader });
    await authority.resolve('o_span');
    const a = authority.read('o_span');
    const b = authority.read('o_span');
    expect(a).toBe(b);
    expect(a.renderedFragment).toBe(b.renderedFragment);
  });

  it('flip-the-input: a SECOND independent authority at the same drifted anchor is never ok', async () => {
    const { doc, body } = makeDoc();
    const reader = capturingReader(doc);
    const anchor = certify(reader);
    body.insert(9, 'Z'); // drift
    const first = webCovenantReadAuthority({ loadAnchor: async () => anchor, reader });
    const second = webCovenantReadAuthority({
      loadAnchor: async () => anchor,
      reader: capturingReader(doc),
    });
    // Second caller reads before resolving ⇒ `~`, not ok.
    expect(second.read('o_span').covenantStatus).toBe('unresolved');
    expect((await first.resolve('o_span')).covenantStatus).toBe('drift');
    expect((await second.resolve('o_span')).covenantStatus).toBe('drift');
    expect(second.read('o_span').covenantStatus).not.toBe('ok');
  });
});
