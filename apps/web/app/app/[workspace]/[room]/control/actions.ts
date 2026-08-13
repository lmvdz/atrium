'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  type ArmOutcome,
  armCertification,
  type CertifyOutcome,
  certifySession,
} from '@/lib/certify-session';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { loadRoom, loadWorkspace } from '@/lib/workspaces';

/**
 * The two halves of certifying a settled session — the human-only act behind the
 * review pane's hold-to-arm.
 *
 * ## What is NOT in the payload, and why that is the fix
 *
 * The first cut of this action took `armedAt` and `heldMs` off the request and
 * wrote them to the session's receipt. `{ heldMs: 0 }` certified; so did
 * `{ heldMs: 999999 }` from a shell that had never rendered the control. The
 * schema below has no timing fields at all — not validated ones, none — because
 * the durable fix for "the client's measurement is not evidence" is to stop
 * accepting a measurement, not to bound it. The hold is now the interval between
 * two Postgres `now()` reads, one per action: `armSessionCertificationAction`
 * stamps the arm, `certifySessionAction` measures against it.
 *
 * The authority for BOTH is `requireSession` — the authenticated principal, never
 * anything the client sends. `loadWorkspace`/`loadRoom` are the membership
 * boundary through `@atrium/auth`'s authorized reads; `certify-session.ts` then
 * re-derives that membership INSIDE its write transaction under a row lock, so a
 * revocation landing between this read and that write is caught rather than
 * inherited. The DB triggers (0032, 0033) refuse a non-human certifier or armer
 * underneath all of it.
 */
const CertifyInput = z.object({
  sessionId: z.uuid(),
  workspaceSlug: z.string().min(1).max(200),
  roomSlug: z.string().min(1).max(200),
});

interface Resolved {
  readonly userId: string;
  readonly roomId: string;
  readonly sessionId: string;
  readonly workspaceSlug: string;
  readonly roomSlug: string;
}

/**
 * The authenticated principal and the room they may actually open, or the
 * refusal that stands in for both. One function so the two actions cannot come to
 * disagree about who is asking or which room the answer is scoped to.
 */
async function resolve(
  raw: unknown,
): Promise<{ ok: true; at: Resolved } | { ok: false; reason: 'not_in_room' | 'no_such_session' }> {
  const session = await requireSession('/app');
  const parsed = CertifyInput.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'no_such_session' };

  const workspace = await loadWorkspace(parsed.data.workspaceSlug, session.userId);
  if (!workspace) return { ok: false, reason: 'not_in_room' };
  const room = await loadRoom(workspace.id, parsed.data.roomSlug, session.userId);
  if (!room) return { ok: false, reason: 'not_in_room' };
  return {
    ok: true,
    at: {
      userId: session.userId,
      roomId: room.id,
      sessionId: parsed.data.sessionId,
      workspaceSlug: parsed.data.workspaceSlug,
      roomSlug: parsed.data.roomSlug,
    },
  };
}

/** STEP ONE. Fired when the hold BEGINS; the server stamps the clock. */
export async function armSessionCertificationAction(raw: unknown): Promise<ArmOutcome> {
  const resolved = await resolve(raw);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  return armCertification({
    database: db(),
    viewerId: resolved.at.userId,
    sessionId: resolved.at.sessionId,
    authorizedRoomId: resolved.at.roomId,
  });
}

/** STEP TWO. Fired when the hold COMPLETES; the server measures what it stamped. */
export async function certifySessionAction(raw: unknown): Promise<CertifyOutcome> {
  const resolved = await resolve(raw);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  const outcome = await certifySession({
    database: db(),
    viewerId: resolved.at.userId,
    sessionId: resolved.at.sessionId,
    authorizedRoomId: resolved.at.roomId,
  });

  if (outcome.ok) {
    revalidatePath(`/app/${resolved.at.workspaceSlug}/${resolved.at.roomSlug}/control`);
  }
  return outcome;
}
