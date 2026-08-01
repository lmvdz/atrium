import { describe, expect, it } from 'vitest';
import { createHub, type Subscriber } from '../src/hub.js';

/**
 * Fan-out bookkeeping. Small, but it is what a socket close relies on: a hub
 * that leaks a dead subscriber sends into a closed socket forever, and one that
 * leaks an empty room map grows one entry per room ever visited.
 */

function recorder(id: string): Subscriber<string> & { got: string[] } {
  const got: string[] = [];
  return { id, got, send: (frame) => got.push(frame) };
}

describe('createHub', () => {
  it('delivers to every subscriber of a room and nobody else', () => {
    const hub = createHub<string>();
    const a = recorder('a');
    const b = recorder('b');
    const c = recorder('c');
    hub.subscribe('room-1', a);
    hub.subscribe('room-1', b);
    hub.subscribe('room-2', c);

    expect(hub.broadcast('room-1', 'hello')).toBe(2);
    expect(a.got).toEqual(['hello']);
    expect(b.got).toEqual(['hello']);
    expect(c.got).toEqual([]);
  });

  it('is idempotent on re-subscribe — one socket, one delivery', () => {
    const hub = createHub<string>();
    const a = recorder('a');
    hub.subscribe('room-1', a);
    hub.subscribe('room-1', a);
    expect(hub.broadcast('room-1', 'once')).toBe(1);
    expect(a.got).toEqual(['once']);
  });

  it('can exclude one subscriber — the typing-indicator case', () => {
    const hub = createHub<string>();
    const a = recorder('a');
    const b = recorder('b');
    hub.subscribe('room-1', a);
    hub.subscribe('room-1', b);
    expect(hub.broadcastExcept('room-1', 'a', 'typing')).toBe(1);
    expect(a.got).toEqual([]);
    expect(b.got).toEqual(['typing']);
  });

  it('drops a subscriber from every room at once, and forgets the room', () => {
    const hub = createHub<string>();
    const a = recorder('a');
    hub.subscribe('room-1', a);
    hub.subscribe('room-2', a);
    expect(hub.roomsOf('a').sort()).toEqual(['room-1', 'room-2']);

    hub.drop('a');

    expect(hub.roomsOf('a')).toEqual([]);
    expect(hub.broadcast('room-1', 'x')).toBe(0);
    // Not merely empty — gone. An empty map per room is a leak with a slow fuse.
    expect(hub.roomCount()).toBe(0);
  });

  it('keeps a room alive while anyone is still in it', () => {
    const hub = createHub<string>();
    hub.subscribe('room-1', recorder('a'));
    hub.subscribe('room-1', recorder('b'));
    hub.unsubscribe('room-1', 'a');
    expect(hub.roomCount()).toBe(1);
    expect(hub.subscriberCount('room-1')).toBe(1);
    hub.unsubscribe('room-1', 'b');
    expect(hub.roomCount()).toBe(0);
  });

  it('broadcasting into a room nobody is in is a no-op, not an error', () => {
    const hub = createHub<string>();
    expect(hub.broadcast('nobody-here', 'x')).toBe(0);
    expect(hub.broadcastExcept('nobody-here', 'a', 'x')).toBe(0);
    expect(hub.subscriberCount('nobody-here')).toBe(0);
  });
});
