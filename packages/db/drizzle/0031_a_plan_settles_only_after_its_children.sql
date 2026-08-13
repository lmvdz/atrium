-- ═════════════════════════════════════════════════════════════════════════════
-- A PLAN MAY NOT SETTLE WHILE A CHILD SESSION IS STILL OPEN — A SEQUENTIAL-WRITE
-- BACKSTOP, NOT A CONCURRENCY GUARANTEE.
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
-- ledger row. Concurrency ON THE COMMAND PATH is not this trigger's doing at
-- all — it is the ONE global advisory lock every append takes
-- (`pg_advisory_xact_lock`, ledger.ts) before doing any of its reads, which
-- serializes projectPlanSettled's open-child read against
-- projectSessionOpened's insert so there is no interleaving in which both win.
-- That lock is the production concurrency guarantee, full stop.
--
-- This trigger is a DIFFERENT, narrower thing: a backstop against raw SQL, a
-- future projection, or a `db.update(plans)` that forgets the read and would
-- otherwise close a plan out from under a live child SEQUENTIALLY:
--
--     UPDATE plans SET status = 'settled' WHERE id = …;   -- child still open
--
-- and the plan reports done while a session under it is still running, its
-- receipt indexing a child receipt that has not been written. `BEFORE UPDATE
-- ... EXISTS` is a fine backstop against exactly that — a writer that runs its
-- statement and commits before any other transaction gets a look in. It is NOT
-- a substitute for serialization: two RAW transactions that bypass the ledger
-- (an operator script issuing `UPDATE plans` and `INSERT INTO sessions`
-- directly, outside `ledger.ts`'s advisory lock) can still race each other —
-- this trigger's `EXISTS` cannot see an uncommitted concurrent INSERT any more
-- than a `SELECT` in one session sees another session's in-flight, not-yet-
-- committed write under READ COMMITTED. Making that trigger take its own lock
-- (e.g. serializing every settle against every open on the same plan) would be
-- an inconsistent, one-off architectural response to a non-production threat —
-- raw concurrent writers bypassing the ledger are not a path any real client
-- reaches — so this stays what 0025's and #118's 0030 terminal triggers already
-- are: a fact about SEQUENTIAL writes to the table, binding every writer that is
-- not an operator disabling triggers (the same limit 0003 states), and silent on
-- concurrent raw writers by construction. The command path's advisory lock is
-- what closes that door; this trigger is defense-in-depth behind it, not a
-- second lock.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- F2 (#119 fix round 2, migration hygiene): VALIDATE BEFORE INSTALLING.
--
-- The trigger below only guards FUTURE updates — it fires on the transition
-- into 'settled', which means it says nothing about a row that already MADE
-- that transition before this migration ran. Between 0022 (when `plans` and
-- `sessions` first existed) and 0030, nothing in the schema stopped a plan from
-- settling with an open child — that gap is exactly what #119 closes. If any
-- such row survived into this migration, installing the trigger on top of it
-- would silently declare an invariant the data already violates: a fresh
-- `migrate` on a clean database sees no such rows and this block is a no-op,
-- but a `migrate` against dirty data with a genuine pre-existing violation
-- FAILS LOUDLY here, before the trigger is even created — which is correct:
-- you cannot install "a plan settles only after its children have exited" as a
-- fact of the table while a row on the table already contradicts it. The
-- schema and the data agreeing is a precondition for this migration, not an
-- afterthought it can paper over.
-- ─────────────────────────────────────────────────────────────────────────────

DO $atrium_0031_preexisting_violation_guard$
DECLARE
  violation_count integer;
BEGIN
  SELECT count(*) INTO violation_count
  FROM public."plans" p
  WHERE p."status"::text = 'settled'
    AND EXISTS (
      SELECT 1 FROM public."sessions" s
      WHERE s."plan_id" = p."id" AND s."status"::text = 'open'
    );
  IF violation_count > 0 THEN
    RAISE EXCEPTION
      'migration 0031 refuses to install: % plan(s) are already settled while a child session under them is still open — this migration makes "a plan settles only after its children have exited" a fact of the plans table, and cannot do so on top of data that already violates it (a gap possible between 0022 and 0030, before #119). Settle or fail every open child under each of those plans, or otherwise resolve the pre-existing violation, before re-running this migration',
      violation_count;
  END IF;
END;
$atrium_0031_preexisting_violation_guard$;--> statement-breakpoint

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
  'Refuses the SEQUENTIAL open → settled transition on a plan while any child session is still status=open. Makes "a plan settles only after its children have exited" (#119, the mirror of #116 F-A) a property of the plans table rather than only of projectPlanSettled''s FOR SHARE read, so raw SQL or a future code path that runs and commits before another writer gets a look in cannot close a plan out from under a live child and leave a receipt that indexes a child receipt not yet written. Fires only on the actual transition into settled — a no-op re-settle, an updated_at touch, or a spend rollup does not trip it. Does NOT serialize two CONCURRENT raw writers bypassing the ledger (this EXISTS read cannot see an uncommitted concurrent INSERT any more than any other READ COMMITTED read can) — that guarantee, for every production path, is the command path''s ONE global advisory lock (pg_advisory_xact_lock, ledger.ts), not this trigger. Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint

COMMENT ON TRIGGER "plans_settle_needs_children_exited" ON "plans" IS
  'BEFORE UPDATE. See atrium_plans_settle_needs_children_exited. A sequential-write backstop under #119: even if projectPlanSettled''s open-child read regressed, a plan with an open child session cannot be settled here by a writer that runs and commits alone. It is defense-in-depth behind the command path''s advisory lock, not a replacement for it — it does not by itself serialize two concurrent raw writers racing outside the ledger.';
