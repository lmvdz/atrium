import { randomUUID } from 'node:crypto';
import { plans, sessionSignals, sessions } from '@atrium/db/schema';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { projectRoomEvent } from '../src/projections.js';
import { RoomEvent } from '../src/room-events.js';

/**
 * THE CONTINUATION DRAW, NAMED AT THE PROJECTION (#127 fix round 2, finding E).
 *
 * The round-1 build proved the resume spend end to end and nowhere else, so the
 * `+ 1` that moves `plans.authorized_draws` had no test that could say what it
 * WAS — only integration tests that observed a number climbing, which stay green
 * for any expression that happens to increase it and cannot run at all without
 * Docker. This file asks the projection directly, with a stubbed transaction, in
 * the style `proposal-projection.test.ts` established:
 *
 *   * a granted `resume` issues exactly ONE update against `plans`, and the
 *     expression it sets is `authorized_draws + 1` — one draw, not two, not a
 *     recount, not `= 1`;
 *   * a `steer` issues NONE, because a steer is not a draw.
 *
 * Both halves matter and they are separate `it`s: an increment nobody bounds is
 * as wrong as an increment that never happens, and a single test asserting both
 * would go green on a projection that incremented for every kind (the count
 * assertion would still see one update per event).
 */

interface UpdateWrite {
  table: unknown;
  values: Record<string, unknown>;
}

const roomId = randomUUID();
const planId = randomUUID();
const sessionId = randomUUID();

function signalEvent(kind: 'steer' | 'interrupt' | 'resume'): RoomEvent {
  return RoomEvent.parse({
    id: randomUUID(),
    at: '2026-08-13T12:00:00.000Z',
    type: 'session_signaled',
    roomId,
    sessionId,
    signalId: randomUUID(),
    kind,
    body: 'carry on',
    causeMessageId: null,
    supersedesEventId: null,
    subscriptionId: null,
  });
}

/**
 * A transaction stub that answers the projection's two reads and records its
 * writes. The session reads OPEN and the plan reads one draw taken against a
 * slice of ten, so the resume below is a GRANT and the increment is reachable.
 */
function stubTx(updates: UpdateWrite[], inserts: unknown[]) {
  const rowsFor = (table: unknown) =>
    table === sessions
      ? [{ status: 'open', planId, agentUserId: randomUUID(), ownerUserId: randomUUID() }]
      : table === plans
        ? [{ slice: 10, authorizedDraws: 1 }]
        : [];
  return {
    select() {
      return {
        from(table: unknown) {
          const rows = rowsFor(table);
          // Every read the projection makes ends in `.for('share')`, so the
          // builder needs no thenable of its own — which keeps this stub an
          // ordinary object rather than something `await` treats as a promise.
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
          // A real promise carrying `.returning()`, so both `await …where(x)`
          // (the plan increment) and `await …where(x).returning(y)` (the wait
          // match) work without hand-rolling a thenable.
          const result = Object.assign(Promise.resolve(undefined), {
            returning: async () => [{ id: randomUUID() }],
          });
          return { where: () => result };
        },
      };
    },
  };
}

async function projectSignal(kind: 'steer' | 'interrupt' | 'resume') {
  const updates: UpdateWrite[] = [];
  const inserts: unknown[] = [];
  await projectRoomEvent(
    {
      tx: stubTx(updates, inserts),
      roomId,
      actor: { kind: 'human', userId: randomUUID() },
      event: signalEvent(kind),
      before: {},
      after: {},
    } as never,
    {},
  );
  return { updates, inserts };
}

describe('a resume spends exactly one draw, at the projection', () => {
  it('moves plans.authorized_draws by + 1 and by nothing else', async () => {
    const { updates, inserts } = await projectSignal('resume');

    // The signal itself still rows up — otherwise "no update against plans"
    // below could be satisfied by a projection that did nothing at all.
    expect(inserts).toHaveLength(1);
    expect((inserts[0] as { table: unknown }).table).toBe(sessionSignals);

    const planUpdates = updates.filter((write) => write.table === plans);
    expect(planUpdates, 'a granted resume updates the plan exactly once').toHaveLength(1);

    // THE INCREMENT, BY NAME. Rendering the drizzle SQL fragment is what makes
    // this test about the expression rather than about an outcome: `+ 2`, `+ 0`,
    // a recount, or an assignment all render differently here, and only one of
    // them is the draw #115 decision 2 authorizes.
    const rendered = new PgDialect().sqlToQuery(
      planUpdates[0]?.values.authorizedDraws as never,
    ).sql;
    expect(rendered).toBe('"plans"."authorized_draws" + 1');

    // And nothing else about the plan moved — above all not the human-set
    // ceiling, whose only writer is `projectPlanRlimitSet`.
    expect(Object.keys(planUpdates[0]?.values ?? {}).sort()).toEqual([
      'authorizedDraws',
      'updatedAt',
    ]);
  });

  it('leaves the draw count alone for a steer — a steer is not a draw', async () => {
    const { updates, inserts } = await projectSignal('steer');
    expect(inserts).toHaveLength(1);
    expect(updates.filter((write) => write.table === plans)).toHaveLength(0);
  });

  it('leaves the draw count alone for an interrupt — nor is an interrupt', async () => {
    const { updates } = await projectSignal('interrupt');
    expect(updates.filter((write) => write.table === plans)).toHaveLength(0);
  });
});
