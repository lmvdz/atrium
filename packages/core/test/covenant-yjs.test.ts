import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import {
  type CapturedSelection,
  type CovenantAnchor,
  type CovenantDocReader,
  type EnclosedItem,
  type Mark,
  type RenderedFragment,
  type RenderedNode,
  certifyAnchor,
  resolveCovenant,
} from '../src/index.js';

/**
 * `resolveCovenant` against a REAL in-memory Yjs document. `covenant.test.ts`
 * pins the pure primitive with a stub; this proves the {@link CovenantDocReader}
 * port can be honestly implemented over Yjs and that genuine CRDT edits — a typed
 * character, a re-pointed mention, a deleted node, a garbage-collected span —
 * move the verdict exactly as the acceptance test requires. There is no live Yjs
 * doc in the repo yet (#183 builds it); this adapter is the reference the app
 * binding in #181/#183 will mirror, exercised here on a synthetic doc.
 *
 * The doc shape: a top-level `Y.XmlFragment` holds one heading `Y.XmlElement`
 * (its `level` attribute = ancestor formatting); the heading's children are the
 * certified span — a `Y.XmlText` run (marks via formatting) and embed
 * `Y.XmlElement`s (a mention with a `target`, an image with a `src`).
 */

/** A stable id for a CRDT item — client + clock, gone when the item is replaced. */
function itemId(node: Y.XmlText | Y.XmlElement): string {
  // `_item` is Yjs-internal but is the item's identity; a deleted-and-reinserted
  // node gets a fresh (client, clock), which is exactly the drift we must catch.
  const item = (node as unknown as { _item: { id: { client: number; clock: number } } })._item;
  return `${item.id.client}:${item.id.clock}`;
}

function marksOf(attributes: Record<string, unknown> | null | undefined): Mark[] {
  if (!attributes) return [];
  return Object.keys(attributes)
    .sort()
    .map((type) => {
      const raw = attributes[type];
      const attrs =
        raw && typeof raw === 'object'
          ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]))
          : {};
      return { type, attrs, straddles: 'none' as const };
    });
}

/** A stateful reader bound to one Y.Doc, holding the span it certified. */
class YjsReader implements CovenantDocReader {
  private relStart: Y.RelativePosition | null = null;
  private relEnd: Y.RelativePosition | null = null;

  constructor(
    private doc: Y.Doc | null,
    private readonly headingIndex = 0,
  ) {}

  /** Simulate the doc handle becoming unavailable (a dropped Electric stream). */
  makeUnavailable() {
    this.doc = null;
  }

  private fragment(): Y.XmlFragment | null {
    return this.doc ? this.doc.getXmlFragment('doc') : null;
  }

  private heading(): Y.XmlElement | null {
    const frag = this.fragment();
    if (!frag) return null;
    // Resolve the recorded relative positions; either failing ⇒ the span is gone.
    if (this.relStart && this.relEnd && this.doc) {
      const a = Y.createAbsolutePositionFromRelativePosition(this.relStart, this.doc);
      const b = Y.createAbsolutePositionFromRelativePosition(this.relEnd, this.doc);
      if (a === null || b === null) return null;
    }
    const el = frag.get(this.headingIndex);
    if (!(el instanceof Y.XmlElement)) return null;
    const item = (el as unknown as { _item: { deleted: boolean } | null })._item;
    if (item && item.deleted) return null;
    return el;
  }

  private render(heading: Y.XmlElement): { fragment: RenderedFragment; enclosedItems: EnclosedItem[] } {
    const ancestors = [
      { type: heading.nodeName, attrs: { level: String(heading.getAttribute('level') ?? '') } },
    ];
    const nodes: RenderedNode[] = [];
    const enclosedItems: EnclosedItem[] = [];
    for (const child of heading.toArray()) {
      if (child instanceof Y.XmlText) {
        for (const op of child.toDelta() as Array<{ insert: string; attributes?: Record<string, unknown> }>) {
          nodes.push({ kind: 'text', text: op.insert, marks: marksOf(op.attributes) });
        }
        enclosedItems.push({ id: itemId(child), kind: 'text' });
      } else if (child instanceof Y.XmlElement) {
        const identity: Record<string, string> = {};
        for (const [k, v] of Object.entries(child.getAttributes())) identity[k] = String(v);
        nodes.push({ kind: 'embed', embedType: child.nodeName, identity });
        enclosedItems.push({ id: itemId(child), kind: 'embed' });
      }
    }
    return { fragment: { ancestors, nodes }, enclosedItems };
  }

  captureSelection(): CapturedSelection | null {
    const frag = this.fragment();
    const heading = this.heading();
    if (!frag || !heading || !this.doc) return null;
    this.relStart = Y.createRelativePositionFromTypeIndex(frag, this.headingIndex);
    this.relEnd = Y.createRelativePositionFromTypeIndex(frag, this.headingIndex + 1);
    const { fragment, enclosedItems } = this.render(heading);
    return {
      revision: this.doc.store.clients.size === 0 ? 0 : nextClock(this.doc),
      stateVector: bytesToBase64(Y.encodeStateVector(this.doc)),
      deleteSet: bytesToBase64(Y.encodeSnapshot(Y.snapshot(this.doc))),
      fragment,
      enclosedItems,
    };
  }

  resolveSpan(_anchor: CovenantAnchor) {
    if (!this.doc) return null; // unavailable ⇒ fail-closed
    const heading = this.heading();
    if (!heading) return null; // GC'd / deleted / unresolvable ⇒ fail-closed
    return this.render(heading);
  }
}

function nextClock(doc: Y.Doc): number {
  let max = 0;
  for (const clock of doc.store.clients.keys()) {
    const structs = doc.store.clients.get(clock);
    const last = structs && structs.length > 0 ? structs[structs.length - 1] : undefined;
    if (last) max = Math.max(max, last.id.clock + last.length);
  }
  return max;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa exists in node and browsers; the reader is app-layer, not core.
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
}

/** Build a fresh doc with one heading span: text (bold tail), a mention, an image. */
function makeDoc(): { doc: Y.Doc; heading: Y.XmlElement; text: Y.XmlText } {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('doc');
  const heading = new Y.XmlElement('heading');
  heading.setAttribute('level', '2');
  const text = new Y.XmlText();
  text.insert(0, 'ship ');
  text.insert(5, 'it', { bold: {} });
  const mention = new Y.XmlElement('mention');
  mention.setAttribute('target', 'u_alice');
  const image = new Y.XmlElement('image');
  image.setAttribute('src', 'https://x/a.png');
  heading.insert(0, [text, mention, image]);
  frag.insert(0, [heading]);
  return { doc, heading, text };
}

const ALICE = { kind: 'human', userId: 'u_alice' } as const;
const AT = '2026-08-16T12:00:00.000Z';

function certify(reader: YjsReader): CovenantAnchor {
  const anchor = certifyAnchor(reader, {
    objectId: 'o_span',
    roomId: 'room_1',
    certifier: ALICE,
    certifiedAt: AT,
  });
  if (anchor === null) throw new Error('capture failed');
  return anchor;
}

describe('resolveCovenant over a real Yjs doc', () => {
  it('class 7: byte-identical (no edit) → OK', () => {
    const { doc } = makeDoc();
    const reader = new YjsReader(doc);
    const anchor = certify(reader);
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('ok');
  });

  it('class 1: a typed character in the span → DRIFT', () => {
    const { doc, text } = makeDoc();
    const reader = new YjsReader(doc);
    const anchor = certify(reader);
    text.insert(text.length, '!');
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('drift');
  });

  it('class 2: ancestor formatting (heading level) changed → DRIFT', () => {
    const { doc, heading } = makeDoc();
    const reader = new YjsReader(doc);
    const anchor = certify(reader);
    heading.setAttribute('level', '3');
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('drift');
  });

  it('class 3: a mark on the span changed (bold removed) → DRIFT', () => {
    const { doc, text } = makeDoc();
    const reader = new YjsReader(doc);
    const anchor = certify(reader);
    text.format(5, 2, { bold: null });
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('drift');
  });

  it('class 4a: an embed internal — mention target re-pointed → DRIFT', () => {
    const { doc, heading } = makeDoc();
    const reader = new YjsReader(doc);
    const anchor = certify(reader);
    (heading.get(1) as Y.XmlElement).setAttribute('target', 'u_bob');
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('drift');
  });

  it('class 4b: an embed internal — image src swapped → DRIFT', () => {
    const { doc, heading } = makeDoc();
    const reader = new YjsReader(doc);
    const anchor = certify(reader);
    (heading.get(2) as Y.XmlElement).setAttribute('src', 'https://x/b.png');
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('drift');
  });

  it('class 5: an enclosed item deleted → DRIFT', () => {
    const { doc, heading } = makeDoc();
    const reader = new YjsReader(doc);
    const anchor = certify(reader);
    heading.delete(2, 1); // remove the image node
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('drift');
  });

  it('class 6a: the doc became unavailable → DRIFT (fail-closed)', () => {
    const { doc } = makeDoc();
    const reader = new YjsReader(doc);
    const anchor = certify(reader);
    reader.makeUnavailable();
    const res = resolveCovenant(reader, anchor);
    expect(res.covenantStatus).toBe('drift');
    expect(res.renderedFragment).toBeNull();
  });

  it('class 6b: the whole span was deleted + GC → unresolvable → DRIFT', () => {
    const { doc } = makeDoc();
    doc.gc = true;
    const reader = new YjsReader(doc);
    const anchor = certify(reader);
    doc.getXmlFragment('doc').delete(0, 1); // delete the heading; gc reclaims it
    const res = resolveCovenant(reader, anchor);
    expect(res.covenantStatus).toBe('drift');
    expect(res.renderedFragment).toBeNull();
  });

  it('an edit that reverts to the certified content resolves OK again', () => {
    // #163 stale-semantics note: the anchor is over CONTENT, so restoring the
    // exact content restores OK. (Whether the human-facing `✓` re-arms is a
    // read-authority policy question for #181, not the anchor's.)
    const { doc, text } = makeDoc();
    const reader = new YjsReader(doc);
    const anchor = certify(reader);
    text.insert(text.length, '!');
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('drift');
    text.delete(text.length - 1, 1);
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('ok');
  });
});
