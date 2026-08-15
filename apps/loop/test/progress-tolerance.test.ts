import { describe, expect, it } from 'vitest';
import { parseServerFrame, RoomEvent, WireEvent } from '../src/protocol.js';

/**
 * THE LOOP DAEMON CARRIES THE LIVE PROGRESS VOCABULARY, IT DOES NOT CRASH ON IT
 * (#159 covenant point 3; #152).
 *
 * The daemon produces nothing on the progress channel and routes on none of it,
 * but a `session_phase_changed` durable event replays through `catchup` and the two
 * ephemeral frames relay over the same socket. The lenient `OtherEvent` / `OtherFrame`
 * tails are what keep an unrouted-but-valid message from throwing the whole reducer.
 * This pins that tolerance so a future tightening of the loop's schema cannot silently
 * make the daemon fall over on a running session's progress.
 */
describe('the loop tolerates the live progress vocabulary (#159)', () => {
  it('carries a session_phase_changed durable event as an unrouted OtherEvent', () => {
    const event = RoomEvent.parse({
      id: 'e1',
      at: '2026-08-15T12:00:00.000Z',
      type: 'session_phase_changed',
      roomId: 'r1',
      sessionId: 's1',
      phase: 'writing',
      progressSeq: 3,
    });
    // It parses (carried, not crashed) and keeps its type for a switch that ignores it.
    expect(event.type).toBe('session_phase_changed');

    // …and it rides a WireEvent through catchup exactly as any other ledger row does.
    const wire = WireEvent.parse({
      roomId: 'r1',
      roomSeq: 7,
      seq: 42,
      actor: { kind: 'system' },
      event,
      issues: [],
    });
    expect(wire.event.type).toBe('session_phase_changed');
  });

  it('treats the ephemeral progress frames as unknown, not as an error', () => {
    for (const frame of [
      {
        type: 'session_heartbeat',
        roomId: 'r1',
        sessionId: 's1',
        progressSeq: 0,
        spendMicros: 100,
        contextPct: 0.5,
        at: '2026-08-15T12:00:00.000Z',
      },
      {
        type: 'session_diff_delta',
        roomId: 'r1',
        sessionId: 's1',
        progressSeq: 1,
        at: '2026-08-15T12:00:00.000Z',
        truncated: false,
        files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
      },
    ]) {
      // Parsed as a valid-but-unrouted frame (`OtherFrame`), surfaced to the daemon
      // as `unknown` — never a throw, never mistaken for a routed frame.
      expect(parseServerFrame(JSON.stringify(frame))).toEqual({ type: 'unknown' });
    }
  });
});
