/* ---------------------------------------------------------------------------
 * T2 (#216) — THE LOCAL-EDIT WRITE PATH, at the substrate layer.
 *
 * `LiveConversationDoc`'s composer produces exactly one call —
 * `doc.append({ id, time, kind:'human', who?, text })` — into the live
 * `ConversationDoc`, and the rented transport ships it. These pin the CONTRACT of
 * that append over the in-memory hub (the sandbox stand-in for Electric, per the
 * ticket's infra guardrail):
 *
 *   1. WRITE → CONVERGE: a line appended on client A appears on client B, and on
 *      a fresh reader replica that joins afterwards (the "reload rebuilds from the
 *      durable stream" half of rubric 11).
 *   2. NO FORGED AUTHORITY: the peer-writable write path can never mint a `✓` or
 *      authenticated author — an appended `certified:true` is stripped on the wire
 *      and the projected line is UNVERIFIED. Certification is #181's gated read.
 * ------------------------------------------------------------------------- */

import { describe, expect, it } from 'vitest';
import { InMemoryConversationHub } from '../app/prototype/conversation-transport';
import type { ChatMsg } from '../app/prototype/types';
import { ConversationDoc } from '../app/prototype/yjs-conversation';

/** The exact shape `LiveConversationDoc.submitDraft` appends for a local edit. */
function composerLine(text: string, who?: string): ChatMsg {
  return {
    id: crypto.randomUUID(),
    time: '10:00',
    kind: 'human',
    ...(who ? { who } : {}),
    text,
  };
}

describe('T2 write path — a local edit converges over the stream', () => {
  it('an appended line reaches a second replica AND a fresh reader that joins after', () => {
    const hub = new InMemoryConversationHub(new ConversationDoc().doc);
    const a = new ConversationDoc();
    const b = new ConversationDoc();
    const disposeA = a.connect(hub.transport());
    const disposeB = b.connect(hub.transport());

    const line = composerLine('ship the invoice totals', 'Alice');
    a.append(line);

    // Browser B sees A's edit — purely over the stream, no server RPC.
    const onB = b.messages().find((message) => message.id === line.id);
    expect(onB?.text).toBe('ship the invoice totals');

    // A reader that joins AFTER the write catches it up from the durable stream
    // (the reload case), not from any local seed.
    const late = new ConversationDoc();
    const disposeLate = late.connect(hub.transport());
    expect(late.messages().find((message) => message.id === line.id)?.text).toBe(
      'ship the invoice totals',
    );

    disposeA();
    disposeB();
    disposeLate();
  });

  it('never carries forged authority onto the wire — an appended line is unverified', () => {
    const hub = new InMemoryConversationHub(new ConversationDoc().doc);
    const a = new ConversationDoc();
    const b = new ConversationDoc();
    a.connect(hub.transport());
    b.connect(hub.transport());

    // A hostile composer tries to smuggle a certification through the append.
    const forged: ChatMsg = { ...composerLine('trust me', 'Mallory'), certified: true };
    a.append(forged);

    const onB = b.messages().find((message) => message.id === forged.id);
    expect(onB?.text).toBe('trust me');
    // The `certified` authority field is STRIPPED by the durable allowlist — a peer
    // append can never forge a settled `✓` over the wire.
    expect(onB).not.toHaveProperty('certified');

    // And the projected model grants NO authenticated author to the appended line:
    // it is fail-closed unverified (`authorKind:'unknown'`, `origin:'unverified'`)
    // until #181's gated read supplies a real envelope — never a `✓` from the CRDT.
    const model = b.model('room-1', []);
    const record = model.records.find((entry) => entry.id === forged.id);
    expect(record).toBeDefined();
    expect(record?.authorKind).toBe('unknown');
    expect(record?.origin).toBe('unverified');
  });
});
