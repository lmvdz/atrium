import { type CovenantAnchor, certifyAnchor, resolveCovenant } from '@atrium/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  type CovenantDocReaderProd,
  type RootResolver,
  readerForLiveDoc,
} from '@/lib/covenant-reader';
import { conversationModel } from '../app/prototype/conversation-model';
import { InMemoryConversationHub } from '../app/prototype/conversation-transport';
import type { ChatMsg, Selection } from '../app/prototype/types';
import {
  ConversationDoc,
  conversationContentRoot,
  conversationDocFor,
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
  return readerForLiveDoc(
    provider,
    { path, start: span.start, end: span.end },
    { resolveRoot: root },
  );
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
    const bodyB = clientB.body('m');
    bodyB?.insert(bodyB.length, 'B');

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
    convo.append({
      id: 'm1',
      time: '10:00',
      kind: 'human',
      who: 'you',
      text: 'ship the migration',
    });
    const reader = readerFor(convo, 'm1', { start: 0, end: 4 }); // 'ship'
    const anchor = certify(reader);
    expect(status(reader, anchor)).toBe('ok');

    // Edit INSIDE the certified sub-range — the reader watches this exact body.
    convo.body('m1')?.insert(2, 'X');
    expect(status(reader, anchor)).toBe('drift');
  });

  it('span precision: an edit OUTSIDE the certified sub-range does not de-certify it', () => {
    const convo = new ConversationDoc();
    convo.append({
      id: 'm1',
      time: '10:00',
      kind: 'human',
      who: 'you',
      text: 'ship the migration',
    });
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

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE P6F-1 GAUNTLET FIX — FULL-RENDERED-CONTENT TRUST + DETERMINISTIC RESOLUTION.
//
// codex (executing) FAILed P6F-1 on two counts, both closed here (each not-theater:
// the demotion / no-hiding assertions FAIL on base d2efc13 — where trust was
// plaintext-only and resolution was positional — and pass now):
//   HIGH   — the trust fingerprint bound only reconstructed PLAINTEXT, so a peer could
//            apply a link mark, insert a mention/embed, or delete-all + reinsert
//            identical plaintext and KEEP a trusted body's authenticated agent
//            authorship. It now binds the FULL RENDERED body (the SL-2 reader's digest
//            — text + marks + embeds + attrs) bound with the body's CRDT item identity.
//   MEDIUM — body/index resolution was positional ("first in fragment/array order
//            wins"), so a peer inserting a colliding block/element at position 0 could
//            HIDE genuine content under an id. Resolution is now identity-bound.
// ─────────────────────────────────────────────────────────────────────────────

/** Seed one TRUSTED agent line and confirm it starts authenticated. */
function seedTrustedAgent(text: string): ConversationDoc {
  const convo = new ConversationDoc().seed([
    { id: 't', time: '10:00', kind: 'agent', who: 'hexi', text },
  ]);
  const before = convo.model('r', []).records.find((r) => r.id === 't');
  expect(before?.authorKind).toBe('agent'); // baseline: trusted before any edit
  return convo;
}

const authorKindOf = (convo: ConversationDoc, id: string) =>
  convo.model('r', []).records.find((r) => r.id === id)?.authorKind;

describe('P6F-1 HIGH — the trust fingerprint covers FULL rendered content, not plaintext', () => {
  it('a LINK MARK on a trusted body (plaintext unchanged) DEMOTES it to unverified', () => {
    const convo = seedTrustedAgent('the honest reading');
    // A peer stamps a link mark over the body — meaning-bearing, but the PLAINTEXT
    // (toDelta string inserts) is unchanged, so the base plaintext fingerprint never
    // saw it and kept trust. The rendered digest (which carries marks) moves → demote.
    convo.body('t')?.format(0, 3, { link: 'https://evil.example' });
    expect(authorKindOf(convo, 't')).toBe('unknown');
  });

  it('inserting a MENTION/EMBED into a trusted body DEMOTES it to unverified', () => {
    const convo = seedTrustedAgent('the honest reading');
    // An embed op carries insert:object, which the base plaintext reconstruction
    // (string inserts only) discarded — so the forgery kept trust on base.
    convo.body('t')?.insertEmbed(3, { kind: 'mention', target: 'u_mallory' });
    expect(authorKindOf(convo, 't')).toBe('unknown');
  });

  it('DELETE-ALL + REINSERT of identical plaintext DEMOTES it to unverified', () => {
    const convo = seedTrustedAgent('the honest reading');
    const body = convo.body('t');
    if (!body) throw new Error('no body');
    const text = body.toString();
    // Wipe the authored content and re-type the SAME words: the rendering is
    // byte-identical (so a plaintext fingerprint kept trust on base), but the CRDT
    // items are new — a structural replacement of authored content → the item-identity
    // half of the fingerprint moves → demote.
    convo.doc.transact(() => {
      body.delete(0, body.length);
      body.insert(0, text);
    });
    expect(convo.body('t')?.toString()).toBe('the honest reading'); // rendering identical
    expect(authorKindOf(convo, 't')).toBe('unknown');
  });

  it('a PURE NO-OP keeps trust, and an edit to a DIFFERENT body does not demote this one', () => {
    // The complement pins that the demotions above are EDIT-driven and BODY-LOCAL
    // (span-precision), not a blanket loss of trust.
    const convo = new ConversationDoc().seed([
      { id: 't', time: '10:00', kind: 'agent', who: 'hexi', text: 'the honest reading' },
      { id: 'other', time: '10:01', kind: 'agent', who: 'hexi', text: 'a second line' },
    ]);
    expect(authorKindOf(convo, 't')).toBe('agent');
    expect(authorKindOf(convo, 't')).toBe('agent'); // re-project: still trusted (no-op)
    // Editing a DIFFERENT body must not move t's body-local fingerprint.
    convo.body('other')?.insert(0, 'EDITED ');
    expect(authorKindOf(convo, 't')).toBe('agent');
    expect(authorKindOf(convo, 'other')).toBe('unknown'); // the edited one demotes
  });
});

describe('P6F-1 MEDIUM — deterministic identity-bound resolution, not positional first-wins', () => {
  it('a colliding body block inserted at POSITION 0 cannot HIDE the genuine body', () => {
    const convo = seedTrustedAgent('the genuine reading');
    // A peer seats a SECOND body block for the same id at the FRONT of the fragment —
    // the "position 0 wins" attack. Positional first-wins (base d2efc13) would surface
    // this imposter; identity-bound resolution keeps the genuine seated block.
    const frag = convo.contentFragment();
    convo.doc.transact(() => {
      const block = new Y.XmlElement('message');
      const xtext = new Y.XmlText();
      frag.insert(0, [block]); // FRONT, not the end
      block.setAttribute('mid', 't');
      block.insert(0, [xtext]);
      xtext.insert(0, 'HIDDEN IMPOSTER BODY');
    });
    const record = convo.model('r', []).records.find((r) => r.id === 't');
    expect(record?.text).toBe('the genuine reading'); // the genuine body, not the imposter
    expect(convo.model('r', []).records.some((r) => r.text.includes('HIDDEN'))).toBe(false);
  });

  it('a colliding INDEX element inserted at POSITION 0 cannot HIDE the genuine metadata', () => {
    const convo = seedTrustedAgent('the genuine reading');
    // A peer inserts a colliding metadata element for the same id at the FRONT of the
    // index array, with forged who/time. Positional first-wins (base) would project the
    // imposter's metadata; the genuine-index guard keeps the seated metadata.
    const arr = convo.doc.getArray<unknown>('messages');
    convo.doc.transact(() => {
      arr.insert(0, [JSON.stringify({ id: 't', time: '99:99', kind: 'agent', who: 'MALLORY' })]);
    });
    const projected = convo.messages().find((m) => m.id === 't');
    expect(projected?.who).toBe('hexi'); // the genuine seated metadata, not the imposter
    expect(projected?.time).toBe('10:00');
    expect(convo.messages().filter((m) => m.id === 't')).toHaveLength(1); // still id-unique
  });

  it('P6F-1 HIGH (index identity) — delete-genuine-index + reinsert IDENTICAL bytes DEMOTES', () => {
    // The round-1 index guard was VALUE-bound (string equality), so a peer that deleted the
    // genuine index element and inserted one with byte-identical serialized metadata was
    // treated as the same seat and KEPT trusted authorship (executed HIGH). The fingerprint
    // now binds the genuine index element's Yjs ITEM IDENTITY: the reinsert is a different
    // item (a new clock) → the fingerprint moves → the line demotes to unverified.
    const convo = seedTrustedAgent('the honest reading'); // baseline: authorKind 'agent'
    const arr = convo.doc.getArray<string>('messages');
    const genuineBytes = arr.get(0); // the seeded metadata string
    convo.doc.transact(() => {
      arr.delete(0, 1); // remove the genuine index element
      arr.insert(0, [genuineBytes]); // reinsert BYTE-IDENTICAL metadata — a NEW item
    });
    // Still projects (the id resolves to the reinserted element, body unchanged)…
    expect(convo.messages().find((m) => m.id === 't')?.who).toBe('hexi');
    expect(convo.messages().find((m) => m.id === 't')?.text).toBe('the honest reading');
    // …but as UNVERIFIED — item-identity binding refuses to inherit the genuine seat.
    // (Remove the index-item-id half of the fingerprint → this reads 'agent' and fails.)
    expect(authorKindOf(convo, 't')).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. P6F-1 CRITICAL (CRDT-CORRECTNESS) — GENUINE-SEAT RESOLUTION IS A DETERMINISTIC
//    FUNCTION OF SHARED CRDT STATE, so every replica CONVERGES.
//
// The round-1 fix kept genuine-seat provenance in per-INSTANCE Maps, so the seating
// instance resolved by item-identity while a late joiner / remote-only client / two
// merged offline clients resolved by document order — DIVERGENCE, which a CRDT must
// never do. Resolution is now the earliest Yjs item identity for the id, computed
// identically on every replica. Each assertion below FAILS on base ec38bdc (the late
// joiner / the other offline client sees a DIFFERENT model than the seeder) and passes now.
// ─────────────────────────────────────────────────────────────────────────────

const textOfId = (convo: ConversationDoc, id: string) =>
  convo.messages().find((m) => m.id === id)?.text;

/** Merge every doc's full state into every other — an all-to-all offline reconcile. */
function mergeAll(docs: readonly Y.Doc[]): void {
  const updates = docs.map((d) => Y.encodeStateAsUpdate(d));
  for (const target of docs) for (const u of updates) Y.applyUpdate(target, u);
}

describe('P6F-1 CRITICAL — genuine-seat resolution converges across replicas (shared-state, not wrapper-local)', () => {
  it('a LATE JOINER projects the GENUINE body, not a colliding block@0 — it matches the author', () => {
    // The author seeds a trusted line. A LOW clientID makes its item identity the earliest,
    // so the deterministic winner is the genuine seat (the convergent-but-not-secure rule).
    const author = new ConversationDoc(new Y.Doc());
    author.doc.clientID = 1;
    author.seed([{ id: 't', time: '10:00', kind: 'agent', who: 'hexi', text: 'the genuine reading' }]);

    // A separate attacker (a HIGHER clientID) catches up, then seats a colliding body AND a
    // colliding index element BOTH at document POSITION 0 — the "hide the genuine content" attack.
    const attacker = new ConversationDoc(new Y.Doc());
    attacker.doc.clientID = 9;
    Y.applyUpdate(attacker.doc, Y.encodeStateAsUpdate(author.doc));
    attacker.doc.transact(() => {
      const frag = attacker.contentFragment();
      const block = new Y.XmlElement('message');
      const xtext = new Y.XmlText();
      frag.insert(0, [block]); // FRONT
      block.setAttribute('mid', 't');
      block.insert(0, [xtext]);
      xtext.insert(0, 'HIDDEN IMPOSTER BODY');
      attacker.doc
        .getArray<string>('messages')
        .insert(0, [JSON.stringify({ id: 't', time: '99:99', kind: 'agent', who: 'MALLORY' })]);
    });

    // A LATE joiner boots and catches up from the MERGED hub state (author ⊕ attacker).
    // On base its per-instance maps are EMPTY, so it falls to first-in-document-order → the
    // imposter@0. After the fix it resolves the earliest item identity → the genuine seat.
    const late = new ConversationDoc(new Y.Doc());
    late.doc.clientID = 42;
    mergeAll([author.doc, attacker.doc, late.doc]);

    // CONVERGENCE: every replica projects the IDENTICAL genuine content — never the imposter.
    for (const replica of [author, attacker, late]) {
      expect(textOfId(replica, 't')).toBe('the genuine reading');
      expect(replica.messages().find((m) => m.id === 't')?.who).toBe('hexi'); // genuine metadata
      expect(replica.messages().filter((m) => m.id === 't')).toHaveLength(1); // id-unique
      expect(replica.messages().some((m) => m.text?.includes('HIDDEN'))).toBe(false);
    }
    // The SHARED-STATE message projection is byte-identical across the late joiner and the
    // author — no divergence. (Trust flags are DELIBERATELY local-seed-only: a late joiner
    // shows everything unverified until P6F-2's authenticated transport supplies authorship;
    // convergence here is a property of the CONTENT model, not of the local trust map.)
    expect(late.messages()).toEqual(author.messages());
  });

  it('two OFFLINE clients that seat the SAME id converge to ONE identical model on merge', () => {
    // Both clients seat the same id OFFLINE with DIFFERENT bodies (no network yet). On base,
    // each resolves its OWN seated block via its per-instance map → DIVERGENT models after
    // merge. The shared-state rule makes both pick the earliest item identity (client 1).
    const a = new ConversationDoc(new Y.Doc());
    a.doc.clientID = 1;
    const b = new ConversationDoc(new Y.Doc());
    b.doc.clientID = 2;
    a.seed([{ id: 'x', time: '10:00', kind: 'agent', who: 'hexi', text: 'A-side body' }]);
    b.seed([{ id: 'x', time: '10:00', kind: 'agent', who: 'hexi', text: 'B-side body' }]);

    mergeAll([a.doc, b.doc]);

    // CONVERGENCE: identical SHARED-STATE message projection on both replicas — no divergence.
    // (Only the CONTENT model converges; b projects A-side content but marks it unverified,
    // since its local trust map fingerprinted its OWN B-side seed — the convergent-but-not-
    // secure boundary. Cross-replica authorship is P6F-2's authenticated transport, not this.)
    expect(a.messages()).toEqual(b.messages());
    expect(textOfId(a, 'x')).toBe('A-side body'); // earliest item identity (client 1), everywhere
    expect(a.messages().filter((m) => m.id === 'x')).toHaveLength(1);
    expect(b.messages().filter((m) => m.id === 'x')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. P6F-1 round-3 (MEDIUM, content-hiding) — the genuine BODY CHILD is identity-
//    resolved too, so an imposter Y.XmlText at CHILD index 0 INSIDE the genuine
//    block cannot hide the genuine child.
//
// The round-2 fix resolved the outer block/index by earliest item identity, but the
// body still selected `block.get(0)` and the reader path hardcoded child index 0. A
// peer that inserts an imposter Y.XmlText at child index 0 INSIDE the genuine block
// pushes the genuine child to index 1, so ALL replicas converged on the imposter's
// content (content-hiding — convergent but attacker-selected). Trust correctly demotes
// to `unknown` (no forged ✓), but no-content-hiding is its own requirement. The child
// is now resolved by the SAME earliest-Yjs-item-id rule, at BOTH `body()` and
// `bodyPath()`. Each assertion FAILS on base 75e0d6d (every replica projects the
// imposter child) and passes now.
// ─────────────────────────────────────────────────────────────────────────────

describe('P6F-1 round-3 MEDIUM — the genuine BODY CHILD is identity-resolved (imposter child@0 cannot hide it)', () => {
  it('an imposter Y.XmlText at CHILD index 0 inside the genuine block cannot hide the genuine child — author, peer, and late joiner all project the GENUINE content', () => {
    // The author seeds a trusted line with a LOW clientID, so the genuine child carries the
    // earliest item identity (the convergent winner).
    const author = new ConversationDoc(new Y.Doc());
    author.doc.clientID = 1;
    author.seed([
      { id: 't', time: '10:00', kind: 'agent', who: 'hexi', text: 'the genuine reading' },
    ]);

    // A separate peer (a HIGHER clientID) catches up, then inserts an imposter Y.XmlText at
    // CHILD index 0 INSIDE the genuine, identity-resolved block. The genuine child slides to
    // index 1, so a positional `block.get(0)` / hardcoded reader child index 0 would surface
    // the imposter on every replica (the content-hide). The imposter's insert has a LATER
    // clock than the genuine seat, so the earliest-item-id rule keeps the genuine child.
    const peer = new ConversationDoc(new Y.Doc());
    peer.doc.clientID = 9;
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(author.doc));
    peer.doc.transact(() => {
      const block = peer.contentFragment().get(0) as Y.XmlElement; // the genuine block
      const imposter = new Y.XmlText();
      block.insert(0, [imposter]); // CHILD index 0 — pushes the genuine child to index 1
      imposter.insert(0, 'HIDDEN IMPOSTER CHILD');
    });

    // A LATE joiner boots and catches up from the MERGED state (author ⊕ peer).
    const late = new ConversationDoc(new Y.Doc());
    late.doc.clientID = 42;
    mergeAll([author.doc, peer.doc, late.doc]);

    // CONVERGENCE on the GENUINE child: author, peer, AND late joiner all project it — never
    // the imposter — through both `body()` (direct child) and `messages()` (projected text).
    for (const replica of [author, peer, late]) {
      expect(replica.body('t')?.toString()).toBe('the genuine reading');
      expect(textOfId(replica, 't')).toBe('the genuine reading');
      expect(replica.messages().some((m) => m.text?.includes('HIDDEN'))).toBe(false);
      // The reader path resolves to the genuine child (child index != 0 here), so a covenant
      // capture / the trust fingerprint digests the GENUINE body, not the imposter@0.
      const path = replica.bodyPath('t');
      expect(path).not.toBeNull();
      expect((path as number[])[1]).not.toBe(0); // the genuine child is no longer at child index 0
    }
    // The shared-state message projection is byte-identical across replicas — no divergence.
    expect(late.messages()).toEqual(author.messages());
    expect(peer.messages()).toEqual(author.messages());
  });

  it('MUTATION PIN — with NO imposter child, the genuine child resolves and reads OK (the resolution is load-bearing, not a blanket reject)', () => {
    // Proves the no-hiding above is caused by the identity resolution picking the genuine
    // child, not by an incidental refusal: a clean single-child body still resolves, and its
    // reader path points at child index 0 (the sole genuine child).
    const convo = seedTrustedAgent('the genuine reading');
    expect(convo.body('t')?.toString()).toBe('the genuine reading');
    expect(convo.bodyPath('t')).toEqual([0, 0]);
    // A covenant capture over the genuine child reads OK (the child is resolvable).
    const reader = readerFor(convo, 't', { start: 0, end: 3 });
    expect(status(reader, certify(reader))).toBe('ok');
  });
});

// A convenience so the append-only ChatMsg shape stays honest under type-checking.
const _typecheck: ChatMsg = { id: 'x', time: '0', kind: 'human' };
void _typecheck;
