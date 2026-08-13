-- ═════════════════════════════════════════════════════════════════════════════
-- A PLAN MAY NOT SETTLE WHILE A CHILD SESSION IS STILL OPEN — A TABLE FACT.
--
-- #119, the mirror of #116 F-A/F-B. F-A (projectSessionOpened) refuses OPENING a
-- session under an already-settled plan; this is the same terminality boundary
-- from the other side — a plan cannot take its exit while a child has not taken
-- its own. The map #113 destination reads "the plan SETTLES to a receipt
-- INDEXING ITS SESSIONS' RECEIPTS", and a receipt cannot index a child receipt
-- that does not exist yet.
--
-- The command path already enforces this: projectPlanSettled
-- (apps/server/src/projections.ts) reads the children `FOR SHARE` under the
-- append lock and throws if any is `open`, so the settle nacks and writes no
-- ledger row. That is the whole of the guarantee ON THE COMMAND PATH — and, like
-- 0025's status freeze before it, it is a property of one writer, not of the
-- table. Raw SQL, a future projection, or a `db.update(plans)` that forgets the
-- read can still close a plan out from under a live child:
--
--     UPDATE plans SET status = 'settled' WHERE id = …;   -- child still open
--
-- and the plan reports done while a session under it is still running, its
-- receipt indexing a child receipt that has not been written. This trigger makes
-- "a plan settles only after its children have exited" a fact of the `plans`
-- table, the same way 0025 made "done is one-way" one — a rule about more than
-- the row's own new value, enforced BEFORE UPDATE, binding every writer that is
-- not an operator disabling triggers (the same limit 0003 states).
--
-- ## The rule, and its exact scope
--
-- Fires ONLY on the open → settled transition (`NEW.status = 'settled'` AND it is
-- DISTINCT FROM OLD.status). On that transition, if any child session of this
-- plan is still `status = 'open'`, the settle is refused. Deliberately narrow:
--
--   * A no-op re-write of an already-settled plan (OLD = NEW = 'settled') does
--     not fire — nothing transitions — and is handled by 0025's terminal freeze.
--   * An `updated_at` / `spent_micros` touch on an open OR settled plan does not
--     fire — status does not become 'settled' from something else.
--   * A plan with NO sessions, or one whose children are all settled/failed,
--     settles cleanly — the EXISTS finds no open child.
--
-- `::text` on the status compares keeps the house style 0017/0025/0030 use, and
-- the cross-table read is `public."sessions"`-qualified because the function pins
-- `search_path = pg_catalog, pg_temp` (the same reason 0027 writes `public."users"`).
-- The session-side terminality (a child cannot un-exit and re-open under a settled
-- parent) is already a table fact via 0025's sessions_terminal_immutable, so this
-- and 0025 together close the ordering from both directions.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "atrium_plans_settle_needs_children_exited"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $settle$
BEGIN
  IF NEW."status"::text = 'settled' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF EXISTS (
      SELECT 1 FROM public."sessions"
      WHERE "plan_id" = NEW."id" AND "status"::text = 'open'
    ) THEN
      RAISE EXCEPTION
        'plan % may not settle: a child session is still open, and a settled plan''s receipt must index its sessions'' receipts — settle or fail every session first',
        NEW."id"
        USING ERRCODE = '23514', CONSTRAINT = 'plans_settle_needs_children_exited';
    END IF;
  END IF;
  RETURN NEW;
END;
$settle$;--> statement-breakpoint

CREATE TRIGGER "plans_settle_needs_children_exited"
  BEFORE UPDATE ON "plans"
  FOR EACH ROW EXECUTE FUNCTION "atrium_plans_settle_needs_children_exited"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_plans_settle_needs_children_exited"() IS
  'Refuses the open → settled transition on a plan while any child session is still status=open. Makes "a plan settles only after its children have exited" (#119, the mirror of #116 F-A) a property of the plans table rather than only of projectPlanSettled''s FOR SHARE read, so raw SQL or a future code path cannot close a plan out from under a live child and leave a receipt that indexes a child receipt not yet written. Fires only on the actual transition into settled — a no-op re-settle, an updated_at touch, or a spend rollup does not trip it. Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint

COMMENT ON TRIGGER "plans_settle_needs_children_exited" ON "plans" IS
  'BEFORE UPDATE. See atrium_plans_settle_needs_children_exited. The DB backstop under #119: even if projectPlanSettled''s open-child read regressed, a plan with an open child session cannot be settled here.';
