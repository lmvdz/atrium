import { parsePrincipalKind } from '@atrium/auth';
import { users } from '@atrium/db';
import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { loadControlPlane } from '@/lib/control-plane-data';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { loadRoom, loadWorkspace } from '@/lib/workspaces';
import { ControlPlane } from '@/src/components/control/ControlPlane';
import {
  armSessionCertificationAction,
  certifySessionAction,
  disarmSessionCertificationAction,
} from './actions';

export const metadata: Metadata = { title: 'Control · Atrium' };
export const dynamic = 'force-dynamic';

/**
 * The authenticated read boundary for a room's control plane (#121).
 *
 * The same three-step authorization the live room uses: slugs locate candidates;
 * the caller-scoped workspace and room reads decide whether this person may see
 * them. Only then does the control-plane projection load. The viewer's principal
 * kind is resolved here and failed CLOSED — the review pane offers its land only
 * to a human, and an unreadable kind is never treated as one.
 */
export default async function ControlPage({
  params,
}: {
  params: Promise<{ workspace: string; room: string }>;
}) {
  const { workspace: workspaceSlug, room: roomSlug } = await params;
  const session = await requireSession(`/app/${workspaceSlug}/${roomSlug}/control`);

  const workspace = await loadWorkspace(workspaceSlug, session.userId);
  if (!workspace) notFound();

  const room = await loadRoom(workspace.id, roomSlug, session.userId);
  if (!room) notFound();

  const [data, viewerRow] = await Promise.all([
    /* The projection is THIS viewer's reading of the room: what is owed to them,
       and what has happened past their own read cursor. It used to be the room's,
       handed to everyone. */
    loadControlPlane(db(), room.id, room.name, session.userId),
    db()
      .select({ kind: users.principalKind })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1),
  ]);

  const viewerKind = parsePrincipalKind(viewerRow[0]?.kind ?? null) ?? 'unknown';

  return (
    <ControlPlane
      armAction={armSessionCertificationAction}
      certifyAction={certifySessionAction}
      disarmAction={disarmSessionCertificationAction}
      data={data}
      roomSlug={roomSlug}
      viewerId={session.userId}
      viewerKind={viewerKind}
      workspaceSlug={workspaceSlug}
    />
  );
}
