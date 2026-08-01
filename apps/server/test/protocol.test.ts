import type { IncomingMessage } from 'node:http';
import { coreEventTypes } from '@atrium/db';
import { describe, expect, it } from 'vitest';
import { Command } from '../src/commands.js';
import { ClientFrame } from '../src/protocol.js';
import { declaredRoomId, isCoreEvent, RoomEvent } from '../src/room-events.js';
import { createStubSessionAuthenticator } from '../src/session.js';

/**
 * The wire contract and the ledger's event union, checked without a database.
 * These are the parts a malformed frame reaches first.
 */

const at = '2026-07-31T12:00:00.000Z';
const actor = { kind: 'human', userId: 'u1' } as const;

describe('the ledger event union', () => {
  it('folds exactly @atrium/core’s five types, and no more', () => {
    const core = [
      { id: 'e1', at, actor, type: 'proposal_recorded' },
      { id: 'e2', at, actor, type: 'proposal_rejected' },
      { id: 'e3', at, actor, type: 'object_accepted' },
      { id: 'e4', at, actor, type: 'object_corrected' },
      { id: 'e5', at, actor, type: 'relation_added' },
    ].map((e) => e.type);
    expect(core.sort()).toEqual([...coreEventTypes].sort());
  });

  it('treats message_posted and attention_resolved as ledger-only', () => {
    const message = RoomEvent.parse({
      id: 'e1',
      at,
      actor,
      type: 'message_posted',
      roomId: 'r1',
      messageId: 'm1',
      body: 'hello',
    });
    expect(isCoreEvent(message)).toBe(false);
    expect(declaredRoomId(message)).toBe('r1');

    const attention = RoomEvent.parse({
      id: 'e2',
      at,
      actor,
      type: 'attention_resolved',
      roomId: 'r1',
      attentionId: 'a1',
      status: 'dismissed',
    });
    expect(isCoreEvent(attention)).toBe(false);
    expect(declaredRoomId(attention)).toBe('r1');
  });

  it('refuses presence — it is not a kind of event at all (#14)', () => {
    expect(
      RoomEvent.safeParse({ id: 'e1', at, actor, type: 'presence_changed', roomId: 'r1' }).success,
    ).toBe(false);
  });

  it('leaves the room of a correction or a rejection to be resolved from state', () => {
    const corrected = RoomEvent.parse({
      id: 'e1',
      at,
      actor,
      type: 'object_corrected',
      objectId: 'o1',
      action: 'retract',
    });
    expect(declaredRoomId(corrected)).toBeNull();

    const rejected = RoomEvent.parse({
      id: 'e2',
      at,
      actor,
      type: 'proposal_rejected',
      proposalId: 'p1',
    });
    expect(declaredRoomId(rejected)).toBeNull();
  });

  it('requires a canonical timestamp with an offset', () => {
    const bad = RoomEvent.safeParse({
      id: 'e1',
      at: 'yesterday',
      actor,
      type: 'message_posted',
      roomId: 'r1',
      messageId: 'm1',
      body: 'hello',
    });
    expect(bad.success).toBe(false);
  });
});

describe('ClientFrame', () => {
  it('accepts the six #12 commands plus the two this ticket adds', () => {
    const names = [
      'send_message',
      'accept_proposal',
      'correct',
      'answer_bind',
      'resolve_attention',
      'set_presence',
      'record_proposal',
      'reject_proposal',
      'set_typing',
      'advance_seen',
    ];
    const declared = Command.options.map((option) => option.shape.name.value);
    expect([...declared].sort()).toEqual([...names].sort());
  });

  it('refuses an empty message body', () => {
    const frame = ClientFrame.safeParse({
      type: 'command',
      commandId: 'c1',
      command: { name: 'send_message', roomId: 'r1', body: '' },
    });
    expect(frame.success).toBe(false);
  });

  it('refuses a negative since cursor before it reaches the database', () => {
    expect(ClientFrame.safeParse({ type: 'since', roomId: 'r1', roomSeq: -1 }).success).toBe(false);
    expect(ClientFrame.safeParse({ type: 'since', roomId: 'r1', roomSeq: 0 }).success).toBe(true);
  });

  it('caps a catch-up page so one frame cannot ask for the whole log', () => {
    expect(
      ClientFrame.safeParse({ type: 'since', roomId: 'r1', roomSeq: 0, limit: 5000 }).success,
    ).toBe(false);
  });

  it('defaults the optional halves of send_message rather than demanding them', () => {
    const frame = ClientFrame.parse({
      type: 'command',
      commandId: 'c1',
      command: { name: 'send_message', roomId: 'r1', body: 'hi' },
    });
    expect(frame).toMatchObject({
      command: { clientMessageId: null, replyToId: null, attachments: [] },
    });
  });
});

describe('the #26 session stub', () => {
  const auth = createStubSessionAuthenticator();
  const request = (headers: Record<string, string>, url = '/ws') =>
    ({ headers, url }) as unknown as IncomingMessage;

  it('reads the user from a header', async () => {
    await expect(auth.authenticateUpgrade(request({ 'x-atrium-user': 'u1' }))).resolves.toEqual({
      userId: 'u1',
      method: 'stub',
    });
  });

  it('reads it from the query string, which is all a browser socket can send', async () => {
    await expect(auth.authenticateUpgrade(request({}, '/ws?user=u2'))).resolves.toMatchObject({
      userId: 'u2',
    });
  });

  it('refuses an unidentified socket rather than inventing an anonymous one', async () => {
    // A default identity would make every membership check downstream vacuous
    // the first time somebody forgot to pass a user.
    await expect(auth.authenticateUpgrade(request({}))).resolves.toBeNull();
    await expect(auth.authenticateUpgrade(request({ 'x-atrium-user': '   ' }))).resolves.toBeNull();
    await expect(auth.authenticateUpgrade(request({}, '/ws?user='))).resolves.toBeNull();
  });
});
