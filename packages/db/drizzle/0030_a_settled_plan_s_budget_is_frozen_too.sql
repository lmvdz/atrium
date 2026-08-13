-- ═════════════════════════════════════════════════════════════════════════════
-- A SETTLED PLAN'S BUDGET IS PART OF ITS RECEIPT — FROZEN, LIKE ITS STATUS.
--
-- #118 fix r2, MED-7. 0025 made a terminal plan's `status` and
-- `settled_by_event_id` table facts (a settled plan cannot be reopened or its
-- receipt pointer rewritten). #118 then added two more columns that are part of
-- what a plan's closed contract MEANS: `rlimit_slice` (the human-set ceiling this
-- plan was funded to) and `authorized_draws` (how many draws it was granted).
-- 0025 predates them and so froze neither. On a settled plan they are raw-mutable:
--
--     UPDATE plans SET rlimit_slice = 999      WHERE id = … AND status = 'settled';
--     UPDATE plans SET authorized_draws = 0    WHERE id = … AND status = 'settled';
--
-- and the closed plan's funding history is rewritable after the fact — a slice
-- raised on a plan that can no longer draw, or an authorized-draw count moved away
-- from the `count(sessions)` it is an invariant against. Neither is reachable on
-- the command path (`projectPlanRlimitSet` scopes its write to `status = 'open'`,
-- and `projectSessionOpened`'s increment only fires for an open plan), exactly as
-- 0025's status freeze was already true of the projection — the trigger makes it
-- true of the TABLE, for any writer that is not an operator disabling triggers.
--
-- ## The mechanism: CREATE OR REPLACE, two more frozen fields
--
-- The same `atrium_plans_terminal_immutable` function 0025 installed, redefined to
-- add the two columns to what it freezes once `OLD.status = 'settled'`.
-- `IS DISTINCT FROM` throughout, so a no-op UPDATE that rewrites the same terminal
-- values still passes (it changes nothing) while any real change to a frozen field
-- is refused. The legitimate open → settled transition is untouched: OLD is `open`
-- there, so the guard is skipped and the settling UPDATE passes exactly as before.
-- `spent_micros` (the adapter's dollar rollup) stays mutable, deliberately — the
-- freeze is on the enforcement receipt, not on the reconciliation layer, the same
-- line 0025 drew for `updated_at`/`spent_micros`.
--
-- The trigger and its wiring are unchanged; only the function body grows, so no
-- DROP/CREATE TRIGGER is needed. `::text` on the status compare keeps the house
-- style 0025 uses.
-- ═════════════════════════════════════════════════════════════════════════════

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
    IF NEW."rlimit_slice" IS DISTINCT FROM OLD."rlimit_slice"
       OR NEW."authorized_draws" IS DISTINCT FROM OLD."authorized_draws" THEN
      RAISE EXCEPTION
        'plan % is settled; its budget receipt (rlimit_slice, authorized_draws) is frozen with the rest of its contract and may not be rewritten after the plan has closed (#118 MED-7)',
        OLD."id"
        USING ERRCODE = '23514', CONSTRAINT = 'plans_terminal_immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$terminal$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_plans_terminal_immutable"() IS
  'Refuses any UPDATE that moves a settled plan out of settled, rewrites its settled_by_event_id receipt pointer, or (since #118 MED-7) changes its frozen budget receipt rlimit_slice / authorized_draws. Makes "one exit per plan" and "a closed plan''s funding history is final" properties of the plans table rather than only of projectPlanSettled / projectPlanRlimitSet / projectSessionOpened''s status=open predicates, so raw SQL or a future code path cannot reopen a closed plan, re-settle it, raise the slice on a plan that can no longer draw, or move authorized_draws away from its count(sessions) invariant. Leaves updated_at and spent_micros mutable — the freeze is on the receipt, not the row. Does not bind an operator who disables triggers; the same limit 0003 states.';
