import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { loadReplayData } from '@/lib/replay-data';
import { requireSession } from '@/lib/session';
import { loadRoom, loadWorkspace } from '@/lib/workspaces';
import { LiveRoomSession } from './LiveRoomSession';

export const metadata: Metadata = { title: 'Room · Atrium' };
export const dynamic = 'force-dynamic';

/**
 * The authenticated read boundary for a live room.
 *
 * Slugs locate candidates; the caller-scoped workspace and room reads decide
 * whether this person may see them. Only the authorized database room id
 * crosses into the realtime client. The browser never receives an auth token:
 * Better Auth's session cookie authenticates the WebSocket upgrade.
 */
export default async function RoomPage({
  params,
}: {
  params: Promise<{ workspace: string; room: string }>;
}) {
  const { workspace: workspaceSlug, room: roomSlug } = await params;
  const session = await requireSession(`/app/${workspaceSlug}/${roomSlug}`);

  const workspace = await loadWorkspace(workspaceSlug, session.userId);
  if (!workspace) notFound();

  const room = await loadRoom(workspace.id, roomSlug, session.userId);
  if (!room) notFound();

  const data = await loadReplayData(db(), room.id);
  if (!data) notFound();

  return <LiveRoomSession data={data} viewerId={session.userId} />;
}
