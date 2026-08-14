-- ═════════════════════════════════════════════════════════════════════════════
-- A WAKE RECEIPT NEEDS A LEDGER EVENT — AND A WAIT NEEDS A RAISER.
--
-- #127 fix round 2, from the round-1 gauntlet (both foreign lineages, blind at
-- 860d111). 0045 built the signal boundary; three of its clauses turned out to
-- bind the COMMAND PATH ONLY, which is the exact shape #122's standing lesson
-- names — a guard whose deletion nothing notices, because a neighbouring writer
-- was never asked the question at all.
--
--   A. **A resume row with no ledger event is a hand-minted wake receipt.**
--      `authorized_draws` moves in `projectSessionSignaled`, so a raw
--      `session_signals` INSERT with kind='resume' lands a receipt that #124
--      will read as a granted continuation while ZERO draws were counted against
--      #118's slice. The projection re-reads the slice now (the same reasoning
--      that made it re-read target-open); this file makes the TABLE refuse a
--      resume that carries no `signaled_by_event_id`. No receipt without an
--      event, and an event means the projection ran, and the projection means
--      the slice was re-checked and the draw was spent.
--
--   B. **A wait had no raiser at all.** `session_signals` carries
--      `raised_by_user_id` off the trusted envelope actor and the interrupt
--      trigger reads it; `session_subscriptions` carried nothing, so the table
--      could not ask who was asking and a bystander's hand-written wait landed.
--      Registering a wait IS control over a process — it decides how long the
--      session stays open and therefore how long its plan cannot settle (#119) —
--      so the same agent-principal-or-owner rule applies, in the same three
--      places: command, projection, table.
--
--   C. **The target-open reads did not lock the session row.** Both 0045 trigger
--      functions read `sessions.status` with a bare SELECT, so a direct writer
--      could read `open` while a concurrent settle committed underneath it. The
--      replacements below take a row lock, which is what makes the read hold
--      until this statement's transaction commits.
--
-- Append-only: 0045 is untouched, every change here is a REPLACE or an ADD.
-- `public.` qualification and `::text` enum comparison throughout, for the
-- reasons 0043/0044/0045 gave — the hardened `search_path` excludes public, and
-- the house style has compared enum labels through text since 0017.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. A wait carries its raiser (B)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Nullable, and deliberately not backfilled: the ledger is append-only and the
-- waits that predate this column were written before the rule existed. The
-- authorization trigger below is INSERT/UPDATE-scoped, so it judges rows written
-- from here on and never rewrites history. `ON DELETE set null` mirrors
-- `session_signals.raised_by_user_id`: a deleted user must not cascade away the
-- receipt of what they did.
ALTER TABLE "session_subscriptions" ADD COLUMN "raised_by_user_id" uuid;--> statement-breakpoint

ALTER TABLE "session_subscriptions" ADD CONSTRAINT "session_subscriptions_raised_by_user_id_users_id_fk"
  FOREIGN KEY ("raised_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

COMMENT ON COLUMN "session_subscriptions"."raised_by_user_id" IS
  'WHO registered the wait — the trusted envelope actor off the ledger row, never the payload (#21). Added in #127 fix round 2 because the table had no way to ask who was asking: the command''s agent-principal-or-owner check could be deleted with every test still green, and a bystander''s hand-written wait landed. Read by session_subscriptions_control_authorized. A NULL raiser fails CLOSED for the same reason it does on session_signals: the only actors carrying no user id are model and system, and neither is an agent principal or a human owner.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. A signal targets an OPEN session — under a row LOCK — and a resume
-- ##    carries its ledger receipt (A + C)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- REPLACES 0045's `atrium_session_signals_target_is_open`. Two changes, and the
-- two RAISEs carry DIFFERENT constraint names so each clause has its own witness
-- (one clause, one witness — deleting either arm reddens exactly one test):
--
--   * The status read now takes `FOR SHARE` on the `sessions` row. NOT
--     `FOR KEY SHARE`: a settle is a plain UPDATE of `status`, which takes a
--     FOR NO KEY UPDATE row lock, and FOR KEY SHARE does NOT conflict with that
--     — it would have been a lock that locks nothing, ornament in the exact
--     sense the campaign keeps finding. FOR SHARE conflicts with FOR NO KEY
--     UPDATE, so the status this trigger read cannot change under it before this
--     statement's transaction commits. It matches the `.for('share')` the
--     projection already takes on the same row.
--
--   * A `resume` row must name the `core_events` row that authorized it.
--     `plans.authorized_draws` is moved by `projectSessionSignaled`, never by
--     this table, so a hand-written `session_signals` row with kind='resume' is a
--     wake receipt that cost NOTHING against #118's slice — precisely the free
--     wake path #123 resolution 2 exists to close, reachable around the command
--     and around the projection both. Requiring the receipt makes the ledger
--     event the only way to mint one, and the ledger event is what runs the
--     projection's slice re-check and the draw increment in the same transaction.
--     `steer` and `interrupt` are unconstrained here: they are not draws, they
--     spend nothing, and a repair script rewriting a steer is not a covenant or
--     purse event.
CREATE OR REPLACE FUNCTION "atrium_session_signals_target_is_open"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  -- NO RECEIPT, NO WAKE. Checked before the session read, because it is true of
  -- the row alone and owes nothing to what the session is doing.
  IF NEW."kind"::text = 'resume' AND NEW."signaled_by_event_id" IS NULL THEN
    RAISE EXCEPTION
      'a resume of session % is a DRAW and must name the core_events row that authorized it; a resume row with no signaled_by_event_id is a wake receipt no slice ever paid for',
      NEW."session_id"
      USING ERRCODE = '23514',
            CONSTRAINT = 'session_signals_resume_has_receipt';
  END IF;

  SELECT s."status"::text
    INTO v_status
    FROM public."sessions" s
   WHERE s."room_id" = NEW."room_id"
     AND s."id" = NEW."session_id"
     FOR SHARE OF s;

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

-- The trigger is REPLACED, not merely its function: 0045 fired it on
-- `UPDATE OF room_id, session_id`, and the two new columns the function now
-- reads — `kind` and `signaled_by_event_id` — must be in that list, or an UPDATE
-- that flips a steer into a resume, or nulls a resume's receipt, would never ask.
DROP TRIGGER IF EXISTS "session_signals_target_is_open" ON "session_signals";--> statement-breakpoint
CREATE TRIGGER "session_signals_target_is_open"
  BEFORE INSERT OR UPDATE OF "room_id", "session_id", "kind", "signaled_by_event_id"
  ON "session_signals"
  FOR EACH ROW EXECUTE FUNCTION "atrium_session_signals_target_is_open"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_session_signals_target_is_open"() IS
  'Two table facts about a signal row (#127, #123 resolution 2/3; strengthened in fix round 2). (1) A resume must name its core_events row: authorized_draws is moved by projectSessionSignaled, so a hand-written resume with no signaled_by_event_id is a wake receipt that cost nothing against #118''s slice — the free wake path, reachable around both the command and the projection. (2) A signal targets an OPEN session, read FOR SHARE so a concurrent settle cannot commit under the check — FOR SHARE and not FOR KEY SHARE, because a settle is a plain status UPDATE (FOR NO KEY UPDATE strength) which FOR KEY SHARE does not conflict with. Missing/cross-room sessions fall through to session_signals_session_same_room_fk.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 3. A wait targets an OPEN session — under the same row LOCK (C)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- REPLACES 0045's `atrium_session_subscriptions_target_is_open`, function only:
-- the trigger's INSERT-only firing condition is unchanged and still correct (a
-- wait's own disposition — matched, expired, and above all the DISPOSAL written
-- by `projectSessionExit` in the exit's own transaction — happens precisely when
-- the session is no longer open, so firing on UPDATE would refuse the very
-- disposition this rule exists to make possible).
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
     AND s."id" = NEW."session_id"
     FOR SHARE OF s;

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

COMMENT ON FUNCTION "atrium_session_subscriptions_target_is_open"() IS
  'A durable wait targets an OPEN session (#127, #123 resolution 6): registered against an exited process it can never be matched, only escalated. The status read takes FOR SHARE (fix round 2, finding C) so a concurrent settle cannot commit between the read and this INSERT — FOR SHARE and not FOR KEY SHARE, because a settle is a plain status UPDATE which FOR KEY SHARE does not conflict with. INSERT-only, because a wait''s own disposition (matched/expired/disposed) is written exactly when the session may already be terminal. Missing/cross-room sessions fall through to session_subscriptions_session_same_room_fk.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 4. A WAIT is the agent's or its owner's (B)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The table backstop for `subscribe_session`'s in-command lookup, asking the same
-- lineage question `atrium_session_signals_interrupt_authorized` asks of an
-- interrupt or a resume: `plans.agent_user_id` → `agents.owner_user_id`, and the
-- raiser must be one of the two.
--
-- Why a wait is control and a steer is not: a steer is a message DOWN into a
-- process that is already running, and it changes nothing about how long the
-- process lives. A wait extends the process's life to its horizon, and while the
-- session is open its plan cannot settle (#119). That is a decision about somebody
-- else's plan, so it belongs to the people the plan belongs to.
--
-- A NULL raiser is refused rather than waved through, the fail-closed direction
-- 0018 named: the column is written from the ledger row's trusted actor, and the
-- only actors that carry no user id are `model` and `system` — neither of which
-- is an agent principal or a human owner, so "nobody said who" must not resolve
-- to the privileged answer.
CREATE OR REPLACE FUNCTION "atrium_session_subscriptions_control_authorized"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_agent_user_id uuid;
  v_owner_user_id uuid;
BEGIN
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
      'a wait on session % belongs to agent % or its owner %, not to %',
      NEW."session_id", v_agent_user_id, v_owner_user_id, NEW."raised_by_user_id"
      USING ERRCODE = '23514',
            CONSTRAINT = 'session_subscriptions_control_authorized';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- INSERT and re-pointing UPDATEs only. A wait's lifecycle UPDATEs (status,
-- matched_by_event_id, escalated_at) do not touch these columns and must not be
-- re-judged: the disposal written by `projectSessionExit` runs as the exiting
-- session's own append and has no business re-proving who registered the wait.
CREATE TRIGGER "session_subscriptions_control_authorized"
  BEFORE INSERT OR UPDATE OF "room_id", "session_id", "raised_by_user_id"
  ON "session_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION "atrium_session_subscriptions_control_authorized"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_session_subscriptions_control_authorized"() IS
  'A durable wait on a session belongs to that session''s plan''s agent principal or to that agent''s human owner (#127 fix round 2, gauntlet finding B) — the table backstop for subscribe_session''s in-command lookup, added because the round-1 build had none: grok proved the command clause could be deleted with every test still green, and a bystander''s hand-written wait landed. Registering a wait is control over a process — it decides how long the session stays open and therefore how long its plan cannot settle (#119) — which is why the rule is the interrupt rule and not the steer rule. A NULL raiser fails closed.';
