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

// A small fixed conversation used by the projection-convergence test above.
function seedMessagesFor(): readonly ChatMsg[] {
  return [
    { id: 's1', time: '10:00', kind: 'system', text: 'plan opened' },
    { id: 's2', time: '10:01', kind: 'human', who: 'you', text: 'do the thing in `billing`' },
    { id: 's3', time: '10:02', kind: 'agent', who: 'hexi', text: 'on it' },
  ];
}
