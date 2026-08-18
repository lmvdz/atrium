'use server';

import { ClaimPayload } from '@atrium/core';
import {
  type CertifyAnchorOutcome,
  certifyObjectSpan,
  REPLICA_ABSENT_POSITION,
} from '@/lib/certify-anchor';
import { type BodyPath, type CovenantDocReaderProd, readerForLiveDoc } from '@/lib/covenant-reader';
import { db } from '@/lib/db';
import { liveCovenantDoc } from '@/lib/live-covenant-doc';
import { roomReplicaManager } from '@/lib/room-replica-singleton';
import { serverReplicaFor } from '@/lib/server-room-replica';
import { requireSession } from '@/lib/session';
import { loadRoom, loadWorkspace } from '@/lib/workspaces';
import { CertifyObjectSpanInput, PokeCovenantSweepInput } from './covenant-actions-input';

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

  const outcome = await certifyObjectSpan({
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

  /* SEED the fresh anchor into the room's live drift sweep (E7, #199 Fix 2). A certify is
     not itself a Yjs `update`, so without this the sweep would not cover the new object
     until its next async ledger refresh — and its FIRST in-span edit could read a stale
     `ok`. Seeding it synchronously here means the next update's sweep pass already covers
     it, and the read-path overlay is fail-closed for it until its verdict settles. Only
     on a successful mint; a refused certify wrote no anchor to sweep. */
  if (outcome.ok) replicaManager.noteCertifiedFor(room.id, objectId);

  return outcome;
}

/**
 * The span's rendered PLAINTEXT, derived server-authoritatively for the accepted
 * object's claim statement (#220 / T6). The covenant MEANING lives in the anchor (its
 * rendered digest over the exact span); this string is only the object's human-readable
 * label, so it fails CLOSED to a stable non-empty default — an unresolved / empty /
 * unrenderable span never leaves the `ClaimPayload`'s `min(1)` unsatisfied, and never
 * throws out of the certify path. Read through the SAME reader the anchor is derived
 * from, never from the client.
 */
function spanStatement(reader: CovenantDocReaderProd): string {
  try {
    const captured = reader.captureSelection();
    if (captured !== null) {
      const text = captured.fragment.nodes
        .flatMap((node) => (node.kind === 'text' ? [node.text] : []))
        .join('');
      const trimmed = text.trim();
      if (trimmed.length > 0) return trimmed.slice(0, 500);
    }
  } catch {
    // A hostile / unrenderable body throws out of the reader — fail closed to the
    // default label below; the certify's own derive step will refuse the anchor.
  }
  return 'certified passage';
}

/**
 * CERTIFY A YJS SPAN — the human-only span certify on the yjs conversation surface
 * (#220 / T6), the sibling of {@link certifyObjectSpanAction} that resolves the E8
 * `objectIdFor` dormancy by DERIVING the covenant object the anchor binds to.
 *
 * ## The binding: one-accepted-object-per-certified-span (Lars-endorsed)
 *
 * A yjs span has no ledger proposal/acceptance to project an `accepted_objects` row
 * from (that is `apps/server`'s event-sourced projection, for ledger rooms). So the
 * human certify gesture derives the object DIRECTLY: the request's `objectId` is the
 * message's own id (the client passes the yjs message id, a uuid), and this action
 * hands {@link certifyObjectSpan} an `ensureObject` that UPSERTS the matching
 * `accepted_objects` row (a human-touched `claim` over the span's rendered text)
 * inside the anchor's write transaction, so the anchor's composite FK resolves and
 * the two writes are atomic. One object per message body ⇒ one certified span per
 * message; a second span in the same body would reuse the object id and the anchor's
 * unique `(room_id, object_id)` index reports `already_certified` (the deferred
 * overlapping-spans meaning fork, NOT baked in here — see #220).
 *
 * Everything else is {@link certifyObjectSpanAction}'s discipline verbatim: the
 * certifier is the authenticated session (a non-human is refused in
 * `certifyObjectSpan`), the span materials are derived by the authoritative server
 * reader over the live doc, and the request carries only WHICH span (`.strict()`).
 */
export async function certifyYjsSpanAction(raw: unknown): Promise<CertifyAnchorOutcome> {
  const session = await requireSession('/app');
  const parsed = CertifyObjectSpanInput.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'derive_failed' };
  const { workspaceSlug, roomSlug, objectId, bodyPath, start, end } = parsed.data;

  const workspace = await loadWorkspace(workspaceSlug, session.userId);
  if (!workspace) return { ok: false, reason: 'not_in_room' };
  const room = await loadRoom(workspace.id, roomSlug, session.userId);
  if (!room) return { ok: false, reason: 'not_in_room' };

  const replicaManager = roomReplicaManager();
  const requiredPosition = await replicaManager.streamHead(room.id);
  await replicaManager.acquire(room.id);

  /* F2 (#220 / T6) — THE OBJECT↔BODYPATH BINDING. The request carries `objectId` (the id
     the glyph is keyed by, so the `✓` paints on `body(objectId)`) and `bodyPath` (the
     `Y.XmlText` the anchor signs) INDEPENDENTLY. Refuse unless they name the SAME body:
     the block at `bodyPath` must be the exact `Y.XmlText` that `body(objectId)` — the
     displayed body for the id the glyph is keyed by — resolves to. Without this a caller
     certifies `objectId=A` while signing message M's content and the `✓` paints on A's
     line over M's signed content (the HIGH forge). Read the CURRENT authoritative replica
     (the same one the reader resolves against); an absent replica / mismatch fails closed.
     Belt-and-suspenders with F1's resolve-time guard, closed here at the mint source. */
  const replica = serverReplicaFor(room.id);
  if (replica === null) return { ok: false, reason: 'derive_failed' };
  if (!replica.conversation.bodyPathNamesDisplayBody(objectId, bodyPath)) {
    return { ok: false, reason: 'derive_failed' };
  }

  const live = liveCovenantDoc(room.id);
  const selection: { path: BodyPath; start: number; end: number } = { path: bodyPath, start, end };
  const reader = readerForLiveDoc(live.provider, selection, live.options);

  const outcome = await certifyObjectSpan({
    database: db(),
    session: { userId: session.userId, principalKind: session.principalKind },
    authorizedRoomId: room.id,
    objectId,
    reader,
    // THE BINDING (see docblock): derive the object the anchor's FK names, in the
    // anchor's transaction. A `claim` labelled by the span's server-derived text.
    ensureObject: {
      type: 'claim',
      payload: ClaimPayload.parse({
        statement: spanStatement(reader),
        claimant: session.userId,
        verification: 'unverified',
      }),
    },
    streamFreshness: {
      requiredPosition,
      consumedPosition: () =>
        serverReplicaFor(room.id)?.consumedStreamPosition() ?? REPLICA_ABSENT_POSITION,
    },
  });

  if (outcome.ok) replicaManager.noteCertifiedFor(room.id, objectId);

  return outcome;
}

/**
 * POKE THE COVENANT SWEEP for a room (#220 / T6) — the yjs surface's drift SCHEDULER.
 *
 * On the ledger surface a peer edit lands as a ledger event and `router.refresh()`
 * re-runs `roomCovenantReads`, which acquires the replica and re-verdicts. The yjs
 * surface has neither: its conversation is pure Electric, so the server-authoritative
 * replica has NO trigger to re-consume peer edits and re-run the sweep that projects
 * `covenant_status` (the glyph shape). Without a driver a certified span would show
 * `✓` and never flip on a peer edit.
 *
 * This is that driver, membership-gated: {@link roomReplicaManager}`.acquire` re-folds
 * the durable stream (idempotent — already-consumed ops are no-ops, only genuinely-new
 * ones advance the replica and fire its doc `update`, which drives the drift sweep →
 * `upsertCovenantStatus` → the client shape). The client polls it while mounted. It
 * NEVER mints a verdict — it only re-runs the fail-closed sweep, whose only write is
 * the owner/server `covenant_status` projection.
 *
 * Fail-safe: any refusal (not signed in / not a member / a torn-down room) returns
 * `{ ok: false }` and mints nothing; the glyphs stay at their last synced verdict,
 * degrading fail-closed to `~` on the client if the shape's liveness lapses.
 */
export async function pokeCovenantSweepAction(raw: unknown): Promise<{ readonly ok: boolean }> {
  const session = await requireSession('/app');
  const parsed = PokeCovenantSweepInput.safeParse(raw);
  if (!parsed.success) return { ok: false };
  const { workspaceSlug, roomSlug } = parsed.data;

  const workspace = await loadWorkspace(workspaceSlug, session.userId);
  if (!workspace) return { ok: false };
  const room = await loadRoom(workspace.id, roomSlug, session.userId);
  if (!room) return { ok: false };

  await roomReplicaManager().acquire(room.id);
  return { ok: true };
}
