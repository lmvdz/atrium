-- ═════════════════════════════════════════════════════════════════════════════
-- A CERTIFICATION IS ARMED BY THE SERVER, AND ONCE MADE IT IS WRITTEN ONCE.
--
-- #121 fix round, findings CS-2 and the certification-immutability gap. 0032 made
-- "only a human may be named as the certifier" a table fact. It left two other
-- halves of the same covenant act to the application, and the application did not
-- hold them:
--
--   1. THE HOLD WAS MEASURED ON THE CLIENT. The Server Action accepted `armedAt`
--      and `heldMs` off the request body and wrote them straight into
--      `certified_at` / `certified_held_ms`. A request claiming `heldMs: 999999`
--      certified a session having held nothing; a request claiming `heldMs: 0`
--      did too. The asymmetric friction CONVENTIONS asks for existed only in the
--      browser, which is the side that is not trusted.
--
--   2. A CERTIFICATION COULD BE REWRITTEN OR CLEARED. `sessions_terminal_immutable`
--      (0025) deliberately leaves the certify columns mutable so a human can
--      certify AFTER settle — and nothing then froze them, so
--      `UPDATE sessions SET certified_by = NULL` un-landed a landed session, and
--      a second UPDATE could re-attribute a human's `~`→certification to somebody
--      else. A record of a human act that any writer can rewrite is not a record.
--
-- ## 1. The arm columns
--
-- `certify_armed_by` / `certify_armed_at` hold a PENDING arm. The application
-- writes `certify_armed_at` as `now()` evaluated by Postgres — the value never
-- crosses the wire — and certification computes `now() - certify_armed_at` in SQL
-- and refuses anything shorter than the required hold. `certified_held_ms` is then
-- a measurement of the interval between two server clock reads, and a request that
-- never armed has nothing to subtract from and is refused outright.
--
-- `SET NULL` on the armer's deletion, matching `certified_by`: an arm outlives
-- nobody, and a dangling pending arm that resolves to no identity must not certify.
--
-- ## 2. The armer is a human, like the certifier
--
-- Modelled on 0032's `sessions_certified_by_is_human`, which is itself modelled on
-- 0021's `agents_owner_is_human`. The arm is half of the human-only act: letting a
-- machine arm and a human confirm would split the covenant's second pair of eyes
-- across two principals, and the hold — the whole point of the friction — would
-- have been performed by the thing being checked.
--
-- Note the `public."users"` qualification. Every trigger function in this schema
-- carries `SET search_path = pg_catalog, pg_temp`, which deliberately excludes
-- `public`; an unqualified cross-table read inside one does not resolve. 0032 does
-- the same, and this is the same rule, not a second one.
--
-- ## 3. The certification is write-once
--
-- Once `certified_by` is non-null, none of `certified_by` / `certified_at` /
-- `certified_held_ms` may change, and neither may the arm columns that produced
-- them: the arm is the evidence for the held duration, so a rewritable arm is a
-- rewritable receipt one inference away. `IS DISTINCT FROM` throughout, so a
-- no-op UPDATE that re-writes identical values passes (it changes nothing) while
-- any real change is refused — the same shape 0025 uses.
--
-- Deliberately NOT frozen: everything else on the row. The freeze is on the
-- certification, not on the session; `updated_at` and the artifact stay mutable.
--
-- Clearing counts as changing: `SET certified_by = NULL` is `IS DISTINCT FROM` a
-- uuid, so un-landing is refused by the same branch that refuses re-attribution.
-- That is the case the application's `isNull(certified_by)` write predicate could
-- never see, because it only ever guarded the transition INTO certification.
--
-- Like every trigger in this schema, none of this binds an operator who disables
-- triggers; the same limit 0003 states.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "sessions" ADD COLUMN "certify_armed_by" uuid;--> statement-breakpoint

ALTER TABLE "sessions" ADD COLUMN "certify_armed_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_certify_armed_by_fk"
  FOREIGN KEY ("certify_armed_by") REFERENCES "public"."users"("id") ON DELETE set null;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. the armer is a human — the same gate 0032 puts on the certifier
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "atrium_sessions_certify_armed_by_is_human"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $certify_armed_by_is_human$
DECLARE
  v_kind text;
BEGIN
  IF NEW."certify_armed_by" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT u."principal_kind"::text INTO v_kind
  FROM public."users" u WHERE u."id" = NEW."certify_armed_by";
  IF v_kind IS NULL THEN
    RAISE EXCEPTION
      'session %: the armer "%" is not an identity in this database', NEW."id", NEW."certify_armed_by"
      USING ERRCODE = '23514', CONSTRAINT = 'sessions_certify_armed_by_is_human';
  END IF;
  IF v_kind <> 'human' THEN
    RAISE EXCEPTION
      'session %: the armer "%" is a % principal, but arming a certification is half of a human-only act — a machine may not hold the control whose hold is the confirmation', NEW."id", NEW."certify_armed_by", v_kind
      USING ERRCODE = '23514', CONSTRAINT = 'sessions_certify_armed_by_is_human';
  END IF;
  RETURN NEW;
END;
$certify_armed_by_is_human$;--> statement-breakpoint

CREATE TRIGGER "sessions_certify_armed_by_is_human"
  BEFORE INSERT OR UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION "atrium_sessions_certify_armed_by_is_human"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_sessions_certify_armed_by_is_human"() IS
  'Refuses any sessions row whose certify_armed_by names a users row that is not principal_kind=human. Allows NULL (nothing armed). The arm is half of the human-only certification (#121): a machine that could arm would be performing the hold that is the confirmation. Qualifies public."users" because the function sets search_path = pg_catalog, pg_temp — the house style, which excludes public. No row lock: principal_kind is immutable (0017). Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint

COMMENT ON TRIGGER "sessions_certify_armed_by_is_human" ON "sessions" IS
  'BEFORE INSERT OR UPDATE. See atrium_sessions_certify_armed_by_is_human. The twin of sessions_certified_by_is_human (0032), on the other half of the act.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. a certification is written once — no rewrite, no clear
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "atrium_sessions_certification_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $certification_immutable$
BEGIN
  IF OLD."certified_by" IS NOT NULL THEN
    IF NEW."certified_by" IS DISTINCT FROM OLD."certified_by"
       OR NEW."certified_at" IS DISTINCT FROM OLD."certified_at"
       OR NEW."certified_held_ms" IS DISTINCT FROM OLD."certified_held_ms" THEN
      RAISE EXCEPTION
        'session % is certified by %; a certification is a human act recorded once and may not be rewritten, re-attributed or cleared — un-landing a landed session would erase the one signature the covenant requires',
        OLD."id", OLD."certified_by"
        USING ERRCODE = '23514', CONSTRAINT = 'sessions_certification_immutable';
    END IF;
    IF NEW."certify_armed_by" IS DISTINCT FROM OLD."certify_armed_by"
       OR NEW."certify_armed_at" IS DISTINCT FROM OLD."certify_armed_at" THEN
      RAISE EXCEPTION
        'session % is certified; the arm that produced its held duration is part of that receipt and may not be rewritten',
        OLD."id"
        USING ERRCODE = '23514', CONSTRAINT = 'sessions_certification_immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$certification_immutable$;--> statement-breakpoint

CREATE TRIGGER "sessions_certification_immutable"
  BEFORE UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION "atrium_sessions_certification_immutable"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_sessions_certification_immutable"() IS
  'Refuses any UPDATE that changes or clears certified_by / certified_at / certified_held_ms, or the certify_armed_* pair behind them, on a row that is already certified. Makes "one certification, once" a property of the sessions table rather than only of the certify path''s isNull(certified_by) predicate — which guarded the transition INTO certification and could not see an UPDATE that cleared it back out. Leaves every other column mutable: the freeze is on the certification, not on the session. Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint

COMMENT ON TRIGGER "sessions_certification_immutable" ON "sessions" IS
  'BEFORE UPDATE. See atrium_sessions_certification_immutable. The DB backstop under #121: a landed session cannot be un-landed or re-attributed by any writer that does not disable triggers.';--> statement-breakpoint
