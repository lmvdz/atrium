import { type CovenantAnchor, certifyAnchor, resolveCovenant } from '@atrium/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  CovenantDocReaderProd,
  type RootResolver,
  readerForLiveDoc,
} from '@/lib/covenant-reader';
import { conversationDocFor } from '../app/prototype/yjs-conversation';
import { conversationModel } from '../app/prototype/conversation-model';
import { InMemoryConversationHub } from '../app/prototype/conversation-transport';
import type { ChatMsg, Selection } from '../app/prototype/types';
import {
  ConversationDoc,
  conversationContentRoot,
  conversationModelFromDoc,
} from '../app/prototype/yjs-conversation';
import { glyphFor } from '../src/components/model/glyph';
import { messageLedger } from '../src/components/model/quotation';

/* ═══════════════════════════════════════════════════════════════════════════
 * #194 / P6F-1 — the RICH-TEXT BODY SUBSTRATE.
 *
 * Each message body is now a live `Y.XmlText` (the rented y-prosemirror shape)
 * under a named content share, so two peers co-edit ONE body and converge, and the
 * SL-2 production reader (`CovenantDocReaderProd`) resolves a SUB-MESSAGE range
 * against it. The hard part is proven here: EVERY #183 security invariant survives
 * the move to an in-place-mutable body, and each proof is MUTATION-PINNED (flip the
 * input → the protection still fires; remove the protection → the test fails).
 * ═════════════════════════════════════════════════════════════════════════ */

const ALICE = { kind: 'human', userId: 'u_alice' } as const;
const AT = '2026-08-17T12:00:00.000Z';

/** Build a capturing reader over a `ConversationDoc`, watching its content share. */
function readerFor(
  convo: ConversationDoc,
  id: string,
  span: { start: number; end: number },
): CovenantDocReaderProd {
  const path = convo.bodyPath(id);
  if (!path) throw new Error('no body path');
  const provider = () => (convo.isDestroyed() ? null : convo.doc);
  const root: RootResolver = conversationContentRoot;
  return readerForLiveDoc(provider, { path, start: span.start, end: span.end }, { resolveRoot: root });
}

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

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE BODY IS A Y.XmlText — and the model still projects byte-identically.
// ─────────────────────────────────────────────────────────────────────────────

describe('the body is a real Y.XmlText, and the model is byte-identical for the static seeds', () => {
  const SELECTIONS: readonly Selection[] = [
    { kind: 'session', id: 's-live' },
    { kind: 'session', id: 's-scout' },
    { kind: 'session', id: 's-rank' },
    { kind: 'session', id: 's-audit' },
  ];

  it('every text-bearing seeded message has a Y.XmlText body carrying its text', () => {
    const convo = conversationDocFor({ kind: 'session', id: 's-live' });
    for (const message of convo.messages()) {
      if (typeof message.text !== 'string') continue;
      const body = convo.body(message.id);
      expect(body).toBeInstanceOf(Y.XmlText);
      // The plain body text equals the message's text (the substrate round-trips).
      expect(body?.toString()).toBe(message.text);
    }
  });

  for (const selection of SELECTIONS) {
    it(`projects byte-identically to the mock model for ${selection.id}`, () => {
      const fromMock = conversationModel(selection);
      const fromDoc = conversationModelFromDoc(conversationDocFor(selection), selection);
      expect(fromDoc.records).toEqual(fromMock.records);
      // Every non-system item is byte-identical (turn/image/message shells intact).
      expect(fromDoc.items.filter((i) => i.kind !== 'system')).toEqual(
        fromMock.items.filter((i) => i.kind !== 'system'),
      );
      // The CRDT derives NO ✓ — the one intended divergence (#183 round-3).
      const glyphs = fromDoc.items.flatMap((i) =>
        i.kind === 'system' ? [glyphFor(i.entry.state)] : [],
      );
      expect(glyphs).not.toContain('✓');
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TWO CLIENTS CONVERGE ON AN IN-BODY EDIT (not just an append).
// ─────────────────────────────────────────────────────────────────────────────

describe('two clients converge on an in-BODY rich-text edit over the in-memory hub', () => {
  it('a character one client types inside a shared body appears on the other', () => {
    const hub = new InMemoryConversationHub(new Y.Doc());
    const clientA = new ConversationDoc();
    const clientB = new ConversationDoc();
    clientA.connect(hub.transport());
    clientB.connect(hub.transport());

    clientA.append({ id: 'm1', time: '10:00', kind: 'human', who: 'you', text: 'ship it' });
    // The whole body converged to B as content.
    expect(clientB.body('m1')?.toString()).toBe('ship it');

    // B edits the SAME body in place; A converges to B's edit (Yjs merge, not ours).
    clientB.body('m1')?.insert(4, 'X');
    expect(clientA.body('m1')?.toString()).toBe('shipX it');
    expect(clientA.messages().find((m) => m.id === 'm1')?.text).toBe('shipX it');
  });

  it('concurrent in-body edits from both clients converge to ONE identical body', () => {
    const hub = new InMemoryConversationHub(new Y.Doc());
    const clientA = new ConversationDoc();
    const clientB = new ConversationDoc();
    clientA.connect(hub.transport());
    clientB.connect(hub.transport());
    clientA.append({ id: 'm', time: '10:00', kind: 'human', who: 'you', text: 'abc' });

    // Each end appends at a different edge of the shared body, concurrently.
    clientA.body('m')?.insert(0, 'A');
    clientB.body('m')?.insert(clientB.body('m')!.length, 'B');

    const a = clientA.body('m')?.toString();
    const b = clientB.body('m')?.toString();
    expect(a).toBe(b); // converged to one order — Yjs decides it
    expect(a).toContain('A');
    expect(a).toContain('B');
    expect(a).toContain('abc');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE PRODUCTION READER RESOLVES A SUB-MESSAGE RANGE AGAINST A BODY.
// ─────────────────────────────────────────────────────────────────────────────

describe('the SL-2 production reader resolves a sub-message range against a rich-text body', () => {
  it('certifies a sub-range and reads OK, then DRIFTs when THAT range is edited', () => {
    const convo = new ConversationDoc();
    convo.append({ id: 'm1', time: '10:00', kind: 'human', who: 'you', text: 'ship the migration' });
    const reader = readerFor(convo, 'm1', { start: 0, end: 4 }); // 'ship'
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');

    // Edit INSIDE the certified sub-range — the reader watches this exact body.
    convo.body('m1')?.insert(2, 'X');
    expect(status(reader, anchor)).toBe('drift');
  });

  it('span precision: an edit OUTSIDE the certified sub-range does not de-certify it', () => {
    const convo = new ConversationDoc();
    convo.append({ id: 'm1', time: '10:00', kind: 'human', who: 'you', text: 'ship the migration' });
    const reader = readerFor(convo, 'm1', { start: 0, end: 4 }); // 'ship'
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');

    // Delete 'migration' (offset 9+) — well past the certified [0,4) window.
    convo.body('m1')?.delete(9, 9);
    expect(status(reader, anchor)).toBe('ok');
  });

  it('an anchor for message A does not resolve OK against message B (bodies are distinct)', () => {
    const convo = new ConversationDoc();
    convo.append({ id: 'a', time: '10:00', kind: 'human', who: 'you', text: 'alpha body' });
    convo.append({ id: 'b', time: '10:01', kind: 'human', who: 'you', text: 'alpha body' });
    const anchorA = certify(readerFor(convo, 'a', { start: 0, end: 5 }));

    // Editing B's body must not flip A's anchor — the anchor binds to A's Y.XmlText.
    convo.body('b')?.insert(0, 'Z');
    expect(status(readerFor(convo, 'a', { start: 0, end: 5 }), anchorA)).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. NESTED Y-TYPE EMBED INSIDE A BODY FAILS CLOSED AT THE READER — never ✓.
// ─────────────────────────────────────────────────────────────────────────────

describe('a nested Y-type embed inside a certified body FAILS CLOSED (DRIFT), never a false ✓', () => {
  it('embedding a Y.Map into the certified body resolves to DRIFT, not OK', () => {
    const convo = new ConversationDoc();
    convo.append({ id: 'm1', time: '10:00', kind: 'human', who: 'you', text: 'the reading' });
    const reader = readerFor(convo, 'm1', { start: 0, end: 11 });
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');

    // A hostile peer embeds a nested Yjs type into the certified range. A non-plain
    // prototype cannot be canonicalized injectively → the reader THROWS → resolveCovenant
    // turns it into DRIFT. It must NEVER read OK / mint a ✓ over an unrenderable embed.
    convo.body('m1')?.insertEmbed(4, new Y.Map());
    const res = resolveCovenant(reader, anchor);
    expect(res.covenantStatus).toBe('drift');
    expect(res.covenantStatus).not.toBe('ok');
    // FAIL-CLOSE ISOLATION: the sync, UNCAUGHT resolve path THROWS on the nested
    // Y-type — the reader REFUSES to render it rather than producing a resolvable
    // (potentially false-OK) fragment. This distinguishes the fail-close from an
    // ordinary content-change drift: the reader cannot even build a fragment here.
    expect(() => reader.resolveSpan(anchor)).toThrow();
  });

  it('MUTATION PIN — the SAME body with the embed REMOVED (byte-identical) reads OK again', () => {
    // Proves the DRIFT above is caused by the hostile embed, not an incidental edit:
    // a clean body of the same text reads OK, so the fail-close is load-bearing.
    const convo = new ConversationDoc();
    convo.append({ id: 'm1', time: '10:00', kind: 'human', who: 'you', text: 'the reading' });
    const reader = readerFor(convo, 'm1', { start: 0, end: 11 });
    expect(status(reader, certify(reader))).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. #183 SECURITY INVARIANTS RE-ESTABLISHED ON THE MUTABLE BODY — mutation-pinned.
// ─────────────────────────────────────────────────────────────────────────────

describe('#183 invariants hold on the in-place-mutable body (each mutation-pinned)', () => {
  it('certifiedIds stays empty: the CRDT mints no ✓ even for a seeded certified line', () => {
    const convo = new ConversationDoc().seed([
      { id: 'settled', time: '10:00', kind: 'system', text: 'landed', certified: true },
    ]);
    const system = convo.model('r', []).items.find((i) => i.kind === 'system');
    if (system?.kind !== 'system') throw new Error('unreachable');
    // The honest `~`, never `✓` — certification is #181's, not the doc's.
    expect(glyphFor(system.entry.state)).toBe('~');
    expect(glyphFor(system.entry.state)).not.toBe('✓');
  });

  it('AUTHORITY-STRIP allowlist: a forged {certified:true} never rides the wire', () => {
    const convo = new ConversationDoc();
    convo.append({ id: 'f', time: '10:00', kind: 'system', text: 'settled', certified: true });
    const [carried] = convo.messages();
    // The metadata carries no `certified` field at all — stripped at the wire.
    expect('certified' in (carried as object)).toBe(false);
    // FLIP THE INPUT: the forged system line projects as unverified content, no ✓.
    const model = convo.model('r', []);
    expect(model.records.find((r) => r.id === 'f')?.authorKind).toBe('unknown');
    const glyphs = model.items.flatMap((i) =>
      i.kind === 'system' ? [glyphFor(i.entry.state)] : [],
    );
    expect(glyphs).not.toContain('✓');
  });

  it('THE #194 HOLE — an in-place edit of a TRUSTED seeded body DEMOTES it to unverified', () => {
    // A Y.XmlText mutates in place, so #183's "quarantine the later element" does NOT
    // cover a peer that edits a seeded body directly. The trust fingerprint now binds
    // the live body text, so an in-place edit fails the match → UNVERIFIED (fail-closed).
    const convo = new ConversationDoc().seed([
      { id: 'trusted', time: '10:00', kind: 'agent', who: 'hexi', text: 'the honest reading' },
    ]);
    // Baseline: the seeded line is TRUSTED — an authenticated agent record.
    const before = convo.model('r', []).records.find((r) => r.id === 'trusted');
    expect(before?.authorKind).toBe('agent');

    // A peer rewrites the seeded body IN PLACE (the new forgery surface).
    convo.body('trusted')?.insert(0, 'FORGED: ');

    // MUTATION PIN: with the body drifted, the line demotes — no forged authenticated
    // agent line survives. (Remove the fingerprint-covers-body extension → this fails.)
    const after = convo.model('r', []).records.find((r) => r.id === 'trusted');
    expect(after?.authorKind).toBe('unknown');
    expect(after?.text).toContain('FORGED');
  });

  it('ID-UNIQUENESS QUARANTINE survives: a colliding metadata id re-use is dropped, body first-wins', () => {
    const convo = new ConversationDoc().seed([
      { id: 'dup', time: '10:00', kind: 'human', who: 'you', text: 'the original' },
    ]);
    // A peer re-uses the seeded id with different content AND seats a second body block.
    const arr = convo.doc.getArray<unknown>('messages');
    convo.doc.transact(() => {
      arr.push([JSON.stringify({ id: 'dup', time: '10:05', kind: 'human', who: 'you' })]);
    });
    const frag = convo.contentFragment();
    convo.doc.transact(() => {
      const block = new Y.XmlElement('message');
      const xtext = new Y.XmlText();
      frag.insert(frag.length, [block]);
      block.setAttribute('mid', 'dup');
      block.insert(0, [xtext]);
      xtext.insert(0, 'IMPOSTER BODY');
    });

    const model = convo.model('r', []);
    // First-wins on BOTH channels: exactly one record for the id, the original body.
    expect(model.records.filter((r) => r.id === 'dup')).toHaveLength(1);
    expect(model.records.find((r) => r.id === 'dup')?.text).toBe('the original');
    expect(model.records.some((r) => r.text.includes('IMPOSTER'))).toBe(false);
    expect(() => messageLedger(model.records)).not.toThrow();
  });

  it('HOSTILE ELEMENT no-crash: a raw body-share block for an unknown id yields no phantom message', () => {
    const convo = new ConversationDoc().seed([
      { id: 'ok', time: '10:00', kind: 'human', who: 'you', text: 'hello' },
    ]);
    // A peer seats a body block whose id has NO metadata element — a dangling body.
    const frag = convo.contentFragment();
    convo.doc.transact(() => {
      const block = new Y.XmlElement('message');
      const xtext = new Y.XmlText();
      frag.insert(frag.length, [block]);
      block.setAttribute('mid', 'ghost');
      block.insert(0, [xtext]);
      xtext.insert(0, 'no metadata backs me');
    });
    // messages() is driven by the metadata index, so a dangling body is ignored —
    // no phantom message, no crash on projection or ledger.
    expect(() => convo.messages()).not.toThrow();
    expect(convo.messages().map((m) => m.id)).toEqual(['ok']);
    expect(() => messageLedger(convo.model('r', []).records)).not.toThrow();
  });

  it('trusted seed stays trusted while its body is UNCHANGED (the demotion is edit-driven, not blanket)', () => {
    // The complement of the in-place-edit pin: an untouched seeded body keeps its
    // authenticated provenance — so the demotion above is caused by the edit, not by
    // moving text into a body at all.
    const convo = new ConversationDoc().seed([
      { id: 'trusted', time: '10:00', kind: 'agent', who: 'hexi', text: 'the honest reading' },
    ]);
    const record = convo.model('r', []).records.find((r) => r.id === 'trusted');
    expect(record?.authorKind).toBe('agent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. TRANSPORT RELAYS BODY (XmlText) UPDATES UNTOUCHED — verify (ticket ask).
// ─────────────────────────────────────────────────────────────────────────────

describe('the conversation transport relays rich-text body updates untouched', () => {
  it('a late joiner is caught up to bodies written before it connected', () => {
    const hub = new InMemoryConversationHub(new Y.Doc());
    const early = new ConversationDoc();
    early.connect(hub.transport());
    early.append({ id: 'h1', time: '12:00', kind: 'human', who: 'you', text: 'history body' });

    const late = new ConversationDoc();
    late.connect(hub.transport());
    // The body share caught up on join (opaque whole-doc update, no per-type handling).
    expect(late.body('h1')?.toString()).toBe('history body');

    // …and thereafter an in-body edit converges live in both directions.
    late.body('h1')?.insert(0, 'the ');
    expect(early.body('h1')?.toString()).toBe('the history body');
  });
});

// A convenience so the append-only ChatMsg shape stays honest under type-checking.
const _typecheck: ChatMsg = { id: 'x', time: '0', kind: 'human' };
void _typecheck;
