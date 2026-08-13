'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { type CertifyOutcome, certifySession } from '@/lib/certify-session';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { loadRoom, loadWorkspace } from '@/lib/workspaces';

/**
 * Land a settled session — the human-only certify behind the review pane's
 * hold-to-arm. The authority is `requireSession` (the authenticated principal),
 * NOT anything the client sends: the arming record carries who/when for the
 * receipt, but the identity the write is attributed to is the session's, so a
 * forged `viewerId` in the payload would change nothing. `certifySession`
 * re-checks human-kind, membership and settled-ness, and the DB trigger refuses
 * a non-human certifier underneath all of it.
 */
const CertifyInput = z.object({
  sessionId: z.uuid(),
  armedAt: z.string().min(1).max(40),
  heldMs: z.number().int().nonnegative().max(600_000),
  workspaceSlug: z.string().min(1).max(200),
  roomSlug: z.string().min(1).max(200),
});

export async function certifySessionAction(raw: unknown): Promise<CertifyOutcome> {
  const session = await requireSession('/app');
  const parsed = CertifyInput.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'no_such_session' };

  // The membership boundary, through @atrium/auth's authorized reads: a viewer
  // who cannot open this room resolves no room here, and lands nothing. The
  // room id this yields is what `certifySession` scopes the session to.
  const workspace = await loadWorkspace(parsed.data.workspaceSlug, session.userId);
  if (!workspace) return { ok: false, reason: 'not_in_room' };
  const room = await loadRoom(workspace.id, parsed.data.roomSlug, session.userId);
  if (!room) return { ok: false, reason: 'not_in_room' };

  const outcome = await certifySession({
    database: db(),
    viewerId: session.userId,
    sessionId: parsed.data.sessionId,
    authorizedRoomId: room.id,
    armedAt: parsed.data.armedAt,
    heldMs: parsed.data.heldMs,
  });

  if (outcome.ok) {
    revalidatePath(`/app/${parsed.data.workspaceSlug}/${parsed.data.roomSlug}/control`);
  }
  return outcome;
}
