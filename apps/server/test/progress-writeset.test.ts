import { randomUUID } from 'node:crypto';
import { acceptedObjects, plans, sessions } from '@atrium/db/schema';
import { describe, expect, it } from 'vitest';
import { projectRoomEvent } from '../src/projections.js';
import { RoomEvent } from '../src/room-events.js';

/**
 * THE LIVE PROGRESS CHANNEL WRITES ONLY `sessions.progress` (#159 covenant point 1).
 *
 * The decision (#152) named four covenant enforcement points; this file pins the
 * PROJECTION one, in the style `signal-projection.test.ts` established — a stubbed
 * transaction that records every write, folded against a `session_phase_changed`
 * event, asserting the write-set is `sessions` alone:
 *
 *   * a phase change updates `sessions` exactly once and touches NOTHING on
 *     `accepted_objects` (no `~`→`✓`) or `plans` (no draw, no ceiling);
 *   * the columns it sets are `progress` + `updatedAt`, so a progress report can
 *     never reach a judgement column even if one were added to `sessions` later.
 *
 * A denylist ("does not write accepted_objects") fails open the day a new table is
 * added; this asserts the POSITIVE write-set, so a projection that grew a second
 * write reddens here rather than in production.
 */

interface UpdateWrite {
  table: unknown;
  values: Record<string, unknown>;
}

const roomId = randomUUID();
const sessionId = randomUUID();

function phaseEvent(phase: 'planning' | 'writing' | 'testing', progressSeq: number): RoomEvent {
  return RoomEvent.parse({
    id: randomUUID(),
    at: '2026-08-15T12:00:00.000Z',
    type: 'session_phase_changed',
    roomId,
    sessionId,
    phase,
    progressSeq,
  });
}

/**
 * A transaction stub that answers the one read `projectSessionPhaseChanged` makes
 * (the session, OPEN, carrying a prior snapshot) and records its writes.
 */
function stubTx(updates: UpdateWrite[], inserts: unknown[]) {
  const rowsFor = (table: unknown) =>
    table === sessions
      ? [
          {
            status: 'open',
            progress: {
              progressSeq: 0,
              phase: 'planning',
              spendMicros: 7,
              contextPct: 0.25,
              updatedAt: '2026-08-15T11:59:00.000Z',
              heartbeatAt: '2026-08-15T11:59:00.000Z',
            },
          },
        ]
      : [];
  return {
    select() {
      return {
        from(table: unknown) {
          const rows = rowsFor(table);
          const result = {
            innerJoin: () => result,
            where: () => result,
            for: async () => rows,
          };
          return result;
        },
      };
    },
    insert(table: unknown) {
      return {
        async values(values: Record<string, unknown>) {
          inserts.push({ table, values });
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          updates.push({ table, values });
          const result = Object.assign(Promise.resolve(undefined), {
            returning: async () => [{ id: randomUUID() }],
          });
          return { where: () => result };
        },
      };
    },
  };
}

async function projectPhase(phase: 'planning' | 'writing' | 'testing', progressSeq: number) {
  const updates: UpdateWrite[] = [];
  const inserts: unknown[] = [];
  await projectRoomEvent(
    {
      tx: stubTx(updates, inserts),
      roomId,
      actor: { kind: 'system' },
      event: phaseEvent(phase, progressSeq),
      before: {},
      after: {},
    } as never,
    {},
  );
  return { updates, inserts };
}

describe('a session_phase_changed writes only the sessions.progress snapshot (#159)', () => {
  it('updates sessions exactly once and nothing on accepted_objects or plans', async () => {
    const { updates, inserts } = await projectPhase('writing', 1);

    // No ledger-shaped insert (a phase mints no signal/subscription row): the whole
    // effect is the snapshot UPDATE.
    expect(inserts).toHaveLength(0);

    const sessionUpdates = updates.filter((write) => write.table === sessions);
    expect(sessionUpdates, 'a phase change updates sessions exactly once').toHaveLength(1);

    // THE COVENANT: no judgement column, no plan column. A progress report has no
    // route to a `✓` or a draw.
    expect(updates.filter((write) => write.table === acceptedObjects)).toHaveLength(0);
    expect(updates.filter((write) => write.table === plans)).toHaveLength(0);

    // The positive write-set: progress + updatedAt, and nothing else.
    expect(Object.keys(sessionUpdates[0]?.values ?? {}).sort()).toEqual(['progress', 'updatedAt']);
  });

  it('carries the reported phase and seq and no epistemic field in the snapshot', async () => {
    const { updates } = await projectPhase('testing', 2);
    const snapshot = updates.find((write) => write.table === sessions)?.values.progress as Record<
      string,
      unknown
    >;
    expect(snapshot.phase).toBe('testing');
    expect(snapshot.progressSeq).toBe(2);
    // The spend/context the ephemeral heartbeats last left are PRESERVED (the merge).
    expect(snapshot.spendMicros).toBe(7);
    expect(snapshot.contextPct).toBe(0.25);
    // Nothing epistemic can be in the snapshot — covenant point 2.
    expect(snapshot).not.toHaveProperty('certified');
    expect(snapshot).not.toHaveProperty('verified');
  });
});
