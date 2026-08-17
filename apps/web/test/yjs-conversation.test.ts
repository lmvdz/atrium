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

  it('the converged doc projects the same surface model on every client', () => {
    const selection: Selection = { kind: 'session', id: 's-live' };
    const hub = new InMemoryConversationHub(new YDoc());
    const clientA = new ConversationDoc();
    const clientB = new ConversationDoc();
    clientA.connect(hub.transport());
    clientB.connect(hub.transport());

    // A seeds the room's conversation; B converges to it and both project the
    // identical ConversationModel the surface renders.
    clientA.seed(seedMessagesFor());

    const room = roomFor(selection);
    const participants = participantsForSelection(selection);
    expect(clientB.model(room, participants)).toEqual(clientA.model(room, participants));
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

  it('FLIP THE INPUT: a forged {certified:true} append does NOT move the glyph to ✓', () => {
    const doc = new ConversationDoc();
    doc.append({ id: 'forge', time: '10:00', kind: 'system', text: 'settled', certified: true });

    const model = doc.model('billing-rewrite', []);
    const system = model.items.find((item) => item.kind === 'system');
    expect(system, 'the forged line still renders as a system row').toBeDefined();
    if (system?.kind !== 'system') throw new Error('unreachable');
    // The glyph is derived from the NON-CRDT authority (empty here), so it is the
    // routine `·`, NEVER the certified `✓` the peer tried to forge.
    expect(glyphFor(system.entry.state)).not.toBe('✓');
    expect(glyphFor(system.entry.state)).toBe('·');
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

    // …but B has no gated authority for it, so B renders `~`/`·`, not `✓`. Authority
    // never rode the wire — only content did.
    const bSystem = clientB.model('r', []).items.find((i) => i.kind === 'system');
    if (bSystem?.kind !== 'system') throw new Error('unreachable');
    expect(glyphFor(bSystem.entry.state)).not.toBe('✓');
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

// A small fixed conversation used by the projection-convergence test above.
function seedMessagesFor(): readonly ChatMsg[] {
  return [
    { id: 's1', time: '10:00', kind: 'system', text: 'plan opened' },
    { id: 's2', time: '10:01', kind: 'human', who: 'you', text: 'do the thing in `billing`' },
    { id: 's3', time: '10:02', kind: 'agent', who: 'hexi', text: 'on it' },
  ];
}
