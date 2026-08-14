import { randomUUID } from 'node:crypto';
import { proposals } from '@atrium/db/schema';
import { describe, expect, it } from 'vitest';
import { projectRoomEvent } from '../src/projections.js';
import { RoomEvent } from '../src/room-events.js';

interface InsertWrite {
  table: unknown;
  values: Record<string, unknown>;
}

function proposalEvent(
  sessionId: string | null,
): Extract<RoomEvent, { type: 'proposal_recorded' }> {
  const at = '2026-08-13T12:00:00.000Z';
  const statement = 'The projection carries the drafting session.';
  return {
    id: randomUUID(),
    at,
    type: 'proposal_recorded',
    sessionId,
    proposal: {
      id: randomUUID(),
      roomId: randomUUID(),
      type: 'claim',
      payload: {
        statement,
        claimant: randomUUID(),
        verification: 'unverified',
      },
      confidence: 1,
      proposer:
        sessionId === null
          ? { kind: 'human', userId: randomUUID() }
          : { kind: 'agent', userId: randomUUID() },
      provenance: [randomUUID()],
      quote: statement,
      interpretationId: null,
      status: 'proposed',
      createdAt: at,
    },
  };
}

async function projectedProposal(event: ReturnType<typeof proposalEvent>) {
  // Parse through the replay boundary first. If RoomEvent used core's narrower
  // proposal schema directly, Zod would strip sessionId and a rebuild would
  // silently lose the edge even while the live object still appeared correct.
  const parsed = RoomEvent.parse(event);
  if (parsed.type !== 'proposal_recorded') throw new Error('proposal event parsed as another kind');
  const writes: InsertWrite[] = [];
  const tx = {
    insert(table: unknown) {
      return {
        async values(values: Record<string, unknown>) {
          writes.push({ table, values });
        },
      };
    },
  };
  const record = {
    proposal: { ...parsed.proposal, status: undefined },
    stagedBy: parsed.proposal.proposer,
    status: 'proposed',
    acceptedObjectId: null,
    rejectedReason: null,
    supersededByProposalId: null,
    supersededReason: null,
  };
  delete (record.proposal as { status?: unknown }).status;

  await projectRoomEvent({
    tx,
    roomId: parsed.proposal.roomId,
    event: parsed,
    before: { proposals: {} },
    after: { proposals: { [parsed.proposal.id]: record } },
  } as never);

  const write = writes.find((candidate) => candidate.table === proposals);
  expect(write, 'the proposal projection must insert its read-model row').toBeDefined();
  return write?.values as Record<string, unknown>;
}

describe('proposal projection session provenance', () => {
  it('moves session_id when only the drafting session changes', async () => {
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    const event = proposalEvent(sessionA);

    const fromA = await projectedProposal(event);
    const fromB = await projectedProposal({ ...event, sessionId: sessionB });

    expect(fromA.sessionId).toBe(sessionA);
    expect(fromB.sessionId).toBe(sessionB);
  });

  it('keeps direct staging nullable and leaves the reading proposed (~)', async () => {
    const row = await projectedProposal(proposalEvent(null));

    expect(row.sessionId).toBeNull();
    expect(row.status).toBe('proposed');
  });

  it('replays a historical row that has no sessionId key at all', async () => {
    /**
     * ABSENT is not the same shape as NULL, and only one of them is what the
     * ledger already holds.
     *
     * Every `proposal_recorded` row written before the provenance edge existed —
     * and every one the interpretation worker wrote before it was pinned to an
     * explicit null — has no `sessionId` property whatsoever. `ProposalRecorded`
     * marks the field `.nullable().optional()` precisely so those rows still
     * parse, and the projection coalesces with `?? null` so they still land. A
     * test that only ever passes an explicit null exercises the nullable half
     * and leaves `.optional()` free to be dropped: the schema would then reject
     * a replay of the room's own history, and nothing here would say so.
     *
     * So this deletes the key rather than setting it, which is the only version
     * of this assertion that goes red if `.optional()` does.
     */
    const event = proposalEvent(null) as Partial<ReturnType<typeof proposalEvent>>;
    delete event.sessionId;
    expect('sessionId' in event).toBe(false);

    const row = await projectedProposal(event as ReturnType<typeof proposalEvent>);

    expect(row.sessionId).toBeNull();
    expect(row.status).toBe('proposed');
  });
});
