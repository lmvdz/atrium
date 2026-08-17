import 'server-only';
import type { CovenantReadStatus } from '@atrium/core';
import { type Database, loadCovenantAnchor } from '@atrium/db';
import { webCovenantReadAuthority } from './covenant-read';
import { readerForLiveDoc } from './covenant-reader';
import { liveCovenantDoc } from './live-covenant-doc';

/**
 * RESOLVE A ROOM'S OBJECT `✓`/`~` GLYPHS — the server side of the display-glyph
 * wiring (#198, P6F-4). This is where the certified-content check that SL-6 routed
 * every reader through (`anchorCertifies` → the read authority) is actually DRIVEN:
 * it builds the ONE fail-closed {@link webCovenantReadAuthority} for the room and
 * resolves each object's covenant status against the live document, returning a plain
 * `{ objectId → status }` map the client surfaces read through
 * {@link import('./covenant-read').precomputedGlyphResolver}.
 *
 * ## Why this runs on the SERVER, not in the surface
 *
 * The display surfaces (`LiveRoomSession`, `ReplaySession`) are client components,
 * but the document the covenant resolves against is NOT the browser's copy. P6F-2
 * (#196) made the room's authoritative `Y.Doc` a SERVER-side replica precisely
 * because "a CRDT cannot securely authenticate WHO authored content" — a peer can
 * drift its own local doc, so resolving `✓` against client bytes would reintroduce
 * the exact authorship-blindness P6F-2 closed. The authority therefore resolves
 * against the server-authoritative replica (`liveCovenantDoc`) HERE, and only the
 * definitive verdicts cross to the client. The reader/anchor handles (a live `Y.Doc`
 * and DB access) are not serializable across the RSC boundary anyway; the STATUS is.
 *
 * The three ports are the real ones:
 *   - `loadAnchor` — the room-scoped `covenant_anchors` read ({@link loadCovenantAnchor}).
 *   - `reader`     — {@link readerForLiveDoc} over the room's current server replica,
 *                    watching the `conversation-content` share (`liveCovenantDoc.options`).
 *   - `expectedRoomId` — the room binding, so a foreign-room anchor fails closed.
 *
 * FAIL-CLOSED throughout: no replica registered (torn down / never joined) ⇒ the
 * provider polls `null` ⇒ the reader resolves nothing ⇒ `drift` (`~`); no anchor ⇒
 * `drift` (`~`); a drifted span ⇒ `drift` (`~`). Only a live span byte-identical to
 * its anchor resolves `ok` (`✓`). Each call `resolve()`s fresh, so a subsequent
 * server render (the live route's `router.refresh()` on drift/projection change)
 * re-resolves the current verdict — the staleness bound without a client doc.
 */
export async function roomCovenantReads(
  db: Pick<Database, 'select'>,
  roomId: string,
  objectIds: readonly string[],
): Promise<Record<string, CovenantReadStatus>> {
  if (objectIds.length === 0) return {};
  const live = liveCovenantDoc(roomId);
  const reader = readerForLiveDoc(live.provider, undefined, live.options);
  const authority = webCovenantReadAuthority({
    loadAnchor: (objectId) => loadCovenantAnchor(db, { roomId, objectId }),
    reader,
    expectedRoomId: roomId,
  });
  // De-dupe object ids so one object resolves once; the authority also dedupes
  // concurrent resolves of the same id, but the caller's list may repeat.
  const unique = [...new Set(objectIds)];
  const resolved = await Promise.all(
    unique.map(async (objectId) => {
      const { covenantStatus } = await authority.resolve(objectId);
      return [objectId, covenantStatus] as const;
    }),
  );
  return Object.fromEntries(resolved);
}
