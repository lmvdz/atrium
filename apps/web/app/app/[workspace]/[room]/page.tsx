import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { realtimeUrl } from '@/lib/env';
import { requireSession } from '@/lib/session';
import { loadRoom, loadWorkspace } from '@/lib/workspaces';
import styles from '../../workspace.module.css';
import { Presence } from './presence';

export const metadata: Metadata = { title: 'Room · Atrium' };
export const dynamic = 'force-dynamic';

/**
 * A room, as far as auth is concerned: you are in it, and so is whoever else is
 * connected. The conversation itself arrives with #22 and #25 — what this page
 * proves today is that two people who joined by different routes (one created
 * the workspace, one accepted an invitation) end up in the same place and can
 * see each other.
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

  // Read here, on the server, on the request path — and handed to the client as
  // a prop. `ATRIUM_WS_URL` deliberately has no `NEXT_PUBLIC_` prefix: that
  // prefix means "substitute me at build time", which is how the shipped image
  // ended up carrying the build machine's `ws://localhost:4000/ws` instead of
  // the deployment's `wss://…`. There is no fallback either, for the same
  // reason `appUrl()` has none in production: a localhost default here is a
  // browser told to open a socket to itself, quietly, forever.
  const wsUrl = realtimeUrl();

  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <h1 className={styles.title} data-testid="room-name">
          #{room.slug}
        </h1>
        <span className={styles.roleTag}>{room.role}</span>
      </div>
      <p className={styles.lede}>
        <Link className={styles.link} href={`/app/${workspace.slug}`}>
          {workspace.name}
        </Link>
      </p>

      <section className={styles.section} aria-labelledby="presence-heading">
        <h2 className={styles.sectionTitle} id="presence-heading">
          Who is here
        </h2>
        <Presence roomId={room.id} wsUrl={wsUrl} />
      </section>

      <section className={styles.section} aria-labelledby="conversation-heading">
        <h2 className={styles.sectionTitle} id="conversation-heading">
          Conversation
        </h2>
        <p className={styles.empty}>
          Messages, proposals and accepted objects land here with the realtime protocol.
        </p>
      </section>
    </main>
  );
}
