import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { loadReplayData } from '@/lib/replay-data';
import { requireSession } from '@/lib/session';
import { loadRoom, loadWorkspace } from '@/lib/workspaces';
import { ReplaySession } from './ReplaySession';

export const metadata: Metadata = { title: 'Replay · Atrium' };
export const dynamic = 'force-dynamic';

export default async function ReplayPage({
  params,
}: {
  params: Promise<{ workspace: string; room: string }>;
}) {
  const { workspace: workspaceSlug, room: roomSlug } = await params;
  const session = await requireSession(`/replay/${workspaceSlug}/${roomSlug}`);

  const workspace = await loadWorkspace(workspaceSlug, session.userId);
  if (!workspace) notFound();

  const room = await loadRoom(workspace.id, roomSlug, session.userId);
  if (!room) notFound();

  const data = await loadReplayData(db(), room.id);
  if (!data) notFound();
  return <ReplaySession data={data} viewerId={session.userId} />;
}
