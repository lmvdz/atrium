import { describe, expect, it } from 'vitest';
import { Doc as YDoc } from 'yjs';
import { conversationModel } from '../app/prototype/conversation-model';
import { InMemoryConversationHub } from '../app/prototype/conversation-transport';
import type { ChatMsg, Selection } from '../app/prototype/types';
import {
  conversationDocFor,
  conversationModelFromDoc,
  participantsForSelection,
  roomFor,
} from '../app/prototype/yjs-conversation-fixtures';
import { ConversationDoc } from '../app/prototype/yjs-conversation';
import { glyphFor } from '../src/components/model/glyph';
import { messageLedger } from '../src/components/model/quotation';

/**
 * #183 — the conversation re-seated on a Yjs document over a rented transport.
 *
 * Two things must hold, and both are proven here without any Electric
 * infrastructure (the durable stream needs Postgres logical replication we
 * cannot stand up in the sandbox — the in-memory hub is the stand-in the ticket's
 * infra guardrail calls for):
 *
 *   1. COMPONENTS DO NOT KNOW THE DIFFERENCE. The Yjs-backed model is
 *      byte-identical to the mock `conversationModel` for the same selection.
 *   2. TWO CLIENTS CONVERGE. Independent docs joined to one stream see each
 *      other's messages and settle on one identical feed — Yjs's merge, which we
 *      rent; we never wrote merge logic.
 */

const SELECTIONS: readonly Selection[] = [
  { kind: 'session', id: 's-live' },
  { kind: 'session', id: 's-scout' },
  { kind: 'session', id: 's-rank' },
  { kind: 'session', id: 's-audit' },
];

describe('the Yjs-backed model equals the mock model (components do not know the difference)', () => {
  for (const selection of SELECTIONS) {
    it(`matches conversationModel for ${selection.id}`, () => {
      const fromMock = conversationModel(selection);
      const fromDoc = conversationModelFromDoc(conversationDocFor(selection), selection);
      // Deep equality across room, records, and participants — the whole surface
      // contract. Records carry authenticated who/kind/actor/origin, so this proves
      // the Yjs round-trip drops or reshapes NO content field and keeps the seeded
      // fixture's authorship.
      expect(fromDoc.room).toEqual(fromMock.room);
      expect(fromDoc.participants).toEqual(fromMock.participants);
      expect(fromDoc.records).toEqual(fromMock.records);
      // Items are identical in id and kind and order…
      expect(fromDoc.items.map((i) => [i.id, i.kind])).toEqual(
        fromMock.items.map((i) => [i.id, i.kind]),
      );
      // …with ONE intended divergence (#183 round-3): the CRDT path derives NO `✓`.
      // Certification is #181's gated read (bound to #180's server-minted anchor),
      // never a value the peer-writable doc can mint. A mock `✓` on a certified
      // line becomes a `~` on the doc — the honest "settled, not certified".
      const docSystemGlyphs = fromDoc.items.flatMap((i) =>
        i.kind === 'system' ? [glyphFor(i.entry.state)] : [],
      );
      expect(docSystemGlyphs).not.toContain('✓');
      // Every non-system item is byte-identical (turn/image/message shells intact).
      expect(fromDoc.items.filter((i) => i.kind !== 'system')).toEqual(
        fromMock.items.filter((i) => i.kind !== 'system'),
      );
    });
  }

  it('round-trips a ChatMsg losslessly through the durable array element', () => {
    const message: ChatMsg = {
      id: 'x1',
      time: '09:00',
      kind: 'agent',
      who: 'hexi',
      turn: {
        summary: 'did a thing',
        spend: '$0.01',
        steps: [{ kind: 'read', text: '`a.ts` · 10 lines' }],
        conclusion: { text: 'done', reply: { who: 'you', text: 'thanks' } },
      },
    };
    const doc = new ConversationDoc().seed([message]);
    expect(doc.messages()).toEqual([message]);
  });
});

describe('two clients converge over the in-memory transport (rented Yjs merge)', () => {
  it('a message one client appends appears on the other', () => {
    const hub = new InMemoryConversationHub(new YDoc());
    const clientA = new ConversationDoc();
    const clientB = new ConversationDoc();
    const disconnectA = clientA.connect(hub.transport());
    const disconnectB = clientB.connect(hub.transport());

    const said: ChatMsg = { id: 'm1', time: '10:00', kind: 'human', who: 'you', text: 'hello' };
    clientA.append(said);

    // B saw A's message with no explicit sync call — the transport relayed the
    // opaque update and Yjs applied it.
    expect(clientB.messages()).toEqual([said]);

    disconnectA();
    disconnectB();
  });

  it('concurrent appends from both clients converge to one identical feed', () => {
    const hub = new InMemoryConversationHub(new YDoc());
    const clientA = new ConversationDoc();
    const clientB = new ConversationDoc();
    clientA.connect(hub.transport());
    clientB.connect(hub.transport());

    const fromA: ChatMsg = { id: 'a', time: '11:00', kind: 'human', who: 'you', text: 'from A' };
    const fromB: ChatMsg = { id: 'b', time: '11:01', kind: 'agent', who: 'hexi', text: 'from B' };
    clientA.append(fromA);
    clientB.append(fromB);

    // Both docs hold both messages, in the SAME converged order — Yjs decides
    // that order deterministically; the test only asserts the two agree.
    const a = clientA.messages();
    const b = clientB.messages();
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
    expect(a.map((m) => m.id).sort()).toEqual(['a', 'b']);
  });

  it('a late joiner is caught up to the stream, then stays live', () => {
    const hub = new InMemoryConversationHub(new YDoc());
    const early = new ConversationDoc();
    early.connect(hub.transport());
    early.append({ id: 'h1', time: '12:00', kind: 'human', who: 'you', text: 'history' });

    // A client that joins AFTER the history was written is caught up from the
    // stream on connect.
    const late = new ConversationDoc();
    late.connect(hub.transport());
    expect(late.messages().map((m) => m.id)).toEqual(['h1']);

    // …and thereafter converges live in both directions.
    late.append({ id: 'l1', time: '12:01', kind: 'agent', who: 'mira', text: 'catch-up' });
    expect(
      early
        .messages()
        .map((m) => m.id)
        .sort(),
    ).toEqual(['h1', 'l1']);
  });

  it('CONTENT converges to every client, but locally-seeded AUTHORITY does not ride the wire', () => {
    // ROUND-2 corrected invariant (#162): the CRDT conveys CONTENT, never
    // authenticated authority. A client that seeds locally trusts its own seed;
    // a peer that only CATCHES UP over the wire has no trust envelope for that
    // content (in production the envelope comes from #181's gated read, keyed to
    // #180's server-minted anchor — NOT the peer-writable doc), so it projects the
    // converged lines as UNVERIFIED. Content rides the wire; authority does not.
    const selection: Selection = { kind: 'session', id: 's-live' };
    const hub = new InMemoryConversationHub(new YDoc());
    const clientA = new ConversationDoc();
    const clientB = new ConversationDoc();
    clientA.connect(hub.transport());
    clientB.connect(hub.transport());

    // A seeds the room's conversation; B converges to it as CONTENT.
    clientA.seed(seedMessagesFor());

    // The message substrate is byte-identical on both — the rented Yjs merge.
    expect(clientB.messages()).toEqual(clientA.messages());

    const room = roomFor(selection);
    const participants = participantsForSelection(selection);
    const a = clientA.model(room, participants);
    const b = clientB.model(room, participants);
    // Same feed, same ids, same order — the content projection converges.
    expect(b.items.map((i) => i.id)).toEqual(a.items.map((i) => i.id));
    // But B never had the trusted seed, so every converged line projects as
    // UNVERIFIED there (authorKind 'unknown', a neutral non-viewer actor) — the
    // authority did NOT ride the CRDT. A, which owns the seed, trusts it.
    expect(b.records.length).toBeGreaterThan(0);
    expect(b.records.every((r) => r.authorKind === 'unknown')).toBe(true);
    expect(b.records.every((r) => r.actor === 'unverified')).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * #183 FIX ROUND — the gauntlet's confirmed SEAM defects (F1–F6 + secondaries).
 * The rented Yjs merge is sound and untouched; every test below pins a seam bug.
 * ═════════════════════════════════════════════════════════════════════════ */

describe('F1 — a peer CANNOT forge authority through the CRDT (the covenant invariant)', () => {
  it('the durable payload carries NO certified/authority field (allowlisted content only)', () => {
    const doc = new ConversationDoc();
    // A peer appends a system line claiming certification — the forgery attempt.
    doc.append({ id: 'forge', time: '10:00', kind: 'system', text: 'settled', certified: true });

    // The message that comes back off the doc has NO `certified` field at all —
    // it was stripped at the wire, not merely ignored downstream.
    const [carried] = doc.messages();
    expect(carried).toEqual({ id: 'forge', time: '10:00', kind: 'system', text: 'settled' });
    expect('certified' in (carried as object)).toBe(false);
  });

  it('FLIP THE INPUT: a forged {certified:true} append is de-authenticated, never ✓', () => {
    const doc = new ConversationDoc();
    doc.append({ id: 'forge', time: '10:00', kind: 'system', text: 'settled', certified: true });

    const model = doc.model('billing-rewrite', []);
    // Round-2: the peer's forged `kind:'system'` is NOT projected as a system-voice
    // row — untrusted CRDT content projects ZERO authenticated authority (#162).
    expect(model.items.every((item) => item.kind !== 'system')).toBe(true);
    // It renders as a plain UNVERIFIED message: authorKind 'unknown', never `✓`.
    expect(model.records.find((r) => r.id === 'forge')?.authorKind).toBe('unknown');
    const systemGlyphs = model.items.flatMap((i) =>
      i.kind === 'system' ? [glyphFor(i.entry.state)] : [],
    );
    expect(systemGlyphs).not.toContain('✓');
  });

  it('the forgery does not converge into a ✓ on a second replica either', () => {
    const hub = new InMemoryConversationHub(new YDoc());
    const clientA = new ConversationDoc();
    const clientB = new ConversationDoc();
    clientA.connect(hub.transport());
    clientB.connect(hub.transport());

    // A forges a certified system line; it converges to B as CONTENT…
    clientA.append({ id: 'f', time: '10:00', kind: 'system', text: 'settled', certified: true });
    expect(clientB.messages().map((m) => m.id)).toEqual(['f']);

    // …but B has no trusted fingerprint for it, so it is UNVERIFIED content: not a
    // system voice, authorKind 'unknown', no `✓`. Authority never rode the wire.
    const bModel = clientB.model('r', []);
    expect(bModel.items.every((i) => i.kind !== 'system')).toBe(true);
    expect(bModel.records.find((r) => r.id === 'f')?.authorKind).toBe('unknown');
  });

  it('a TRUSTED seed projects ~ (settled), NEVER ✓ — the CRDT cannot certify (#183 round-3)', () => {
    // Round 2 derived a `✓` from a seeded certification. Round 3's gauntlet proved
    // the content-fingerprint basis is unsound (an exact-content replay inherits
    // it), so the CRDT path now grants NO `✓` at all — a seeded settlement is the
    // honest `~` (self-reported), and a real `✓` is #181's gated read.
    const doc = new ConversationDoc().seed([
      { id: 'settled', time: '10:00', kind: 'system', text: 'landed', certified: true },
    ]);
    const system = doc.model('r', []).items.find((i) => i.kind === 'system');
    if (system?.kind !== 'system') throw new Error('unreachable');
    expect(glyphFor(system.entry.state)).toBe('~');
    expect(glyphFor(system.entry.state)).not.toBe('✓');
    // …and the DURABLE payload carries no authority — a peer replicating this doc
    // receives content only.
    expect('certified' in (doc.messages()[0] as object)).toBe(false);
  });
});

describe('F2 — join/reconnect converges with EVERY peer, not just the server doc', () => {
  it('a client that joins holding LOCAL work converges with an already-connected peer', () => {
    const hub = new InMemoryConversationHub(new YDoc());
    const clientA = new ConversationDoc();
    clientA.connect(hub.transport());
    clientA.append({ id: 'a1', time: '10:00', kind: 'human', who: 'you', text: 'from A' });

    // B builds a local line BEFORE connecting, then joins.
    const clientB = new ConversationDoc();
    clientB.append({
      id: 'b1',
      time: '10:01',
      kind: 'agent',
      who: 'hexi',
      text: 'from B, offline',
    });
    clientB.connect(hub.transport());

    // Full-mesh on join: A learns B's pre-connect line (the bug left A blind to it),
    // and B is caught up to A. Both converge to the same set.
    const ids = (doc: ConversationDoc) =>
      doc
        .messages()
        .map((m) => m.id)
        .sort();
    expect(ids(clientA)).toEqual(['a1', 'b1']);
    expect(ids(clientB)).toEqual(['a1', 'b1']);
  });

  it('a client that edits OFFLINE then RECONNECTS converges with every peer', () => {
    const hub = new InMemoryConversationHub(new YDoc());
    const clientA = new ConversationDoc();
    const clientB = new ConversationDoc();
    clientA.connect(hub.transport());
    const disconnectB = clientB.connect(hub.transport());
    clientA.append({ id: 'a1', time: '10:00', kind: 'human', who: 'you', text: 'hi' });
    expect(clientB.messages().map((m) => m.id)).toEqual(['a1']);

    // B goes offline and writes a line no one has seen.
    disconnectB();
    clientB.append({
      id: 'b-offline',
      time: '10:05',
      kind: 'human',
      who: 'you',
      text: 'while away',
    });
    expect(clientA.messages().map((m) => m.id)).toEqual(['a1']); // A cannot see it yet

    // B reconnects: its offline edit fans to the server AND to A.
    clientB.connect(hub.transport());
    const ids = (doc: ConversationDoc) =>
      doc
        .messages()
        .map((m) => m.id)
        .sort();
    expect(ids(clientA)).toEqual(['a1', 'b-offline']);
    expect(ids(clientB)).toEqual(['a1', 'b-offline']);
  });
});

describe('F3 — independently joining clients do NOT duplicate history', () => {
  it('two clients catching up from a seeded stream converge to ONE copy', () => {
    const hub = new InMemoryConversationHub(new YDoc());

    // The production path: an originator puts the history on the stream once…
    const originator = new ConversationDoc();
    originator.connect(hub.transport());
    for (const m of seedMessagesFor()) originator.append(m);

    // …and later clients join UNSEEDED and catch up (they must NOT re-seed).
    const clientA = new ConversationDoc();
    const clientB = new ConversationDoc();
    clientA.connect(hub.transport());
    clientB.connect(hub.transport());

    const historyIds = seedMessagesFor().map((m) => m.id);
    // Exactly one copy each — no duplicated ids, matching the originator.
    expect(clientA.messages().map((m) => m.id)).toEqual(historyIds);
    expect(clientB.messages().map((m) => m.id)).toEqual(historyIds);
    // And no duplicate-key hazard: ids are unique.
    expect(new Set(clientA.messages().map((m) => m.id)).size).toBe(historyIds.length);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * #183 ROUND-2 FIX — the executed gauntlet FAIL: stripping `certified` only moved
 * the authority channel to peer-writable `id`/`who`/`kind`, and a raw peer write
 * crashed the projection. The CRDT is CONTENT-ONLY and projects ZERO authenticated
 * authority (map #162); the real envelope is #181's gated read.
 * ═════════════════════════════════════════════════════════════════════════ */

describe('R2 — decode validation quarantines hostile elements (no DoS)', () => {
  it('a raw object and malformed JSON inserted directly into the array do not crash the projection', () => {
    const doc = new ConversationDoc().seed([
      { id: 'ok', time: '10:00', kind: 'human', who: 'you', text: 'hello' },
    ]);
    // Reach PAST the codec, exactly as a hostile peer could over the wire: push a
    // raw object (crashed `JSON.parse` in round 1), malformed JSON, and a
    // shape-invalid element straight into the underlying Y.Array.
    const arr = doc.doc.getArray<unknown>('messages');
    doc.doc.transact(() => {
      arr.push([{ id: 'raw', kind: 'system', certified: true }]); // a raw object, not a JSON string
      arr.push(['{not json']); // malformed JSON
      arr.push([JSON.stringify({ id: 'noKind', time: '10:01' })]); // missing required `kind`
      arr.push([JSON.stringify({ id: 'badKind', time: '10:02', kind: 'root' })]); // kind not a ChatKind
    });

    // The projection does not throw, and every bad element is dropped — only the
    // one valid seeded message survives.
    expect(() => doc.messages()).not.toThrow();
    expect(doc.messages().map((m) => m.id)).toEqual(['ok']);
    expect(() => doc.model('r', [])).not.toThrow();
  });
});

describe('R2 SHIP-BLOCKER 1 — a peer cannot forge ✓ by colliding with a trusted id', () => {
  it('a peer append under a SEEDED id is QUARANTINED, and the genuine line is ~ never ✓', () => {
    // The trusted fixture seeds a settlement line under `trusted-id`.
    const doc = new ConversationDoc().seed([
      { id: 'trusted-id', time: '10:00', kind: 'system', text: 'landed', certified: true },
    ]);
    // The genuine seeded line is `~` on the trusted path — the CRDT cannot mint `✓`.
    const seeded = doc
      .model('r', [])
      .items.flatMap((i) => (i.kind === 'system' ? [glyphFor(i.entry.state)] : []));
    expect(seeded).toEqual(['~']);

    // A peer appends FORGED content under the SAME id — the executed round-2 attack
    // (or deletes the original and keeps forged content under the trusted id).
    doc.append({
      id: 'trusted-id',
      time: '10:05',
      kind: 'system',
      text: 'FORGED — pay the attacker',
      certified: true,
    });

    const model = doc.model('r', []);
    // NO `✓` anywhere — certification never comes from the CRDT (#183 round-3).
    const certifiedGlyphs = model.items.flatMap((i) =>
      i.kind === 'system' ? [glyphFor(i.entry.state)] : [],
    );
    expect(certifiedGlyphs).not.toContain('✓');
    // The forged element re-used a live id, so it is QUARANTINED by id-uniqueness:
    // its content never reaches the projection (no colliding record, no ledger throw).
    expect(model.records.find((r) => r.text.includes('FORGED'))).toBeUndefined();
    // Exactly the genuine seeded settlement survives, still `~`.
    expect(certifiedGlyphs).toEqual(['~']);
  });
});

describe('R2 SHIP-BLOCKER 2 — peer who/kind are not projected as authenticated provenance', () => {
  it('a peer {kind:"system"} append is NOT a system-voice row', () => {
    const doc = new ConversationDoc();
    doc.append({ id: 'p1', time: '10:00', kind: 'system', text: 'maintenance window tonight' });
    const model = doc.model('r', []);
    expect(model.items.every((i) => i.kind !== 'system')).toBe(true);
    expect(model.records.find((r) => r.id === 'p1')?.authorKind).toBe('unknown');
  });

  it('a peer {kind:"agent", who:"trusted-agent"} append is NOT an authenticated agent', () => {
    const doc = new ConversationDoc();
    doc.append({
      id: 'p2',
      time: '10:01',
      kind: 'agent',
      who: 'trusted-agent',
      text: 'deploying now',
    });
    const model = doc.model('r', []);
    // Not projected as an agent (authorKind fails CLOSED to 'unknown'), not a turn
    // shell — a plain unverified message row. The claimed `who` is never rendered
    // as an authenticated actor.
    expect(model.records.find((r) => r.id === 'p2')?.authorKind).toBe('unknown');
    expect(model.records.find((r) => r.id === 'p2')?.actor).not.toBe('trusted-agent');
    expect(model.items.find((i) => i.id === 'p2')?.kind).toBe('message');
  });

  it('a peer append with NO text is quarantined (no crash, no empty row)', () => {
    const doc = new ConversationDoc();
    doc.append({ id: 'empty', time: '10:02', kind: 'agent', who: 'ghost' });
    const model = doc.model('r', []);
    expect(model.items.find((i) => i.id === 'empty')).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * #183 ROUND-3 FIX — the executed gauntlet FAIL: the r2 decode-fix MOVED the crash
 * rather than closing the class. A well-shaped hostile element (empty id, colliding
 * id) still crashed `model()`/`AttributionLedger` on every replica; the CRDT still
 * granted `✓` to a fingerprint-matched replay. Close it: quarantine any element
 * that is not a fully-valid, unique-id message; make the projection + ledger TOTAL;
 * grant NO `✓` from the CRDT; give untrusted content an honest origin.
 * ═════════════════════════════════════════════════════════════════════════ */

/** Push raw elements PAST the codec, exactly as a hostile peer could over the wire. */
function pushRaw(doc: ConversationDoc, ...elements: unknown[]): void {
  const arr = doc.doc.getArray<unknown>('messages');
  doc.doc.transact(() => {
    for (const el of elements) arr.push([el]);
  });
}

describe('R3 — input-robustness: a well-shaped hostile element cannot crash a replica', () => {
  it('an EMPTY id is quarantined — model() and the AttributionLedger stay total', () => {
    const doc = new ConversationDoc().seed([
      { id: 'ok', time: '10:00', kind: 'human', who: 'you', text: 'hello' },
    ]);
    // `z.string()` admitted `""`; an empty-id row flows into messageEntry→
    // quotationFrom (null) and threw "page-authored … no body of its own".
    pushRaw(doc, JSON.stringify({ id: '', time: '10:01', kind: 'human', who: 'x', text: 'boom' }));

    expect(() => doc.messages()).not.toThrow();
    expect(doc.messages().map((m) => m.id)).toEqual(['ok']); // empty-id dropped
    const model = doc.model('r', []);
    expect(() => doc.model('r', [])).not.toThrow();
    // The ledger the AttributionLedger builds is total — no throw on the record set.
    expect(() => messageLedger(model.records)).not.toThrow();
  });

  it('two elements with the SAME id, DIFFERENT content — the later is quarantined (no ledger throw)', () => {
    const doc = new ConversationDoc().seed([
      { id: 'dup', time: '10:00', kind: 'human', who: 'you', text: 'the original' },
    ]);
    // A second element re-uses the id with different content — two MessageRecords
    // under one id made `messageLedger` throw "two different records claim id" on
    // every client in the room (a converged DoS).
    pushRaw(
      doc,
      JSON.stringify({ id: 'dup', time: '10:05', kind: 'human', who: 'you', text: 'IMPOSTER' }),
    );

    const model = doc.model('r', []);
    // First-wins: exactly one record for the id, the original content; imposter gone.
    expect(model.records.filter((r) => r.id === 'dup')).toHaveLength(1);
    expect(model.records.find((r) => r.id === 'dup')?.text).toBe('the original');
    expect(model.records.some((r) => r.text.includes('IMPOSTER'))).toBe(false);
    expect(() => messageLedger(model.records)).not.toThrow();
  });

  it('malformed nested turn/image shapes are quarantined, not thrown on', () => {
    const doc = new ConversationDoc().seed([
      { id: 'ok', time: '10:00', kind: 'human', who: 'you', text: 'hi' },
    ]);
    pushRaw(
      doc,
      JSON.stringify({ id: 'badturn', time: '10:01', kind: 'agent', who: 'a', turn: 'not-an-object' }),
      JSON.stringify({ id: 'badimg', time: '10:02', kind: 'human', who: 'you', image: 42 }),
    );
    expect(() => doc.model('r', [])).not.toThrow();
    // The two malformed nested shapes are dropped; only the valid seed survives.
    expect(doc.messages().map((m) => m.id)).toEqual(['ok']);
  });

  it('a fuzz-ish batch of hostile elements: projection renders, all bad ones quarantined, NO throw on any replica', () => {
    const hub = new InMemoryConversationHub(new YDoc());
    const clientA = new ConversationDoc();
    const clientB = new ConversationDoc();
    clientA.connect(hub.transport());
    clientB.connect(hub.transport());

    // One genuinely valid line, then a barrage of well-shaped hostile elements.
    clientA.append({ id: 'good', time: '10:00', kind: 'human', who: 'you', text: 'legit' });
    pushRaw(
      clientA,
      { id: 'raw-obj', kind: 'system', certified: true }, // a raw object, not JSON
      '{ not json at all', // malformed JSON
      JSON.stringify({ id: '', time: '1', kind: 'human', text: 'empty id' }), // empty id
      JSON.stringify({ id: 'good', time: '2', kind: 'human', text: 'id collision' }), // dup id
      JSON.stringify({ id: 'nk', time: '3' }), // missing kind
      JSON.stringify({ id: 'bk', time: '4', kind: 'root' }), // bad kind
      JSON.stringify({ id: 'bt', time: '5', kind: 'agent', turn: 7 }), // bad nested turn
      JSON.stringify(null), // a bare null
      JSON.stringify([1, 2, 3]), // a bare array
    );

    // Every replica projects without throwing, and only the one valid line survives.
    for (const client of [clientA, clientB]) {
      expect(() => client.messages()).not.toThrow();
      expect(() => client.model('r', [])).not.toThrow();
      expect(client.messages().map((m) => m.id)).toEqual(['good']);
      expect(() => messageLedger(client.model('r', []).records)).not.toThrow();
    }
  });
});

describe('R3 — the CRDT grants NO ✓ (certification is #181); untrusted content is honestly-provenanced', () => {
  it('a peer replays EXACT certified content under a stolen id → glyph is ~, never ✓', () => {
    // Seed a genuine certified settlement, then have a peer replay the EXACT bytes
    // under the same id — the round-3 codex finding (an exact-content replay matched
    // the trust fingerprint and inherited the `✓`).
    const doc = new ConversationDoc().seed([
      { id: 'anchor', time: '10:00', kind: 'system', text: 'settled by the server', certified: true },
    ]);
    doc.append({ id: 'anchor', time: '10:00', kind: 'system', text: 'settled by the server', certified: true });

    const glyphs = doc
      .model('r', [])
      .items.flatMap((i) => (i.kind === 'system' ? [glyphFor(i.entry.state)] : []));
    // The replay is deduped, and the surviving line derives `~` — NEVER `✓`.
    expect(glyphs).toEqual(['~']);
    expect(glyphs).not.toContain('✓');
  });

  it('an unseeded live doc grants no ✓ to any converged content', () => {
    const hub = new InMemoryConversationHub(new YDoc());
    const clientA = new ConversationDoc();
    const clientB = new ConversationDoc();
    clientA.connect(hub.transport());
    clientB.connect(hub.transport());
    clientA.append({ id: 'c', time: '10:00', kind: 'system', text: 'looks official', certified: true });

    for (const client of [clientA, clientB]) {
      const glyphs = client
        .model('r', [])
        .items.flatMap((i) => (i.kind === 'system' ? [glyphFor(i.entry.state)] : []));
      expect(glyphs).not.toContain('✓');
    }
  });

  it('untrusted CRDT content carries an HONEST origin — "unverified", never "seeded"', () => {
    const doc = new ConversationDoc();
    doc.append({ id: 'p', time: '10:00', kind: 'human', who: 'you', text: 'a peer line' });
    const record = doc.model('r', []).records.find((r) => r.id === 'p');
    expect(record?.origin).toBe('unverified');
    expect(record?.origin).not.toBe('seeded');
  });
});

describe('R3 — lifecycle hardening: a destroyed member does not disturb the live peers', () => {
  // MEASURED FINDING (not fail-on-base): in this Yjs version `applyUpdate` into a
  // destroyed `Y.Doc` is a silent no-op, so grok's "a dead member may ABORT a
  // peer's update" does NOT reproduce as a delivery break here. The `isDestroyed`
  // guard on the hub fan-out is retained as cheap defense-in-depth (it also EVICTS
  // the dead member so the set does not grow unbounded, and it is correct if a
  // future Yjs makes the write throw). This test pins that the hub stays total and
  // the bystander keeps receiving — a regression guard, not reproduced-crash
  // evidence (the observable lifecycle defect is the cross-room leak below).
  it('an author still reaches the live bystander after another member was destroyed mid-flight', () => {
    const hub = new InMemoryConversationHub(new YDoc());
    const switcher = new ConversationDoc();
    const bystander = new ConversationDoc();
    const author = new ConversationDoc();
    switcher.connect(hub.transport());
    bystander.connect(hub.transport());
    author.connect(hub.transport());

    // The switcher changes threads mid-render: its doc is destroyed but still
    // registered in the hub's member set (destroy raced the disconnect).
    switcher.doc.destroy();

    expect(() =>
      author.append({ id: 'x', time: '10:00', kind: 'human', who: 'you', text: 'delivered' }),
    ).not.toThrow();
    expect(bystander.messages().map((m) => m.id)).toContain('x');
    // The dead member was evicted by the guarded fan-out (defense-in-depth).
    author.append({ id: 'y', time: '10:01', kind: 'human', who: 'you', text: 'again' });
    expect(bystander.messages().map((m) => m.id)).toContain('y');
  });
});

// A small fixed conversation used by the projection-convergence test above.
function seedMessagesFor(): readonly ChatMsg[] {
  return [
    { id: 's1', time: '10:00', kind: 'system', text: 'plan opened' },
    { id: 's2', time: '10:01', kind: 'human', who: 'you', text: 'do the thing in `billing`' },
    { id: 's3', time: '10:02', kind: 'agent', who: 'hexi', text: 'on it' },
  ];
}
