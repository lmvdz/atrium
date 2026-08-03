import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { loadReplayDataByLocation } from '@/lib/replay-data';
import { ReplaySession } from './ReplaySession';

export const metadata: Metadata = { title: 'Replay · Atrium' };
export const dynamic = 'force-dynamic';

export default async function ReplayPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; room: string }>;
  searchParams: Promise<{ viewer?: string }>;
}) {
  const { workspace, room } = await params;
  const { viewer } = await searchParams;
  const data = await loadReplayDataByLocation(db(), workspace, room);
  if (!data) notFound();
  return <ReplaySession data={data} viewerId={viewer} />;
}
