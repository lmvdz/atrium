'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  type ArmOutcome,
  armCertification,
  type CertifyOutcome,
  certifySession,
  type DisarmOutcome,
  disarmCertification,
} from '@/lib/certify-session';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { loadRoom, loadWorkspace } from '@/lib/workspaces';

/**
 * The two halves of certifying a settled session — the human-only act behind the
 * review pane's hold-to-arm.
 *
 * ## What is NOT in the payload, and why that is the fix
 *
 * The first cut of this action took `armedAt` and `heldMs` off the request and
 * wrote them to the session's receipt. `{ heldMs: 0 }` certified; so did
 * `{ heldMs: 999999 }` from a shell that had never rendered the control. The
 * schemas below have no timing fields at all — not validated ones, none — because
 * the durable fix for "the client's measurement is not evidence" is to stop
 * accepting a measurement, not to bound it. The hold is now the interval between
 * two Postgres `clock_timestamp()` reads, one per action: `armSessionCertificationAction`
 * stamps the arm, `certifySessionAction` measures against it.
 *
 * ## THE AUTHORITY VALUES ARE REQUIRED, NOT OPTIONAL (round-7 finding 1)
 *
 * Round 6 accepted an OPTIONAL `reviewedDigest` and defaulted its absence to
 * "unchanged" — so a scripted caller that simply omitted it armed over the current
 * artifact with the stale-review check skipped, binding a signature to work it never
 * rendered. The arm schema REQUIRES it now. And the attempt is server-issued
 * (finding 2): the arm returns an opaque token, and the confirm and disarm REQUIRE
 * that token back. A request missing a required field is refused, never defaulted.
 *
 * The authority for ALL of it is `requireSession` — the authenticated principal,
 * never anything the client sends. `loadWorkspace`/`loadRoom` are the membership
 * boundary through `@atrium/auth`'s authorized reads for the arm and the confirm;
 * `certify-session.ts` then re-derives that membership INSIDE its write transaction
 * under a row lock. The DISARM does not resolve the room at all: retracting your own
 * pending arm is authorized on arm-ownership, so the owner may cancel even after
 * losing membership (finding 4). The DB triggers (0032, 0033) refuse a non-human
 * certifier or armer underneath all of it.
 */
const ArmInput = z.object({
  sessionId: z.uuid(),
  workspaceSlug: z.string().min(1).max(200),
  roomSlug: z.string().min(1).max(200),
  /**
   * THE REVIEWED-ARTIFACT DIGEST — the `md5(artifact::text)` the render carried
   * (round-6 finding 1), handed back so the arm binds the signature to the revision
   * the human saw. REQUIRED (round-7 finding 1): there is no absent-means-unchanged
   * default, so a request that does not attest what it reviewed is refused rather
   * than armed over whatever is current. Bounded to a hex md5's length.
   */
  reviewedDigest: z.string().min(1).max(64),
});

const ConfirmInput = z.object({
  sessionId: z.uuid(),
  workspaceSlug: z.string().min(1).max(200),
  roomSlug: z.string().min(1).max(200),
  /**
   * THE SERVER-ISSUED ATTEMPT TOKEN returned by the arm (round-7 finding 2).
   * REQUIRED: a confirm completes a specific press, so it must present the token
   * that press's arm minted. A uuid — that is the shape `gen_random_uuid()` makes.
   */
  attemptToken: z.uuid(),
});

const DisarmInput = z.object({
  sessionId: z.uuid(),
  /**
   * THE SERVER-ISSUED ATTEMPT TOKEN of the press being released (round-7 finding
   * 2). REQUIRED so a release cancels exactly the arm it belongs to. No room slugs:
   * the disarm authorizes on arm-ownership, not membership (finding 4), so it needs
   * nothing but the authenticated viewer, the session, and the token.
   */
  attemptToken: z.uuid(),
});

/**
 * The authenticated principal and the room they may actually open, or the refusal
 * that stands in for both — for the arm and the confirm, which are acts IN a room.
 * One function so the two cannot come to disagree about who is asking or which room
 * the answer is scoped to.
 */
async function resolveInRoom<S extends z.ZodType<{ workspaceSlug: string; roomSlug: string }>>(
  schema: S,
  raw: unknown,
): Promise<
  | { ok: true; userId: string; roomId: string; data: z.infer<S> }
  | { ok: false; reason: 'not_in_room' | 'no_such_session' }
> {
  const session = await requireSession('/app');
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'no_such_session' };

  const workspace = await loadWorkspace(parsed.data.workspaceSlug, session.userId);
  if (!workspace) return { ok: false, reason: 'not_in_room' };
  const room = await loadRoom(workspace.id, parsed.data.roomSlug, session.userId);
  if (!room) return { ok: false, reason: 'not_in_room' };
  return { ok: true, userId: session.userId, roomId: room.id, data: parsed.data };
}

/** STEP ONE. Fired when the hold BEGINS; the server stamps the clock and mints the token. */
export async function armSessionCertificationAction(raw: unknown): Promise<ArmOutcome> {
  const resolved = await resolveInRoom(ArmInput, raw);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  return armCertification({
    database: db(),
    viewerId: resolved.userId,
    sessionId: resolved.data.sessionId,
    authorizedRoomId: resolved.roomId,
    reviewedDigest: resolved.data.reviewedDigest,
  });
}

/**
 * CANCELLATION. Fired when the hold is RELEASED before it completes; the server
 * clears the arm it stamped on begin (CS-3). Without it a released hold left a
 * live arm for its whole TTL, and a later direct confirm certified. No
 * `revalidatePath`: disarming changes nothing a viewer is looking at.
 *
 * No room resolution: the disarm authorizes on arm-ownership (round-7 finding 4),
 * so the arm's OWNER may retract it even after losing room membership — which the
 * round-6 disarm, gated on membership like the confirm, refused.
 */
export async function disarmSessionCertificationAction(raw: unknown): Promise<DisarmOutcome> {
  const session = await requireSession('/app');
  const parsed = DisarmInput.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'no_such_session' };

  return disarmCertification({
    database: db(),
    viewerId: session.userId,
    sessionId: parsed.data.sessionId,
    attemptToken: parsed.data.attemptToken,
  });
}

/** STEP TWO. Fired when the hold COMPLETES; the server measures what it stamped. */
export async function certifySessionAction(raw: unknown): Promise<CertifyOutcome> {
  const resolved = await resolveInRoom(ConfirmInput, raw);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  const outcome = await certifySession({
    database: db(),
    viewerId: resolved.userId,
    sessionId: resolved.data.sessionId,
    authorizedRoomId: resolved.roomId,
    attemptToken: resolved.data.attemptToken,
  });

  if (outcome.ok) {
    revalidatePath(`/app/${resolved.data.workspaceSlug}/${resolved.data.roomSlug}/control`);
  }
  return outcome;
}
