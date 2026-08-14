-- ═════════════════════════════════════════════════════════════════════════════
-- A CERTIFICATION'S RECEIPT IS INTERNALLY CONSISTENT, OR IT IS NOT WRITTEN.
--
-- #121 fix round, round-5 finding 4. 0035 made a certification carry a COMPLETE
-- receipt — arm, held-ms, stamp, all present, held-ms at least the gate. It did
-- not check that the parts AGREE with each other, and the gauntlet found a
-- fabricated shape that satisfied every one of 0035's individual clauses while
-- describing a hold that never happened:
--
--     UPDATE sessions SET
--       certify_armed_at   = now(),      -- present  (0035 satisfied)
--       certified_at       = now(),      -- present  (0035 satisfied)
--       certified_held_ms  = 2000,       -- >= gate  (0035 satisfied)
--       certified_by       = <a human>   -- humanity trigger satisfied
--       -- certify_armed_by left NULL, status left 'open'
--
-- Three lies hide in a row 0035 accepts:
--
--   1. NOBODY ARMED IT. `certify_armed_by` is null while `certified_by` names a
--      person — a signature over a hold no identity performed. The armer and the
--      certifier must be the SAME person (the app enforces it; here is the table
--      backstop, the twin of 0032/0033/0034/0035).
--   2. THE PROCESS NEVER SETTLED. `status` is 'open' — there is no landing to
--      certify. The app refuses a non-settled arm and confirm; the table now
--      refuses the row.
--   3. THE HELD DURATION IS INVENTED. `certified_held_ms` claims 2000ms of hold,
--      but `certified_at - certify_armed_at` is ZERO — the two stamps are the same
--      instant. A recorded hold that does not match the interval its own two
--      timestamps bracket is not a measurement; it is a number typed into a
--      column. The recorded duration must agree with the elapsed interval (within
--      a small slack for the millisecond gap between the confirm's SELECT and its
--      UPDATE), and that interval must itself meet the gate.
--
-- BEFORE INSERT OR UPDATE, checking NEW only: a certification is complete and
-- coherent the instant `certified_by` is set, whether inserted that way or updated
-- into it. No cross-table read.
--
-- FIRING ORDER. Postgres fires row-level BEFORE triggers alphabetically by trigger
-- NAME, and this one is named to sort LAST of the certify family
-- (`certify_receipt_consistent` > `certify_receipt_complete` (0035) >
-- `certify_needs_artifact` (0034) > `certify_armed_by_is_human` (0033) >
-- `certified_by_is_human` (0032); `certification_immutable` sorts first of all).
-- That precedence is deliberate: "is the certifier a human", "is there an
-- artifact", "is the receipt even complete" are more fundamental than "do its
-- parts agree", so an agent name, a null artifact or a missing stamp still raises
-- ITS message rather than this one. Consistency is the last gate.
--
-- Like every trigger in this schema, none of this binds an operator who disables
-- triggers; the same limit 0003 states.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "public"."atrium_sessions_certify_receipt_consistent"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $certify_receipt_consistent$
DECLARE
  elapsed_ms double precision;
  -- The gate, repeated from apps/web/lib/certify-hold.ts (a trigger cannot import
  -- it) — the same 2000 drizzle/0035 carries, for the same reason.
  gate_ms constant integer := 2000;
  -- The tolerance for the interval between the confirm's SELECT (which measures
  -- certified_held_ms) and its UPDATE (which stamps certified_at). Milliseconds in
  -- practice; 1000ms is generous and still an order of magnitude under the smallest
  -- lie the fabricated shape tells (2000ms of hold across a 0ms interval).
  slack_ms constant integer := 1000;
BEGIN
  IF NEW."certified_by" IS NULL THEN
    RETURN NEW;
  END IF;

  -- 1. THE ARMER IS THE CERTIFIER. One person's hold, that same person's signature.
  IF NEW."certify_armed_by" IS DISTINCT FROM NEW."certified_by" THEN
    RAISE EXCEPTION
      'session %: certified_by is % but certify_armed_by is % — the person who armed the hold and the person who signed it must be the same, or the signature names a hold nobody performed',
      NEW."id", NEW."certified_by", NEW."certify_armed_by"
      USING ERRCODE = '23514', CONSTRAINT = 'sessions_certify_receipt_consistent';
  END IF;

  -- 2. THE PROCESS SETTLED. There is no landing to certify on an open or failed one.
  --    `::text` to compare the enum against the literal, the convention every other
  --    status check in this schema follows (drizzle/0031).
  IF NEW."status"::text <> 'settled' THEN
    RAISE EXCEPTION
      'session %: certified_by is set but status is % — only a settled process has produced a landing to certify',
      NEW."id", NEW."status"
      USING ERRCODE = '23514', CONSTRAINT = 'sessions_certify_receipt_consistent';
  END IF;

  -- 3. THE RECORDED HOLD AGREES WITH THE INTERVAL ITS OWN STAMPS BRACKET, and that
  --    interval meets the gate. certify_armed_at / certified_at are guaranteed
  --    non-null here by drizzle/0035, which fires first.
  elapsed_ms := extract(epoch from (NEW."certified_at" - NEW."certify_armed_at")) * 1000;
  IF elapsed_ms < gate_ms THEN
    RAISE EXCEPTION
      'session %: the interval between the arm and the signature is %ms, under the %ms gate — the arm and certified_at describe a hold shorter than the covenant requires, whatever certified_held_ms claims',
      NEW."id", round(elapsed_ms), gate_ms
      USING ERRCODE = '23514', CONSTRAINT = 'sessions_certify_receipt_consistent';
  END IF;
  IF NEW."certified_held_ms" > elapsed_ms + slack_ms
     OR NEW."certified_held_ms" < elapsed_ms - slack_ms THEN
    RAISE EXCEPTION
      'session %: certified_held_ms is %ms but the arm→signature interval is %ms — the recorded hold does not match the time that actually elapsed, so it is a claim rather than a measurement',
      NEW."id", NEW."certified_held_ms", round(elapsed_ms)
      USING ERRCODE = '23514', CONSTRAINT = 'sessions_certify_receipt_consistent';
  END IF;

  RETURN NEW;
END;
$certify_receipt_consistent$;--> statement-breakpoint

CREATE TRIGGER "sessions_certify_receipt_consistent"
  BEFORE INSERT OR UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION "public"."atrium_sessions_certify_receipt_consistent"();--> statement-breakpoint

COMMENT ON FUNCTION "public"."atrium_sessions_certify_receipt_consistent"() IS
  'Refuses any sessions row whose certified_by is non-null while its receipt is internally INCONSISTENT: certify_armed_by is not the certifier, status is not settled, the arm→signature interval is under the 2000ms gate, or certified_held_ms disagrees with that interval beyond a 1s slack (#121 round-5 finding 4). Where 0035 checks each part is present, this checks the parts agree — closing the fabricated complete receipt (armer=null, armed_at==certified_at, held_ms=2000, status=open) that satisfied every one of 0035''s individual clauses. Sorts last of the certify family so the more fundamental refusals raise their own message first. Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint
