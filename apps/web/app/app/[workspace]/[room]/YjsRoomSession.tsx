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
 * ## The covenant is now composed onto this surface (#220 / T6)
 *
 * T2's original scope boundary — "no covenant verdict/glyph is wired here" — is
 * LIFTED by T6: this surface now carries the covenant. `LiveConversationDoc` receives
 * the SSR verdict seed (`data.covenantReads`, keyed by object id = message id) and the
 * membership locators, which turn on (a) the live `✓`/`~` glyph over the
 * `covenant_status` Electric shape (T4's `useLiveGlyphResolver`, liveness-gated
 * fail-closed) and (b) the human-gated span-certify affordance (`CertifyPassage` →
 * `certifyYjsSpanAction`). A human certifies a span; the machine NEVER mints `✓`, and a
 * peer edit of a certified span flips the glyph `✓`→`~` live across both browsers.
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
      <LiveConversationDoc
        roomId={roomId}
        write
        viewerName={viewerName ?? undefined}
        // THE COVENANT COMPOSITION (#220 / T6): the SSR verdict seed + membership
        // locators turn on the live glyph and the span-certify affordance. The seed is
        // keyed by object id = message id (the one-object-per-span binding); a `{}` from
        // a room with no certified spans still engages the live shape (vs `undefined`,
        // which would leave the T1 read-only surface). `data.room` carries both slugs.
        covenantReads={data.covenantReads ?? {}}
        workspaceSlug={data.room.workspaceSlug}
        roomSlug={data.room.slug}
        viewerId={viewerId}
      />
    </main>
  );
}
