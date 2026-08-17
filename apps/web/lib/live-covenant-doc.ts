import 'server-only';
import type * as Y from 'yjs';
import type { ReaderOptions } from './covenant-reader';

/* ---------------------------------------------------------------------------
 * THE LIVE COVENANT DOCUMENT SEAM (#190 SL-3 → #194).
 *
 * The certify path (`covenant-actions.ts`) resolves a certified span from the
 * room's live conversation rich-text body — a `Y.XmlText` under the conversation
 * content share. Those rich-text bodies arrive with #194 (rich-text-spans-first):
 * #183's `ConversationDoc` today carries MESSAGE-LEVEL content (a `Y.Array` of JSON
 * messages), not the `Y.XmlText` spans the covenant reader resolves against.
 *
 * This is the ONE place the certify path acquires the authoritative `Y.Doc` handle
 * and names the content share the reader watches. It is a function, not a constant,
 * so #194 replaces its body — wiring the room's real live-doc handle and content
 * root — WITHOUT touching the gate, the session→certifier binding, or the
 * derive-and-sign, which are all complete and exercised now.
 *
 * Until #194 wires it, `provider` returns `null`. The reader's non-blocking poll
 * then yields no doc, so `authoritativeContext()` / `captureSelection()` return
 * `null` and the gate refuses `derive_failed` — fail-CLOSED. It never certifies
 * against an empty or planted document; the covenant's whole claim is that a human
 * vouched for the EXACT live content, and there is no live content to vouch for
 * until #194 supplies it.
 * ------------------------------------------------------------------------- */

export interface LiveCovenantDoc {
  /**
   * The authoritative live `Y.Doc` for the room, or `null` when the handle is not
   * available (torn down, catching up, or — today, pre-#194 — not yet wired). The
   * reader polls this non-blockingly and fails closed on `null`.
   */
  readonly provider: () => Y.Doc | null;
  /**
   * Reader options — most importantly `resolveRoot`, the content share the room
   * writes its conversation rich-text into (#194). Absent/`null` share fails closed
   * in the reader rather than resolving against `getXmlFragment('doc')`.
   */
  readonly options?: ReaderOptions;
}

/**
 * Acquire the live covenant document for a room. `roomId` names which room's live
 * doc to bind; it is threaded now so #194's implementation has it without changing
 * this signature.
 *
 * PENDING #194: returns a permanently-`null` provider, so the certify path is wired
 * end-to-end and fails closed until the live rich-text doc exists.
 */
export function liveCovenantDoc(roomId: string): LiveCovenantDoc {
  void roomId;
  return { provider: () => null };
}
