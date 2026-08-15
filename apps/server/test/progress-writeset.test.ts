import { randomUUID } from 'node:crypto';
import { acceptedObjects, plans, sessions } from '@atrium/db/schema';
import { describe, expect, it } from 'vitest';
import { createCommandService } from '../src/commands.js';
import { projectRoomEvent } from '../src/projections.js';
import { RoomEvent } from '../src/room-events.js';
import type { Session } from '../src/session.js';

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

    // THE POSITIVE WRITE-SET (#159 fix, finding 7). EVERY update targets `sessions` —
    // not merely "none touched accepted_objects/plans", which a denylist satisfies the
    // day a fourth table is added. A projection that grew a write to ANY other table
    // reddens here. The two explicit denials below stay as legible covenant sentences.
    expect(updates.every((write) => write.table === sessions)).toBe(true);
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

/**
 * THE EPHEMERAL PATH ALSO WRITES ONLY `sessions.progress` (#159 fix, finding 7).
 *
 * A heartbeat/diff never becomes a ledger event, so it does NOT go through
 * `projectRoomEvent` — its snapshot refresh is a direct `tx.update(sessions)` inside
 * `execute`, a second write the projection-only test above cannot see. This folds a
 * heartbeat through the REAL command boundary over a recording stub db and pins THAT
 * write-set to `sessions` alone, so the ephemeral door has the same covenant proof
 * the durable one does.
 */
describe('the ephemeral heartbeat/diff write-set is sessions-only (#159 finding 7)', () => {
  const authority = 'the-row-only-token';

  /** A stub db whose transaction hands a recording tx that answers the one gate read. */
  function recordingDb(updates: UpdateWrite[], inserts: unknown[]) {
    const tx = {
      select() {
        return {
          from(table: unknown) {
            // The gate read: a RUNNING provider session holding the token.
            const rows =
              table === sessions
                ? [
                    {
                      status: 'open',
                      executionMode: 'provider',
                      executionAuthority: authority,
                      progress: null,
                    },
                  ]
                : [];
            const result = {
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
    return { transaction: async <T>(cb: (tx: unknown) => Promise<T>) => cb(tx) };
  }

  it('a heartbeat updates sessions exactly once and touches no other table', async () => {
    const updates: UpdateWrite[] = [];
    const inserts: unknown[] = [];
    const commands = createCommandService({
      db: recordingDb(updates, inserts) as never,
      ledger: {} as never,
      authorizer: {} as never,
    });
    const agentSession: Session = { userId: randomUUID(), principalKind: 'agent' };

    const result = await commands.execute(agentSession, {
      name: 'report_session_progress',
      roomId,
      sessionId,
      authority,
      heartbeat: { spendMicros: 5, contextPct: 0.5 },
    });

    // The ephemeral result — a server-minted frame, no ledger row.
    expect(result.kind).toBe('progress');
    expect(inserts).toHaveLength(0);
    // THE WRITE-SET: every update targets sessions, exactly once, `progress` + `updatedAt`.
    expect(updates.every((write) => write.table === sessions)).toBe(true);
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0]?.values ?? {}).sort()).toEqual(['progress', 'updatedAt']);
  });
});
