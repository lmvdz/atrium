'use server';

import {
  type CertifyAnchorOutcome,
  certifyObjectSpan,
  REPLICA_ABSENT_POSITION,
} from '@/lib/certify-anchor';
import { type BodyPath, readerForLiveDoc } from '@/lib/covenant-reader';
import { db } from '@/lib/db';
import { liveCovenantDoc } from '@/lib/live-covenant-doc';
import { roomReplicaManager } from '@/lib/room-replica-singleton';
import { serverReplicaFor } from '@/lib/server-room-replica';
import { requireSession } from '@/lib/session';
import { loadRoom, loadWorkspace } from '@/lib/workspaces';
import { CertifyObjectSpanInput } from './covenant-actions-input';

/**
 * CERTIFY AN OBJECT/SPAN — the human-only gesture that mints a covenant anchor
 * into the ledger (#190, SL-3). The object/span sibling of
 * `armSessionCertificationAction` / `certifySessionAction`.
 *
 * ## The certifier is the SESSION's, and nothing in the payload can change that
 *
 * The schema below carries only WHICH object and WHICH span range the human
 * gestured over — an object id and a body path + char offsets. It carries NO
 * certifier, NO `principalKind`, NO `renderedDigest`, NO `stateVector` / `deleteSet`
 * / span boundary. The certifier's kind and id come from `requireSession()` — the
 * authenticated principal, derived server-side from `users.principal_kind`
 * (declared to Better Auth `input: false`, so no request body anywhere can set it).
 * A non-human session is refused inside `certifyObjectSpan` with the covenant
 * reason, and everything resolution-bearing is derived by the authoritative server
 * reader over the live document. "The machine never certifies" is enforced at the
 * gate and backstopped by the table (0050 CHECK + 0052 correlation trigger).
 *
 * `loadWorkspace`/`loadRoom` are the membership boundary through `@atrium/auth`'s
 * authorized reads; `certify-anchor.ts` then re-derives that membership INSIDE its
 * write transaction under the certify path's stronger lock.
 *
 * ## The live document source is #194's seam
 *
 * The reader resolves the certified span from the room's live conversation
 * rich-text body. Those `Y.XmlText` bodies arrive with #194 (rich-text-spans-first);
 * `liveCovenantDoc` is the single, documented integration point that hands this
 * action the authoritative `Y.Doc` handle (and the share it writes content into).
 * Until #194 wires it, that provider returns `null`, so the reader captures nothing
 * and this action fails CLOSED (`derive_failed`) — it never certifies against an
 * empty plant. The gate, the session→certifier binding and the derive-and-sign are
 * all live now; only the doc handle is pending, and it is a one-function change.
 *
 * The request schema is {@link CertifyObjectSpanInput} (its own module — a
 * `'use server'` file may export only async functions). It is `.strict()`: a
 * request that attempts to supply a resolution-bearing field (`renderedDigest`,
 * `stateVector`, `relStart`, …) is REFUSED, not silently stripped — the covenant
 * launders nothing.
 */

/**
 * Fired when a human confirms certifying a span. Resolves the authenticated
 * principal and the room, builds the authoritative server reader over the live
 * document positioned on the selection, and drives the gated write.
 */
export async function certifyObjectSpanAction(raw: unknown): Promise<CertifyAnchorOutcome> {
  const session = await requireSession('/app');
  const parsed = CertifyObjectSpanInput.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'derive_failed' };
  const { workspaceSlug, roomSlug, objectId, bodyPath, start, end } = parsed.data;

  const workspace = await loadWorkspace(workspaceSlug, session.userId);
  if (!workspace) return { ok: false, reason: 'not_in_room' };
  const room = await loadRoom(workspace.id, roomSlug, session.userId);
  if (!room) return { ok: false, reason: 'not_in_room' };

  /* THE SERVER REPLICA (E3, #203). The stream head at REQUEST TIME is what the
     replica must have caught up to; capture it first, then lazy-start (or reuse) the
     replica from the durable stream — a fresh catch-up reaches at least this head, a
     reused warm replica that trails it is refused below (`replica_lagging`). */
  const replicaManager = roomReplicaManager();
  const requiredPosition = await replicaManager.streamHead(room.id);
  await replicaManager.acquire(room.id);

  /* The authoritative server reader over the live doc, positioned on the human's
     selection. `liveCovenantDoc` provides the doc handle AND the content share
     (#194's seam); an absent handle fails closed (DRIFT / no capture) in the reader,
     so this action refuses `derive_failed` rather than vouching for an empty plant. */
  const live = liveCovenantDoc(room.id);
  const selection: { path: BodyPath; start: number; end: number } = { path: bodyPath, start, end };
  const reader = readerForLiveDoc(live.provider, selection, live.options);

  return certifyObjectSpan({
    database: db(),
    session: { userId: session.userId, principalKind: session.principalKind },
    authorizedRoomId: room.id,
    objectId,
    reader,
    /* Refuse to mint if the replica lags the request-time stream head — never anchor
       content the server replica has not caught up to. An evicted/absent replica reads
       `-Infinity` and refuses (fail-closed). Distinct from #209's client witness. */
    streamFreshness: {
      requiredPosition,
      consumedPosition: () =>
        serverReplicaFor(room.id)?.consumedStreamPosition() ?? REPLICA_ABSENT_POSITION,
    },
  });
}
