import 'server-only';
import type * as Y from 'yjs';
import { conversationContentRoot } from '@/app/prototype/yjs-conversation';
import type { ReaderOptions } from './covenant-reader';
import { serverReplicaFor } from './server-room-replica';

/* ---------------------------------------------------------------------------
 * THE LIVE COVENANT DOCUMENT SEAM (#190 SL-3 → P6F-2 / #196).
 *
 * The certify path (`covenant-actions.ts`) resolves a certified span from the
 * room's live conversation rich-text body — a `Y.XmlText` under the
 * `conversation-content` share. This is the ONE place the certify path acquires
 * the AUTHORITATIVE `Y.Doc` handle and names that share.
 *
 * P6F-1 supplied the rich-text bodies; P6F-2 supplies the authority: the handle
 * is NOT client bytes but the SERVER-AUTHORITATIVE {@link ServerRoomReplica} for
 * the room — a caught-up Yjs replica the server maintains, with P6F-1's
 * strip/quarantine invariants and P6F-2's authenticated-writer binding. The
 * reader resolves and captures against THAT replica; nothing resolution-bearing
 * comes from the client.
 *
 * FAIL-CLOSED, twice. When no replica is registered for the room (torn down,
 * catching up, or never joined), `provider` is permanently `null`. When a replica
 * exists but its `conversation-content` share is absent/empty,
 * `authoritativeDoc()` returns `null` and — belt and suspenders — `resolveRoot`
 * (`conversationContentRoot`) returns `null` too. Either way the reader captures
 * nothing and the gate refuses `derive_failed`: the covenant never vouches for an
 * empty or planted document.
 * ------------------------------------------------------------------------- */

export interface LiveCovenantDoc {
  /**
   * The authoritative live `Y.Doc` for the room, or `null` when the handle is not
   * available (no replica registered, torn down, or catching up / empty share).
   * The reader polls this non-blockingly and fails closed on `null`.
   */
  readonly provider: () => Y.Doc | null;
  /**
   * Reader options — most importantly `resolveRoot`, the content share the room
   * writes its conversation rich-text into (`conversation-content`). An
   * absent/`null` share fails closed in the reader rather than resolving against
   * `getXmlFragment('doc')`.
   */
  readonly options?: ReaderOptions;
}

/**
 * Acquire the live covenant document for a room. Looks up the room's
 * server-authoritative replica and hands the certify path its `Y.Doc` and the
 * `conversation-content` root. An unregistered room ⇒ a permanently-`null`
 * provider (fail-closed), so the certify path refuses `derive_failed` rather than
 * certifying against nothing.
 */
export function liveCovenantDoc(roomId: string): LiveCovenantDoc {
  const replica = serverReplicaFor(roomId);
  if (!replica) return { provider: () => null };
  return {
    provider: () => replica.authoritativeDoc(),
    options: { resolveRoot: conversationContentRoot },
  };
}
