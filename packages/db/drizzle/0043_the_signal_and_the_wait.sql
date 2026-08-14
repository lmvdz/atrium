-- ═════════════════════════════════════════════════════════════════════════════
-- THE SIGNAL AND THE WAIT — control DOWN a session, and a durable subscription.
--
-- #127, from #123's binding resolution. Two more ledger-only kinds on the #12
-- spine: `session_signaled` (steer | interrupt | resume) and `session_subscribed`.
-- Added to `event_type`, KEPT OUT of `coreEventTypes` (schema.ts) — the covenant
-- reducer folds neither, exactly the standing hold for the ten kinds before them.
-- Their projections write `session_signals` / `session_subscriptions` and touch
-- NOTHING on `accepted_objects` / `rlimit_slice` / `authorized_draws`, with the one
-- non-epistemic exception the covenant already permits: a `resume` is a #118 draw,
-- so it moves `authorized_draws` by exactly one — `session_opened`'s own accounting.
--
-- Both carry a top-level `roomId`, like every ledger-only kind since 0023, so the
-- `core_events_payload_room_matches` CHECK is extended to enumerate them —
-- MANDATORY, because that CHECK FAILS CLOSED: its `coalesce(…, false)` tail refuses
-- any `type` its CASE does not name, so an append of either kind is REFUSED at
-- INSERT until the CHECK learns it. The enum values and the CHECK arms land
-- together, the same discipline 0023 and 0028 keep.
--
-- ## What this file enforces that the application also enforces
--
--   * Open-only: a signal/subscription targets an OPEN session — the projection
--     nack (projections.ts). The 0025 terminal-state trigger cannot express this:
--     it guards the `sessions` ROW against UPDATE, and a signal is a fresh APPEND.
--   * Same-room provenance: `cause_message_id`, `supersedes_event_id` and
--     `subscription_id` are COMPOSITE-FK'd into the signal's own room, so a
--     cross-room anchor, a cross-room supersede, or a cross-room subscription is
--     refused at INSERT — the room-match backstop the ticket asks for.
--   * Interrupt authorization: the in-command lookup (commands.ts) is the primary
--     gate; `session_signals_interrupt_is_owner_or_agent` is its trigger backstop —
--     an `interrupt` row whose `signaled_by_user_id` is neither the session's plan's
--     agent principal nor that agent's owner is refused even if the command check
--     regressed. Does not bind an operator who disables triggers; the 0003 limit.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. The two new ledger-only event kinds, and the projection-table enums
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ALTER TYPE … ADD VALUE in the migrator's single transaction: permitted, and not
-- USED as an enum label anywhere here (the room CHECK compares `payload->>'type'`
-- as TEXT), so it is safe alongside the ADD VALUEs — the discipline 0023/0028 rely
-- on. The two CREATE TYPEs are brand-new enums, used immediately as column types
-- below, which is unrestricted (only ADD VALUE-then-use is refused in one txn).
ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'session_signaled';--> statement-breakpoint
ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'session_subscribed';--> statement-breakpoint

CREATE TYPE "public"."session_signal_kind" AS ENUM('steer', 'interrupt', 'resume');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('pending', 'matched', 'expired', 'disposed');--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. session_subscriptions — the durable wait (projection of session_subscribed)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Created BEFORE session_signals because a `resume` signal's `subscription_id`
-- composite FK lands on `(room_id, id)` here. `expires_at` and `cause_message_id`
-- are both NOT NULL: a wait with no horizon is the forever-open session that blocks
-- #119's plan-settle, and the anchor message is the ONLY representable subject for
-- the `signal_raised` an expiry raises (attention's closed vocabulary is
-- object/proposal/message; a subscription owns no object or proposal).
CREATE TABLE "session_subscriptions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "room_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "source" text NOT NULL,
  "matcher" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "cause_message_id" uuid NOT NULL,
  "status" "subscription_status" DEFAULT 'pending' NOT NULL,
  "subscribed_by_event_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "session_subscriptions" ADD CONSTRAINT "session_subscriptions_room_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_subscriptions" ADD CONSTRAINT "session_subscriptions_session_same_room_fk"
  FOREIGN KEY ("room_id","session_id") REFERENCES "public"."sessions"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_subscriptions" ADD CONSTRAINT "session_subscriptions_cause_message_same_room_fk"
  FOREIGN KEY ("room_id","cause_message_id") REFERENCES "public"."messages"("room_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "session_subscriptions_session_idx" ON "session_subscriptions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_subscriptions_room_status_idx" ON "session_subscriptions" USING btree ("room_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "session_subscriptions_room_id_key" ON "session_subscriptions" USING btree ("room_id","id");--> statement-breakpoint

COMMENT ON TABLE "session_subscriptions" IS
  'A durable wait on an open session (#127, projection of session_subscribed). expires_at and cause_message_id are NOT NULL: a wait needs a horizon and an anchor message (the expiry escalation''s signal_raised subject). Composite-FK''d into its own room. status leaves pending exactly once: matched (a resume named it), expired (the sweep escalated it), or disposed (the session exited).';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 3. session_signals — one control-DOWN signal (projection of session_signaled)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `id` is the `session_signaled` event's own `core_events.id` (text), so a later
-- signal's `supersedes_event_id` lands on `(room_id, id)` here — a forward-only
-- revision must name a REAL prior signal in the SAME room. The three provenance
-- fields are NEW and explicit, never MessageReference (no message kind here).
CREATE TABLE "session_signals" (
  "id" text PRIMARY KEY NOT NULL,
  "room_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "kind" "session_signal_kind" NOT NULL,
  "signaled_by_user_id" uuid,
  "signaled_by_kind" "actor_kind" NOT NULL,
  "cause_message_id" uuid,
  "supersedes_event_id" text,
  "subscription_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_room_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_signaled_by_user_id_fk"
  FOREIGN KEY ("signaled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_session_same_room_fk"
  FOREIGN KEY ("room_id","session_id") REFERENCES "public"."sessions"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_cause_message_same_room_fk"
  FOREIGN KEY ("room_id","cause_message_id") REFERENCES "public"."messages"("room_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The unique index the self-FK targets must exist first.
CREATE UNIQUE INDEX "session_signals_room_id_key" ON "session_signals" USING btree ("room_id","id");--> statement-breakpoint
ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_supersedes_same_room_fk"
  FOREIGN KEY ("room_id","supersedes_event_id") REFERENCES "public"."session_signals"("room_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_subscription_same_room_fk"
  FOREIGN KEY ("room_id","subscription_id") REFERENCES "public"."session_subscriptions"("room_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "session_signals_session_idx" ON "session_signals" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_signals_room_kind_idx" ON "session_signals" USING btree ("room_id","kind");--> statement-breakpoint

COMMENT ON TABLE "session_signals" IS
  'One control-DOWN signal against a session (#127, projection of session_signaled). id = the session_signaled core_events.id, so supersedes_event_id (a forward-only revision) composite-FKs back onto (room_id, id) here. cause_message_id / supersedes_event_id / subscription_id are the new explicit provenance fields, each composite-FK''d into the same room. resume is the #118 draw; its refusal is a draw_refused, not a row here.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 4. The interrupt-authorization trigger backstop
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The primary gate is the in-command lookup (commands.ts `signal_session`): an
-- interrupt is the session's plan's agent principal or that agent's owner only.
-- This is its DB backstop, modeled on `agents_owner_is_human` (0021): a lookup
-- trigger that refuses a bad row even if the command check regressed. Only
-- `interrupt` rows are checked — a steer is open to any member and is never gated
-- here. A NULL `signaled_by_user_id` (a model/system actor) can never be the agent
-- or owner, so it is refused for interrupt too.
CREATE OR REPLACE FUNCTION "atrium_session_signals_interrupt_is_owner_or_agent"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $interrupt_authz$
DECLARE
  v_agent_user_id uuid;
  v_owner_user_id uuid;
BEGIN
  IF NEW."kind"::text <> 'interrupt' THEN
    RETURN NEW;
  END IF;
  SELECT p."agent_user_id", a."owner_user_id"
    INTO v_agent_user_id, v_owner_user_id
  FROM public."sessions" s
  JOIN public."plans" p ON p."id" = s."plan_id" AND p."room_id" = s."room_id"
  JOIN public."agents" a ON a."user_id" = p."agent_user_id"
  WHERE s."id" = NEW."session_id" AND s."room_id" = NEW."room_id";
  IF v_agent_user_id IS NULL THEN
    RAISE EXCEPTION
      'interrupt signal %: no session/plan/agent chain for session "%" in room "%"', NEW."id", NEW."session_id", NEW."room_id"
      USING ERRCODE = '23514', CONSTRAINT = 'session_signals_interrupt_is_owner_or_agent';
  END IF;
  IF NEW."signaled_by_user_id" IS NULL
     OR (NEW."signaled_by_user_id" <> v_agent_user_id
         AND NEW."signaled_by_user_id" <> v_owner_user_id) THEN
    RAISE EXCEPTION
      'interrupt signal %: signaler "%" is neither the session''s agent principal "%" nor that agent''s owner "%" — an interrupt is authorized to those two only (#127), a table fact and not only a command check',
      NEW."id", NEW."signaled_by_user_id", v_agent_user_id, v_owner_user_id
      USING ERRCODE = '23514', CONSTRAINT = 'session_signals_interrupt_is_owner_or_agent';
  END IF;
  RETURN NEW;
END;
$interrupt_authz$;--> statement-breakpoint

CREATE TRIGGER "session_signals_interrupt_is_owner_or_agent"
  BEFORE INSERT OR UPDATE ON "session_signals"
  FOR EACH ROW EXECUTE FUNCTION "atrium_session_signals_interrupt_is_owner_or_agent"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_session_signals_interrupt_is_owner_or_agent"() IS
  'Refuses any interrupt-kind session_signals row whose signaled_by_user_id is not the target session''s plan''s agent principal or that agent''s owner (plans.agent_user_id / agents.owner_user_id). The DB backstop to the in-command interrupt authorization (#127). A steer is not checked (open to any member); a NULL signaler is refused for interrupt. Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 5. The payload-room CHECK, extended to the two new kinds
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The same discriminated CHECK 0007 introduced and 0023/0028 extended, with two
-- WHEN arms added. Each new kind declares exactly a top-level `roomId` (like
-- message_posted and every ledger-only kind since 0023), so each maps to
-- ARRAY['roomId'] on the left and payload->>'roomId' on the right. The
-- `coalesce(…, false)` tail is unchanged and still refuses any kind its CASE does
-- not name — which is why these arms MUST land with the enum values. DROP + ADD is
-- validated against every existing row; the new arms are a strict superset.
ALTER TABLE "core_events" DROP CONSTRAINT "core_events_payload_room_matches";--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_payload_room_matches" CHECK (coalesce(array_remove(ARRAY[
        CASE WHEN "core_events"."payload"->'proposal'->>'roomId' IS NOT NULL THEN 'proposal.roomId' END,
        CASE WHEN "core_events"."payload"->'object'->>'roomId' IS NOT NULL THEN 'object.roomId' END,
        CASE WHEN "core_events"."payload"->'relation'->>'roomId' IS NOT NULL THEN 'relation.roomId' END,
        CASE WHEN "core_events"."payload"->>'roomId' IS NOT NULL THEN 'roomId' END
      ], NULL) = CASE "core_events"."payload"->>'type'
        WHEN 'proposal_recorded' THEN ARRAY['proposal.roomId']
        WHEN 'object_accepted' THEN ARRAY['object.roomId']
        WHEN 'relation_added' THEN ARRAY['relation.roomId']
        WHEN 'message_posted' THEN ARRAY['roomId']
        WHEN 'attention_resolved' THEN ARRAY['roomId']
        WHEN 'plan_opened' THEN ARRAY['roomId']
        WHEN 'plan_settled' THEN ARRAY['roomId']
        WHEN 'session_opened' THEN ARRAY['roomId']
        WHEN 'session_settled' THEN ARRAY['roomId']
        WHEN 'session_failed' THEN ARRAY['roomId']
        WHEN 'signal_raised' THEN ARRAY['roomId']
        WHEN 'plan_rlimit_set' THEN ARRAY['roomId']
        WHEN 'draw_refused' THEN ARRAY['roomId']
        WHEN 'session_signaled' THEN ARRAY['roomId']
        WHEN 'session_subscribed' THEN ARRAY['roomId']
        WHEN 'proposal_rejected' THEN ARRAY[]::text[]
        WHEN 'proposal_superseded' THEN ARRAY[]::text[]
        WHEN 'object_corrected' THEN ARRAY[]::text[]
      END AND "core_events"."room_id"::text IS NOT DISTINCT FROM CASE "core_events"."payload"->>'type'
        WHEN 'proposal_recorded' THEN "core_events"."payload"->'proposal'->>'roomId'
        WHEN 'object_accepted' THEN "core_events"."payload"->'object'->>'roomId'
        WHEN 'relation_added' THEN "core_events"."payload"->'relation'->>'roomId'
        WHEN 'message_posted' THEN "core_events"."payload"->>'roomId'
        WHEN 'attention_resolved' THEN "core_events"."payload"->>'roomId'
        WHEN 'plan_opened' THEN "core_events"."payload"->>'roomId'
        WHEN 'plan_settled' THEN "core_events"."payload"->>'roomId'
        WHEN 'session_opened' THEN "core_events"."payload"->>'roomId'
        WHEN 'session_settled' THEN "core_events"."payload"->>'roomId'
        WHEN 'session_failed' THEN "core_events"."payload"->>'roomId'
        WHEN 'signal_raised' THEN "core_events"."payload"->>'roomId'
        WHEN 'plan_rlimit_set' THEN "core_events"."payload"->>'roomId'
        WHEN 'draw_refused' THEN "core_events"."payload"->>'roomId'
        WHEN 'session_signaled' THEN "core_events"."payload"->>'roomId'
        WHEN 'session_subscribed' THEN "core_events"."payload"->>'roomId'
        ELSE "core_events"."room_id"::text
      END, false));
