import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type PendingSupersession,
  retainedSupersessionKey,
  supersessionReachedFold,
} from '../lib/live-supersession';

const pending: PendingSupersession = {
  retiredObjectId: 'old',
  replacementObjectId: 'new',
  clientSupersessionId: 'durable-1',
};

describe('live supersession request state', () => {
  /**
   * Mutation: pass `undefined` from LiveRoomSession instead of the retained
   * request key. Confirming again before the projection refresh then mints a
   * different command instead of recovering the original durable receipt.
   */
  it('reuses a key only for the exact pending endpoint pair', () => {
    expect(retainedSupersessionKey(pending, 'old', 'new')).toBe('durable-1');
    expect(retainedSupersessionKey(pending, 'other-old', 'new')).toBeUndefined();
    expect(retainedSupersessionKey(pending, 'old', 'other-new')).toBeUndefined();

    const session = readFileSync('app/app/[workspace]/[room]/LiveRoomSession.tsx', 'utf8');
    expect(session).toContain(
      'const held = retainedSupersessionKey(\n              pendingSupersession,\n              retiredObjectId,\n              replacementObjectId,\n            );',
    );
    expect(session).toContain('{ clientSupersessionId: held }');
  });

  /**
   * Mutation: clear pending supersession state on an ack, or compare only the
   * retired id. The UI then loses retry state before the fold lands, or accepts
   * a different replacement as proof of this command.
   */
  it('clears only when the persisted fold names the exact replacement', () => {
    const objects = [
      {
        id: 'old',
        roomId: 'room',
        objectiveId: null,
        type: 'decision' as const,
        payload: { statement: 'old', decidedBy: null, status: 'superseded' as const },
        proposalId: null,
        interpretationId: null,
        retractedAt: null,
        supersededById: 'new',
        humanTouchedAt: null,
        revision: 0,
        acceptedBy: 'alice',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ];
    expect(supersessionReachedFold(objects, pending)).toBe(true);
    expect(
      supersessionReachedFold(
        objects.map((object) => ({ ...object, supersededById: 'different' })),
        pending,
      ),
    ).toBe(false);
    expect(supersessionReachedFold(objects, null)).toBe(false);
  });
});
