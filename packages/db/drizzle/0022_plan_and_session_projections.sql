-- ═════════════════════════════════════════════════════════════════════════════
-- PLANS AND SESSIONS — PROJECTIONS OF THE LEDGER, AND THE PSTREE INVARIANT AS DDL.
--
-- #116, from #114's resolution. A plan is a process group (a board), a session
-- is a process; both are projected from the ledger-only lifecycle events added
-- in 0023, and both carry the §9.2 budget placeholders. The point of the file is
-- the invariant §9 names — every session has exactly ONE parent and one exit
-- status; a session cannot spawn; the chain is agent → plan → session, fixed
-- depth, pstree not a graph — enforced in the DATABASE, four ways:
--
--   1. `sessions.plan_id` NOT NULL + the composite FK (room_id, plan_id) →
--      plans(room_id, id): exactly one parent, in the same room.
--   2. NO `parent_session_id` column exists — anywhere. A session cannot be a
--      parent because there is no FK by which it could be. You cannot violate a
--      constraint that does not exist (#111's strongest form). Depth is fixed
--      because the only parent FKs that exist spell agent → plan → session.
--   3. `plans_room_matches_agent_channel` — a plan's room is its agent's channel.
--   4. (0021) the agent's own owner/kind triggers — the chain ends at a human.
--
-- Truth stays on the spine. These tables are projections; nothing folds them.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. The two lifecycle enums
-- ─────────────────────────────────────────────────────────────────────────────
--
-- CREATE TYPE (not ALTER TYPE … ADD VALUE), so — unlike the event_type values in
-- 0023 — these labels are usable immediately, including by the columns below in
-- this same transaction.
CREATE TYPE "public"."plan_status" AS ENUM('open', 'settled');--> statement-breakpoint

CREATE TYPE "public"."session_status" AS ENUM('open', 'settled', 'failed');--> statement-breakpoint

COMMENT ON TYPE "public"."session_status" IS
  'A session''s process lifecycle: open, then settled or failed. settled and failed are the two exit receipts §9.5 names, kept apart because a failure is owed attention until triaged. This is PROCESS state, not epistemic state (#114 T3): a session settling or failing writes sessions.status and touches no accepted_objects judgement column, so it can never flip a ~ to a ✓.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. plans — a board, projected from plan_opened / plan_settled
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "room_id" uuid NOT NULL,
  "agent_user_id" uuid NOT NULL,
  "title" text NOT NULL,
  "status" "plan_status" DEFAULT 'open' NOT NULL,
  "budget_limit_micros" bigint,
  "spent_micros" bigint DEFAULT 0 NOT NULL,
  "opened_by_event_id" text,
  "settled_by_event_id" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "plans" ADD CONSTRAINT "plans_room_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade;--> statement-breakpoint

ALTER TABLE "plans" ADD CONSTRAINT "plans_agent_user_id_fk"
  FOREIGN KEY ("agent_user_id") REFERENCES "public"."agents"("user_id") ON DELETE cascade;--> statement-breakpoint

CREATE INDEX "plans_room_status_idx" ON "plans" ("room_id", "status");--> statement-breakpoint

CREATE INDEX "plans_agent_idx" ON "plans" ("agent_user_id");--> statement-breakpoint

-- The composite-FK TARGET a session's parent edge lands on. Without a unique key
-- on (room_id, id) there is no composite FK to make, and the "same room" half of
-- the pstree invariant would have nothing to hold to.
CREATE UNIQUE INDEX "plans_room_id_key" ON "plans" ("room_id", "id");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 3. sessions — a process, projected from session_opened/settled/failed
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `plan_id` is NOT NULL: a session always has its one parent. There is NO
-- `parent_session_id`, and that absence is the invariant — a session cannot be
-- another session's parent because there is no column by which it could be.
CREATE TABLE "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "room_id" uuid NOT NULL,
  "plan_id" uuid NOT NULL,
  "harness" text NOT NULL,
  "model" text NOT NULL,
  "status" "session_status" DEFAULT 'open' NOT NULL,
  "context_pct" real,
  "spend_micros" bigint DEFAULT 0 NOT NULL,
  "exit_summary" text,
  "opened_by_event_id" text,
  "settled_by_event_id" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

COMMENT ON TABLE "sessions" IS
  'A process, projected from the session lifecycle events (#116). The pstree invariant is DDL here: plan_id NOT NULL + the sessions_plan_same_room_fk composite FK give exactly one parent in the same room, and there is deliberately NO parent_session_id column — a session cannot be a parent because there is no FK by which it could be (#111). Depth is fixed at agent→plan→session. status/exit_summary/spend_micros are the session-exit receipt: process state, non-epistemic (#114 T3), and settling one flips no ~ to a ✓.';--> statement-breakpoint

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_room_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade;--> statement-breakpoint

CREATE INDEX "sessions_plan_idx" ON "sessions" ("plan_id");--> statement-breakpoint

CREATE INDEX "sessions_room_status_idx" ON "sessions" ("room_id", "status");--> statement-breakpoint

-- The composite-FK target for provenance edges out of accepted_objects/proposals.
CREATE UNIQUE INDEX "sessions_room_id_key" ON "sessions" ("room_id", "id");--> statement-breakpoint

-- THE ONE PARENT, IN THE SAME ROOM. This is way (1) of the pstree invariant.
-- Separate ALTER so the mutation ledger can drop and restore it by name.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_plan_same_room_fk"
  FOREIGN KEY ("room_id", "plan_id") REFERENCES "public"."plans"("room_id", "id") ON DELETE cascade;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 4. The pstree room trigger — a plan's room is its agent's channel (way 3)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Modelled on 0017: reads the referenced row, compares through no lock (an
-- agent's channel_room_id does not change under a plan mid-insert), fails closed.
CREATE OR REPLACE FUNCTION "atrium_plans_room_matches_agent_channel"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $room_matches$
DECLARE
  v_channel uuid;
BEGIN
  SELECT a."channel_room_id" INTO v_channel
  FROM public."agents" a WHERE a."user_id" = NEW."agent_user_id";
  IF v_channel IS NULL THEN
    RAISE EXCEPTION
      'plan %: agent "%" has no config row, so it has no channel to open a plan in', NEW."id", NEW."agent_user_id"
      USING ERRCODE = '23514', CONSTRAINT = 'plans_room_matches_agent_channel';
  END IF;
  IF v_channel <> NEW."room_id" THEN
    RAISE EXCEPTION
      'plan %: room "%" is not agent "%"''s channel "%"; a plan is agent-scoped in the channel the agent owns, so its room must be that channel', NEW."id", NEW."room_id", NEW."agent_user_id", v_channel
      USING ERRCODE = '23514', CONSTRAINT = 'plans_room_matches_agent_channel';
  END IF;
  RETURN NEW;
END;
$room_matches$;--> statement-breakpoint

CREATE TRIGGER "plans_room_matches_agent_channel"
  BEFORE INSERT OR UPDATE ON "plans"
  FOR EACH ROW EXECUTE FUNCTION "atrium_plans_room_matches_agent_channel"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_plans_room_matches_agent_channel"() IS
  'Refuses any plan whose room_id is not its agent''s channel_room_id (#116, pstree invariant way 3). A plan is agent-scoped in the channel the agent owns; this makes that a DB fact rather than a convention. No row lock. Does not bind an operator who disables triggers.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 5. The session→drafted-objects provenance edges (#114 T3 roll-up)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Nullable, and null in practice until #117 gives proposer_kind an agent/session
-- value — a session cannot DRAFT yet. Composite, so a drafting session and the
-- object/proposal it drafted are always in one room. Provenance only: no
-- judgement, and flipping it moves no ~ to a ✓.
ALTER TABLE "accepted_objects" ADD COLUMN "session_id" uuid;--> statement-breakpoint

ALTER TABLE "accepted_objects" ADD CONSTRAINT "accepted_objects_session_same_room_fk"
  FOREIGN KEY ("room_id", "session_id") REFERENCES "public"."sessions"("room_id", "id");--> statement-breakpoint

ALTER TABLE "proposals" ADD COLUMN "session_id" uuid;--> statement-breakpoint

ALTER TABLE "proposals" ADD CONSTRAINT "proposals_session_same_room_fk"
  FOREIGN KEY ("room_id", "session_id") REFERENCES "public"."sessions"("room_id", "id");
