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
 * SCOPE, honestly bounded: only the tree is live in this lane. The conversation
 * feed and the thread roster remain the design shell — there is no per-session
 * live conversation read model to bind them to until #159 / Phase 6 — and every
 * covenant ACTION door stays inert (`{reached:false}`), wired separately under
 * go-live B's dual-lineage security gauntlet. The server-only `control-plane-data`
 * module is imported ONLY here (a server component); the client surface receives
 * plain data, never the module.
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
      <MoldingSurface tree={data} roomId={room.id} viewerId={session.userId} />
    </div>
  );
}
