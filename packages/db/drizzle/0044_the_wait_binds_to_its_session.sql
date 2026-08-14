-- ═════════════════════════════════════════════════════════════════════════════
-- THE WAIT BINDS TO ITS SESSION — the #127 fix round.
--
-- 0043 shipped `session_signaled` / `session_subscribed` with same-ROOM provenance
-- FKs but not same-SESSION ones, no durable retry key, and an expiry escalation
-- that borrowed the `mention` attention class. The dual-lineage gauntlet found the
-- gaps that room-binding alone leaves open. This migration closes them, additively
-- — every constraint here is a strict tightening of an existing shape, validated
-- against the rows 0043 already permitted.
--
--   * A#2  supersedes is SESSION-bound, not just room-bound. A forward-only
--          revision names a prior signal against the SAME session.
--   * A#3  the expiry escalation names the wait's session, so its subscription
--          pointer is bound where it is dereferenced (see projections.ts).
--   * B    a distinct honest attention class for an expired wait — never `mention`.
--   * C    a durable idempotency key on both projection tables, partial-unique, so
--          a lost-ack retry of a funded resume or a subscribe is refused, not
--          double-applied.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## B. The honest attention class for an expired wait.
--
-- ADD VALUE in the migrator's single transaction is permitted precisely because
-- nothing here USES the new label — no row is written with it in this file; the
-- projection writes it at runtime. Same discipline 0043 keeps for its enum adds.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TYPE "public"."attention_class" ADD VALUE IF NOT EXISTS 'subscription_expired';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## A#2. supersedes_event_id is SAME-SESSION, not merely same-room.
--
-- 0043 bound it to `(room_id, id)`, so a steer could name a DIFFERENT session's
-- steer as the one it supersedes. The revision target now carries `session_id`:
-- the FK columns are `(room_id, session_id, supersedes_event_id)` and the row's
-- own `session_id` is on both sides, so the superseded signal must share the room
-- AND the session. The `(room_id, session_id, id)` unique index the new FK points
-- at must exist first.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "session_signals_room_session_id_key"
  ON "session_signals" USING btree ("room_id","session_id","id");--> statement-breakpoint
ALTER TABLE "session_signals" DROP CONSTRAINT "session_signals_supersedes_same_room_fk";--> statement-breakpoint
ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_supersedes_same_session_fk"
  FOREIGN KEY ("room_id","session_id","supersedes_event_id")
  REFERENCES "public"."session_signals"("room_id","session_id","id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## C. Durable idempotency keys — partial-unique on both projection tables.
--
-- A resend of an identical `resume_session` / `subscribe_session` carries the same
-- token. The partial unique index refuses the second projection, so a lost-ack
-- retry neither re-charges a draw nor duplicates a wait. Partial (WHERE … NOT
-- NULL) so the many tokenless rows — every steer/interrupt, a tokenless resume,
-- a subscribe with no token — are unconstrained.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "session_signals" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "session_subscriptions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "session_signals_idempotency_key"
  ON "session_signals" USING btree ("room_id","idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_subscriptions_idempotency_key"
  ON "session_subscriptions" USING btree ("room_id","idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint

COMMENT ON COLUMN "session_signals"."idempotency_key" IS
  'A durable retry key (#127 fix C). Partial-unique on (room_id, idempotency_key): a resend of a funded resume under the same token is refused rather than re-charging a draw. NULL for every tokenless signal.';--> statement-breakpoint
COMMENT ON COLUMN "session_subscriptions"."idempotency_key" IS
  'A durable retry key (#127 fix C). Partial-unique on (room_id, idempotency_key): a resend of an identical subscribe under the same token creates no second wait. NULL for a tokenless subscribe.';
