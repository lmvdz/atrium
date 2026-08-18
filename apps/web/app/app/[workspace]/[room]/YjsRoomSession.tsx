'use client';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE YJS-SUBSTRATE ROOM (E4 / #216 / T2) — the render + write REPLACE.
 *
 * When `rooms.conversation_substrate = 'yjs'` (migration 0057), the live room's
 * conversation is a client `Y.Doc` synced over Electric Durable Streams — NOT the
 * ledger `liveRoomView`. `page.tsx` reads the flag and routes a `'yjs'` room here
 * instead of `LiveRoomSession`; a `'ledger'` room never reaches this file, so the
 * Phase-5 path is untouched (the scope boundary, kept by construction rather than
 * by a branch inside the ledger component).
 *
 * The whole conversation surface is T1's live mount (`LiveConversationDoc`), now
 * WRITE-ENABLED: a local edit is `doc.append`ed and the rented y-electric provider
 * PUTs the resulting Yjs update to the authenticated append door
 * (`app/api/rooms/[room]/ydoc`, rented as-is). So browser A's line reaches browser
 * B purely over Electric — no realtime WebSocket, no Server Action, no
 * `router.refresh()`, no server RPC — and the content lands on `ydoc_updates`,
 * which the server replica + drift sweep consume.
 *
 * ## What this deliberately does NOT do (the T2 scope boundary)
 *
 * No covenant verdict/glyph is wired here: an appended line carries no
 * authenticated who/kind and no `✓` (it renders "unverified · live"), exactly as
 * the peer-writable Yjs doc's honest fail-closed. The verdict projection (T3
 * #217) and the client glyph (T4 #218) own that axis; this file never reads
 * `covenant_status`.
 * ═════════════════════════════════════════════════════════════════════════ */

import type { ReplayData } from '@/lib/replay-data';
import { fileText } from '@/src/components/model';
import { LiveConversationDoc } from './LiveConversationDoc';
import styles from './live-room.module.css';

export function YjsRoomSession({ data, viewerId }: { data: ReplayData; viewerId: string }) {
  const roomId = data.room.id;
  // A DISPLAY hint for the local line's `who` — authority-stripped before it
  // reaches the wire (`encodeDurable`), so it is never trusted by a peer.
  const viewerName = data.participants.find((participant) => participant.id === viewerId)?.name;

  return (
    <main className={styles.live} data-room-id={roomId} data-substrate="yjs">
      <header style={{ margin: '1rem', display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0, font: '600 15px/1.4 ui-monospace, monospace' }}>
          {fileText(data.room.name, 'room name')}
        </h1>
        <span style={{ opacity: 0.6, font: '13px/1.4 ui-monospace, monospace' }}>
          live document substrate
        </span>
      </header>
      <LiveConversationDoc roomId={roomId} write viewerName={viewerName ?? undefined} />
    </main>
  );
}
