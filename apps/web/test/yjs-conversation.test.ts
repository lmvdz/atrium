import { describe, expect, it } from 'vitest';
import { Doc as YDoc } from 'yjs';
import { conversationModel } from '../app/prototype/conversation-model';
import { InMemoryConversationHub } from '../app/prototype/conversation-transport';
import type { ChatMsg, Selection } from '../app/prototype/types';
import {
  ConversationDoc,
  conversationDocFor,
  conversationModelFromDoc,
  participantsForSelection,
  roomFor,
} from '../app/prototype/yjs-conversation';
import { glyphFor } from '../src/components/model/glyph';

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
      // Deep equality across room, records, items, and participants — the whole
      // surface contract. If the Yjs round-trip dropped or reshaped any field,
      // this fails.
      expect(fromDoc).toEqual(fromMock);
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

  it('a TRUSTED seed still derives ✓ — the seam keeps its legitimate certification', () => {
    // seed() is the trusted local source (the fixture route), so its certification
    // is honoured through the non-CRDT authority — proving the fix strips forgery,
    // not legitimate certification.
    const doc = new ConversationDoc().seed([
      { id: 'settled', time: '10:00', kind: 'system', text: 'landed', certified: true },
    ]);
    const system = doc.model('r', []).items.find((i) => i.kind === 'system');
    if (system?.kind !== 'system') throw new Error('unreachable');
    expect(glyphFor(system.entry.state)).toBe('✓');
    // …and even so, the DURABLE payload carries no authority — a peer replicating
    // this doc receives content only.
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
  it('a peer append under a SEEDED certified id stays de-authenticated, never ✓', () => {
    // The trusted fixture seeds a certified system line under `trusted-id`.
    const doc = new ConversationDoc().seed([
      { id: 'trusted-id', time: '10:00', kind: 'system', text: 'landed', certified: true },
    ]);
    // Sanity: the genuine seeded line IS `✓` on the trusted path.
    const seeded = doc
      .model('r', [])
      .items.flatMap((i) => (i.kind === 'system' ? [glyphFor(i.entry.state)] : []));
    expect(seeded).toEqual(['✓']);

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
    // Exactly ONE `✓` — the genuine seeded content, matched by content fingerprint.
    const certified = model.items.flatMap((i) =>
      i.kind === 'system' && glyphFor(i.entry.state) === '✓' ? [i] : [],
    );
    expect(certified).toHaveLength(1);
    // The forged content is present but DE-AUTHENTICATED: a plain unverified
    // message (authorKind 'unknown'), never a certified system row.
    const forged = model.records.find((r) => r.text.includes('FORGED'));
    expect(forged?.authorKind).toBe('unknown');
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

// A small fixed conversation used by the projection-convergence test above.
function seedMessagesFor(): readonly ChatMsg[] {
  return [
    { id: 's1', time: '10:00', kind: 'system', text: 'plan opened' },
    { id: 's2', time: '10:01', kind: 'human', who: 'you', text: 'do the thing in `billing`' },
    { id: 's3', time: '10:02', kind: 'agent', who: 'hexi', text: 'on it' },
  ];
}
