-- ═════════════════════════════════════════════════════════════════════════════
-- A SIGNAL REACHES A RUNNING SESSION — AND A WAIT ALWAYS ENDS.
--
-- #127, from #123's binding resolution. Two new ledger-only event kinds and the
-- two tables they project into:
--
--   * `session_signaled {steer | interrupt | resume}` — control sent DOWN into a
--     running process. `resume` is a CONTINUATION DRAW: it passes #118's slice
--     boundary exactly as `open_session` does, so there is no free wake path
--     around the budget (#115 decision 2 said the slice was authorized
--     "spawns/continues"; #118 built only the spawn half).
--   * `session_subscribed` — a durable WAIT with a MANDATORY horizon. An
--     unmatched subscribe used to be a way to hold a session open forever, which
--     blocks its plan from ever settling (#119) with nothing owed to anybody.
--
-- Three things here are load-bearing, and all three are structural:
--
--   1. **Signals target OPEN sessions only, as a TABLE FACT.** 0025 froze a
--      terminal `sessions` row, and that is a different rule: it stops a settled
--      session being reopened, and it structurally cannot refuse a LATER ledger
--      append that merely names one. The command checks it under the append lock,
--      the projection checks it again, and the triggers below make it true of the
--      TABLE, for any writer that is not an operator disabling triggers (the same
--      limit 0003 states).
--
--   2. **Interrupt authorization is a LOOKUP, backstopped here.** `execute`
--      discards the role `Authorizer.authorize` returns, so the command asks the
--      lineage question directly — `plans.agent_user_id` → `agents.owner_user_id`
--      — and `session_signals_interrupt_authorized` asks the same question of the
--      row. A direct writer cannot bind an interrupt to a member who is neither
--      the agent nor its owner.
--
--   3. **The provenance edges are same-room by FK, not by check.** A signal's
--      `cause_message_id` lands on `messages(room_id, id)` and its
--      `subscription_id` on `session_subscriptions(room_id, id)`, so a cause or a
--      wait from another room is impossible in every write path rather than
--      refused in one.
--
-- `public.` qualification and `::text` enum comparison throughout, for the reasons
-- 0043/0044 gave: the hardened `search_path` excludes public, and the house style
-- has compared enum labels through text since 0017.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. The two new ledger-only event kinds
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ALTER TYPE … ADD VALUE in the migrator's single transaction: permitted, and not
-- USED as an enum label anywhere in this file (the room CHECK below compares
-- `payload->>'type'` as TEXT), so it is safe alongside the ADD VALUEs — the same
-- discipline 0023 and 0028 rely on.
ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'session_signaled';--> statement-breakpoint
ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'session_subscribed';--> statement-breakpoint

-- The two new enums are CREATED here rather than extended, so their labels are
-- usable in this same transaction (the ADD VALUE restriction applies only to a
-- type that existed before it).
CREATE TYPE "public"."signal_kind" AS ENUM('steer', 'interrupt', 'resume');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('waiting', 'matched', 'expired', 'disposed');--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. `session_subscriptions` — a wait, and the horizon it must have
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `expires_at` is NOT NULL and that is the whole design. There is no spelling of
-- a wait without a horizon, so the wedge shape cannot be written down.
CREATE TABLE "session_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "room_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "source" text NOT NULL,
  "matcher" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "status" "subscription_status" DEFAULT 'waiting' NOT NULL,
  "matched_by_event_id" text,
  "escalated_at" timestamp with time zone,
  "subscribed_by_event_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "session_subscriptions" ADD CONSTRAINT "session_subscriptions_room_id_rooms_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- One room, one session: a wait can never name a session this room cannot see.
ALTER TABLE "session_subscriptions" ADD CONSTRAINT "session_subscriptions_session_same_room_fk"
  FOREIGN KEY ("room_id","session_id") REFERENCES "public"."sessions"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "session_subscriptions_session_idx" ON "session_subscriptions" USING btree ("room_id","session_id","status");--> statement-breakpoint
-- The expiry sweep's index: waiting waits, nearest horizon first.
CREATE INDEX "session_subscriptions_expiry_idx" ON "session_subscriptions" USING btree ("expires_at") WHERE "session_subscriptions"."status" = 'waiting';--> statement-breakpoint
-- The composite-FK target a resume's `subscription_id` lands on.
CREATE UNIQUE INDEX "session_subscriptions_room_id_key" ON "session_subscriptions" USING btree ("room_id","id");--> statement-breakpoint
-- One row per ledger event: a re-projection cannot mint a second wait.
CREATE UNIQUE INDEX "session_subscriptions_event_key" ON "session_subscriptions" USING btree ("subscribed_by_event_id");--> statement-breakpoint

COMMENT ON COLUMN "session_subscriptions"."expires_at" IS
  'MANDATORY (#127, #123 resolution 6). A durable wait with no horizon holds its session open forever and blocks the plan from ever settling (#119) with nothing owed to anybody — both blind critics of the decision draft found that hole. NOT NULL is the fix: every wait ends, matched into a resume draw, expired into the agent owner''s attention, or disposed by its own session''s exit.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 3. `session_signals` — the appended act
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "session_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "room_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "kind" "signal_kind" NOT NULL,
  "body" text,
  "cause_message_id" uuid,
  "supersedes_event_id" text,
  "subscription_id" uuid,
  "raised_by_user_id" uuid,
  "signaled_by_event_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Only a resume pays out a wait. A steer carrying a subscription id is a
  -- category error, and the check is here rather than in prose because the
  -- projection is not the only thing that can write this table.
  CONSTRAINT "session_signals_subscription_is_a_resume"
    CHECK ("session_signals"."subscription_id" IS NULL OR "session_signals"."kind" = 'resume')
);--> statement-breakpoint

ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_room_id_rooms_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_raised_by_user_id_users_id_fk"
  FOREIGN KEY ("raised_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_session_same_room_fk"
  FOREIGN KEY ("room_id","session_id") REFERENCES "public"."sessions"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- THE SAME-ROOM PROVENANCE EDGE (#123 resolution 4). The command refuses a
-- cross-room cause with a sentence; THIS is the authority that makes it
-- impossible, in every write path, including ones that never go near a command.
ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_cause_same_room_fk"
  FOREIGN KEY ("room_id","cause_message_id") REFERENCES "public"."messages"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_subscription_same_room_fk"
  FOREIGN KEY ("room_id","subscription_id") REFERENCES "public"."session_subscriptions"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "session_signals_session_idx" ON "session_signals" USING btree ("room_id","session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_signals_event_key" ON "session_signals" USING btree ("signaled_by_event_id");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 4. A signal names a session that is STILL RUNNING (both tables)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The table half of #123 resolution 3. Shaped exactly like 0044's
-- `atrium_proposals_session_matches_agent`: a missing or cross-room session falls
-- through to the composite FK, which is the single authority for that condition,
-- and this function refuses only the shape the FK admits but cannot judge — a
-- real same-room session that has already published its exit receipt.
--
-- Deliberately NOT re-fired by a later `sessions.status` change, for the reason
-- 0044 gives: a session that settles AFTER a steer was appended is the normal
-- course of events, and the row records where the signal WENT, not where the
-- process still is. The rule is about what may be WRITTEN, not a liveness
-- invariant the row must keep.
CREATE OR REPLACE FUNCTION "atrium_session_signals_target_is_open"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT s."status"::text
    INTO v_status
    FROM public."sessions" s
   WHERE s."room_id" = NEW."room_id"
     AND s."id" = NEW."session_id";

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_status <> 'open' THEN
    RAISE EXCEPTION
      'session % is %, so it is not running and cannot be signaled',
      NEW."session_id", v_status
      USING ERRCODE = '23514',
            CONSTRAINT = 'session_signals_target_is_open';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "session_signals_target_is_open"
  BEFORE INSERT OR UPDATE OF "room_id", "session_id"
  ON "session_signals"
  FOR EACH ROW EXECUTE FUNCTION "atrium_session_signals_target_is_open"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_session_signals_target_is_open"() IS
  'Signals target OPEN sessions only (#127, #123 resolution 3). 0025 freezes a terminal sessions ROW and structurally cannot refuse a later ledger append naming one, so the rule is a table fact here as well as a command precondition and a projection nack. Missing/cross-room sessions fall through to session_signals_session_same_room_fk. Reads public.sessions explicitly because the hardened search_path excludes public.';--> statement-breakpoint

CREATE OR REPLACE FUNCTION "atrium_session_subscriptions_target_is_open"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT s."status"::text
    INTO v_status
    FROM public."sessions" s
   WHERE s."room_id" = NEW."room_id"
     AND s."id" = NEW."session_id";

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_status <> 'open' THEN
    RAISE EXCEPTION
      'session % is %, so a wait registered against it could never be matched, only escalated',
      NEW."session_id", v_status
      USING ERRCODE = '23514',
            CONSTRAINT = 'session_subscriptions_target_is_open';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- INSERT only. A subscription's own lifecycle UPDATEs — matched, expired, and in
-- particular the DISPOSAL written by `projectSessionExit` in the exit's own
-- transaction — happen precisely when the session is no longer open, so firing
-- this on UPDATE would refuse the disposition it exists to make possible.
CREATE TRIGGER "session_subscriptions_target_is_open"
  BEFORE INSERT
  ON "session_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION "atrium_session_subscriptions_target_is_open"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_session_subscriptions_target_is_open"() IS
  'A durable wait targets an OPEN session (#127, #123 resolution 6): registered against an exited process it can never be matched, only escalated. INSERT-only, because a wait''s own disposition (matched/expired/disposed) is written exactly when the session may already be terminal. Missing/cross-room sessions fall through to session_subscriptions_session_same_room_fk.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 5. An INTERRUPT is the agent's or its owner's (#123 resolution 5)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The backstop for the in-command lookup. `steer` is deliberately unconstrained
-- here: any authenticated room member may steer, because that append is public,
-- receipted, and powerless over covenant and purse. `resume` is a DRAW and is
-- bounded by #118's slice at the command; its authorization is the same lookup,
-- and it is named here too so the table's rule and the command's rule are the
-- same sentence.
--
-- A NULL `raised_by_user_id` is refused for those two kinds rather than waved
-- through: the column is written from the ledger row's trusted actor, and the
-- only actors that carry no user id are `model` and `system` — neither of which
-- is an agent principal or a human owner, so "nobody said who" must not resolve
-- to the privileged answer (the fail-closed direction 0018 named).
CREATE OR REPLACE FUNCTION "atrium_session_signals_interrupt_authorized"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_agent_user_id uuid;
  v_owner_user_id uuid;
BEGIN
  IF NEW."kind"::text NOT IN ('interrupt', 'resume') THEN
    RETURN NEW;
  END IF;

  SELECT p."agent_user_id", a."owner_user_id"
    INTO v_agent_user_id, v_owner_user_id
    FROM public."sessions" s
    JOIN public."plans" p
      ON p."room_id" = s."room_id"
     AND p."id" = s."plan_id"
    JOIN public."agents" a
      ON a."user_id" = p."agent_user_id"
   WHERE s."room_id" = NEW."room_id"
     AND s."id" = NEW."session_id";

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW."raised_by_user_id" IS NULL
     OR (NEW."raised_by_user_id" <> v_agent_user_id
         AND NEW."raised_by_user_id" <> v_owner_user_id) THEN
    RAISE EXCEPTION
      'a % of session % belongs to agent % or its owner %, not to %',
      NEW."kind", NEW."session_id", v_agent_user_id, v_owner_user_id, NEW."raised_by_user_id"
      USING ERRCODE = '23514',
            CONSTRAINT = 'session_signals_interrupt_authorized';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "session_signals_interrupt_authorized"
  BEFORE INSERT OR UPDATE OF "room_id", "session_id", "kind", "raised_by_user_id"
  ON "session_signals"
  FOR EACH ROW EXECUTE FUNCTION "atrium_session_signals_interrupt_authorized"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_session_signals_interrupt_authorized"() IS
  'An interrupt or a resume of a session belongs to that session''s plan''s agent principal or to that agent''s human owner (#127, #123 resolution 5) — the table backstop for the in-command lookup, which exists because execute() discards the role Authorizer.authorize returns and a check nobody reads is decoration. A steer is unconstrained: any member may steer, because that append is public, receipted, and powerless over covenant and purse. A NULL raiser fails closed.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 6. The fourth attention subject — a session (#127)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A subscription that expires unmatched escalates to the agent's OWNER as an
-- ordinary `signal_raised`, and that item is about the SESSION still waiting. The
-- three existing subjects cannot name one, and an attention item pointing at a
-- stand-in subject misrepresents what is owed to the person being asked.
--
-- Added with all three parts the other three subjects have — a generated column,
-- a composite same-room FK, and a name in the allowlist — so an item can never
-- point at a session from a room the viewer cannot see. The allowlist is
-- REPLACED, not dropped: a denylist here would fail open for the fifth subject.
ALTER TABLE "attention_items" ADD COLUMN "subject_session_id" uuid
  GENERATED ALWAYS AS (CASE WHEN "subject_kind" = 'session' THEN "subject_id" END) STORED;--> statement-breakpoint

ALTER TABLE "attention_items" DROP CONSTRAINT "attention_items_subject_kind_allowlist";--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_subject_kind_allowlist"
  CHECK ("attention_items"."subject_kind" IN ('object', 'proposal', 'message', 'session'));--> statement-breakpoint

ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_session_same_room_fk"
  FOREIGN KEY ("room_id","subject_session_id") REFERENCES "public"."sessions"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 7. The payload-room CHECK, extended to the two new kinds
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The same discriminated CHECK 0007 introduced and 0028 last extended, with two
-- WHEN arms added. Each new kind declares exactly a top-level `roomId`, so each
-- maps to ARRAY['roomId'] on the left and payload->>'roomId' on the right. The
-- `coalesce(…, false)` tail is unchanged and still refuses any kind its CASE does
-- not name — which is why these arms MUST land with the enum values, or an append
-- of either kind would be refused at INSERT. DROP + ADD is validated against every
-- existing row, and the new arms are a strict superset, so every row that passed
-- the old check passes this one.
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
      END, false));--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 8. A draw is a spawn OR a continue — the column comment says so now
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 0028's comment said `authorized_draws` "equals count(sessions) for the plan by
-- construction". That identity was an artifact of the missing half of #115
-- decision 2, not the invariant: with resume built, the count is
-- `count(sessions) + count(granted resumes)`. The ENFORCED quantity is unchanged
-- — draws Atrium itself granted, never adapter-reported spend — and a resume that
-- would exceed the slice takes the same durable `draw_refused` receipt a spawn
-- does. Restated here because the sentence, not the number, was wrong.
COMMENT ON COLUMN "plans"."authorized_draws" IS
  'The committed authorized-draw accounting (#118, completed by #127): how many draws Atrium has granted under this plan. A draw is a SPAWN (session_opened) or a CONTINUE (session_signaled kind=resume) — #115 decision 2''s "spawns/continues", both halves now built. Incremented by exactly one in the same append transaction as each grant, under the global ledger lock, so it cannot be forged; it equals count(sessions) + count(granted resumes) for the plan. The quantity the draw gate enforces the slice against, never the adapter-reported spent_micros. steer and interrupt are not draws and never touch it.';
