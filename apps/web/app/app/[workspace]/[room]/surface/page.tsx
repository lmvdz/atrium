import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MoldingSurface } from '@/app/prototype/MoldingSurface';
import styles from '@/app/prototype/prototype.module.css';
import { loadControlPlane } from '@/lib/control-plane-data';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { loadRoom, loadWorkspace } from '@/lib/workspaces';

export const metadata: Metadata = { title: 'Surface · Atrium' };
export const dynamic = 'force-dynamic';

/**
 * THE MARRIED SURFACE ON A REAL ROOM (#168 go-live A).
 *
 * The decomposed prototype panes (`app/prototype/MoldingSurface` and its
 * NavTree/ChatBlock/ArtifactPane children) mounted on an authenticated room
 * route — not the `/prototype` fixture. The read-only process tree flips from
 * the seeded `control-fixture` to the LIVE control-plane projection here:
 * `loadControlPlane` (server-only) runs behind the same three-step authorization
 * the live room and the control page use, and the serializable `ControlPlaneData`
 * is handed to the client surface as a prop. So a real DB change to an
 * agent/plan/session moves the rendered tree cell (flip-the-input), through the
 * shipped `control/state.ts` selectors the same way `ControlPlane`/`ProcessTree`
 * derive theirs.
 *
 * SCOPE, honestly bounded: the tree is live (go-live A) and the covenant ACTION
 * doors are now LIVE too (go-live B2) — certify (the session-landing arm→confirm
 * hold), steer and interrupt fire real gated commands on a human gesture,
 * bound to `roomId`/`viewerId` and the room's slugs here. The conversation feed
 * and the thread roster remain the design shell — there is no per-session live
 * conversation read model to bind them to until #159 / Phase 6. The server-only
 * `control-plane-data` module is imported ONLY here (a server component); the
 * client surface receives plain data, never the module.
 */
export default async function RoomSurfacePage({
  params,
}: {
  params: Promise<{ workspace: string; room: string }>;
}) {
  const { workspace: workspaceSlug, room: roomSlug } = await params;
  const session = await requireSession(`/app/${workspaceSlug}/${roomSlug}/surface`);

  const workspace = await loadWorkspace(workspaceSlug, session.userId);
  if (!workspace) notFound();

  const room = await loadRoom(workspace.id, roomSlug, session.userId);
  if (!room) notFound();

  /* THIS VIEWER's reading of the room's control plane — what is owed to them and
     what has happened past their read cursor. The same projection the control
     page loads; here it feeds the married surface's process tree. */
  const data = await loadControlPlane(db(), room.id, room.name, session.userId);

  return (
    <div className={styles.ground} data-frame="atrium">
      <MoldingSurface
        tree={data}
        roomId={room.id}
        viewerId={session.userId}
        workspaceSlug={workspaceSlug}
        roomSlug={roomSlug}
      />
    </div>
  );
}
