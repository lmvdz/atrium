-- ═════════════════════════════════════════════════════════════════════════════
-- A SETTLED OR FAILED ROW IS DONE, AND "DONE" IS A TABLE FACT, NOT AN OPINION.
--
-- #116 fix r3, finding F-B. The application already enforces one-exit-per-plan
-- and one-exit-per-session: `projectPlanSettled` and `projectSessionExit`
-- (apps/server/src/projections.ts) scope their UPDATE with `status = 'open'` and
-- throw on a zero-row result, so the second settle nacks and writes no ledger
-- row. That is the whole of the guarantee ON THE COMMAND PATH — and it is a
-- guarantee about the projection, not about the table.
--
-- Raw SQL, a future projection, a migration, or a `db.update(plans)` that forgets
-- the predicate can still reopen a terminal row:
--
--     UPDATE plans    SET status = 'open'  WHERE id = …;   -- and then re-settle
--     UPDATE sessions SET status = 'open', exit_summary = NULL WHERE id = …;
--
-- and the plan/session that reported done is live again, its receipt rewritable.
-- The one-exit invariant was never true of the TABLE; it was true of one writer.
--
-- These two triggers make it a table fact, the same way 0017 made
-- `principal_kind` immutable and 0021 anchored the ownership chain: a rule about
-- more than the row's own new value, enforced BEFORE UPDATE, so it binds every
-- writer that is not an operator disabling triggers (the same limit 0003 states).
--
-- ## The rule, and its exact scope
--
-- A terminal row is FROZEN in the two things a receipt is made of: its terminal
-- `status`, and the exit columns that record HOW it ended. Once terminal:
--
--   * `plans`    — `status` may not change (no settled → open), and
--     `settled_by_event_id` may not change (the receipt pointer is written once).
--   * `sessions` — `status` may not change (no settled/failed → open, and no
--     settled ↔ failed flip), and none of `exit_summary` / `spend_micros` /
--     `context_pct` / `settled_by_event_id` may change (the exit receipt is
--     written once).
--
-- Deliberately NOT frozen: `updated_at`, and `plans.spent_micros` (the sessions'
-- spend rollup). The freeze is on the receipt, not on the row — so nothing here
-- forbids an `updated_at` touch or a spend rollup, only a rewrite of what the
-- exit said. `IS DISTINCT FROM` throughout, so a no-op UPDATE that re-writes the
-- same terminal values is permitted (it changes nothing) while any real change
-- to a frozen field is refused.
--
-- The legitimate open → settled / open → failed transition is untouched: OLD is
-- `open` there, so the guard's `IF OLD.status is terminal` is false and the
-- projection's UPDATE passes exactly as before.
--
-- Comparisons are written through `::text`, the house style since 0017 — the
-- labels all exist (0022 created both enums), so this is convention rather than
-- necessity, but it keeps the trigger free of any enum-label-resolution concern.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. plans — a settled plan is one-way
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "atrium_plans_terminal_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $terminal$
BEGIN
  IF OLD."status"::text = 'settled' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION
        'plan % is settled and may not be reopened to %; a settled plan''s receipt has closed, and one exit per plan is a table fact, not only a projection predicate',
        OLD."id", NEW."status"
        USING ERRCODE = '23514', CONSTRAINT = 'plans_terminal_immutable';
    END IF;
    IF NEW."settled_by_event_id" IS DISTINCT FROM OLD."settled_by_event_id" THEN
      RAISE EXCEPTION
        'plan % is settled; its settled_by_event_id receipt pointer is written once and may not be rewritten',
        OLD."id"
        USING ERRCODE = '23514', CONSTRAINT = 'plans_terminal_immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$terminal$;--> statement-breakpoint

CREATE TRIGGER "plans_terminal_immutable"
  BEFORE UPDATE ON "plans"
  FOR EACH ROW EXECUTE FUNCTION "atrium_plans_terminal_immutable"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_plans_terminal_immutable"() IS
  'Refuses any UPDATE that moves a settled plan out of settled or rewrites its settled_by_event_id receipt pointer. Makes "one exit per plan" a property of the plans table rather than only of projectPlanSettled''s status=open predicate, so raw SQL or a future code path cannot reopen a closed plan and re-settle it. Leaves updated_at and spent_micros mutable — the freeze is on the receipt, not the row. Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint

COMMENT ON TRIGGER "plans_terminal_immutable" ON "plans" IS
  'BEFORE UPDATE. See atrium_plans_terminal_immutable. The DB backstop under #116 F-A: even if the session-open path''s plan-status check regressed, a settled plan cannot be reopened here.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. sessions — a settled/failed session is one-way, and its receipt is final
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "atrium_sessions_terminal_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $terminal$
BEGIN
  IF OLD."status"::text IN ('settled', 'failed') THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION
        'session % is % and may not become %; a session takes exactly one exit, and settled ↔ failed is two contradictory receipts for one process',
        OLD."id", OLD."status", NEW."status"
        USING ERRCODE = '23514', CONSTRAINT = 'sessions_terminal_immutable';
    END IF;
    IF NEW."exit_summary" IS DISTINCT FROM OLD."exit_summary"
       OR NEW."spend_micros" IS DISTINCT FROM OLD."spend_micros"
       OR NEW."context_pct" IS DISTINCT FROM OLD."context_pct"
       OR NEW."settled_by_event_id" IS DISTINCT FROM OLD."settled_by_event_id" THEN
      RAISE EXCEPTION
        'session % is %; its exit receipt (exit_summary, spend_micros, context_pct, settled_by_event_id) is written once and may not be rewritten',
        OLD."id", OLD."status"
        USING ERRCODE = '23514', CONSTRAINT = 'sessions_terminal_immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$terminal$;--> statement-breakpoint

CREATE TRIGGER "sessions_terminal_immutable"
  BEFORE UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION "atrium_sessions_terminal_immutable"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_sessions_terminal_immutable"() IS
  'Refuses any UPDATE that moves a settled or failed session out of its terminal status, or rewrites any of its exit receipt columns (exit_summary, spend_micros, context_pct, settled_by_event_id). Makes "one exit per session" and "settled cannot flip to failed" table facts rather than only projectSessionExit''s status=open predicate. Leaves updated_at mutable — the freeze is on the receipt, not the row. Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint

COMMENT ON TRIGGER "sessions_terminal_immutable" ON "sessions" IS
  'BEFORE UPDATE. See atrium_sessions_terminal_immutable. The DB backstop under #116 F-A/F-B: a session that already exited cannot be reopened or have its receipt rewritten by any writer that does not disable triggers.';
