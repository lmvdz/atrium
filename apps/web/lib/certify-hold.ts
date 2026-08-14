/* ---------------------------------------------------------------------------
 * THE HOLD, IN NUMBERS BOTH SIDES READ — and the one the server actually gates on.
 *
 * #121 fix round, CS-2. The hold used to be a client measurement the server
 * copied down: the Server Action took `heldMs` off the request and stored it, so
 * the friction was entirely notional to anyone not using the browser. It is now a
 * server-stamped arm→confirm: arming writes `sessions.certify_armed_at` as
 * Postgres' `now()`, and certification refuses unless `now() - certify_armed_at`
 * is at least {@link CERTIFY_REQUIRED_HOLD_MS}.
 *
 * These constants live in a plain module — no `server-only`, no `use client` —
 * because the gate and the affordance have to be the SAME number written once. A
 * UI that held for less than the server requires would refuse every honest
 * certification; a UI that held for exactly it would refuse a fraction of them to
 * network jitter. So there are two numbers, and the relationship between them is
 * the point:
 *
 *   CERTIFY_REQUIRED_HOLD_MS — what the SERVER enforces. The covenant's 2s.
 *   CERTIFY_HOLD_MS          — what the CONTROL asks for. Deliberately longer.
 *
 * The margin exists because the two clock reads bracketing the interval are taken
 * on the server, one at the arm request and one at the confirm request, while the
 * hold is performed between the two on the client. Their flight times do not
 * cancel: the server-measured interval is the client hold plus (confirm flight
 * minus arm flight), which is negative as often as it is positive. Holding longer
 * than the gate requires makes an honest hold pass through that jitter, and the
 * gate stays the honest number rather than being loosened by a tolerance.
 * ------------------------------------------------------------------------- */

/** What the server enforces: no certification for a hold shorter than this. */
export const CERTIFY_REQUIRED_HOLD_MS = 2000;

/** What the control asks for. Longer than the gate — see the note above. */
export const CERTIFY_HOLD_MS = 2400;

/**
 * The tolerance, in milliseconds, between the held duration a receipt RECORDS and
 * the arm→signature interval its own two stamps bracket.
 *
 * #121 round-6 finding 4. The confirm measures `certified_held_ms` at its SELECT
 * and stamps `certified_at` at its UPDATE, a few milliseconds apart; the render
 * derives the interval from `certified_at - certify_armed_at`. The two agree only
 * within that gap, so both the DB backstop (drizzle/0036) and the render check
 * `|certified_held_ms − interval|` against this slack. 1000ms is generous and
 * still an order of magnitude under the smallest inconsistency a fabricated shape
 * describes (a 2000ms hold across a 0ms interval). The DB repeats the number
 * because a trigger cannot import it — the same reason the gate is repeated there.
 */
export const CERTIFY_RECEIPT_SLACK_MS = 1000;

/**
 * A settled session's artifact is REVIEWABLE — the minimum content a human can put
 * a signature on — only when it names both a non-empty branch AND a non-empty
 * commit.
 *
 * #121 round-6 finding 2. `SessionArtifact` has every field optional, so a non-null
 * but empty `{}` (or a half-filled `{ branch }`) is JSONB the null-checks all
 * accept — and a coherent receipt then earned a `✓` over an artifact with nothing
 * in it to review. A signature is a signature OF something specific: the branch and
 * commit are the least that makes "this human signed THIS artifact" mean anything.
 * The server guards, the render backstop, and the DB trigger (drizzle/0038) all read
 * this same shape, so an empty artifact is refused at arm, at confirm, at the table,
 * and at the glyph alike.
 *
 * Whitespace-only is empty: a branch of spaces names no branch. Trimmed length is
 * the test.
 */
export function isReviewableArtifact(
  artifact: { branch?: string; commit?: string } | null | undefined,
): boolean {
  if (artifact === null || artifact === undefined) return false;
  const branch = typeof artifact.branch === 'string' ? artifact.branch.trim() : '';
  const commit = typeof artifact.commit === 'string' ? artifact.commit.trim() : '';
  return branch.length > 0 && commit.length > 0;
}

/**
 * How long a pending arm stays live.
 *
 * An arm is a stated intention to certify, not a standing permission. Left
 * unbounded, a page armed and abandoned in a background tab would let a confirm
 * an hour later report an hour-long hold — technically past the gate, and a
 * complete misreading of what the person did. Past this, the arm is stale and the
 * certification is refused; the control arms again on the next press.
 */
export const CERTIFY_ARM_TTL_MS = 120_000;
