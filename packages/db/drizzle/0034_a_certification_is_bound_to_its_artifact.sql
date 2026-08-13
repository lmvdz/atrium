-- ═════════════════════════════════════════════════════════════════════════════
-- A CERTIFICATION IS BOUND TO THE ARTIFACT IT SIGNED.
--
-- #121 fix round, finding CS-1. 0032 made "only a human is named as certifier" a
-- table fact and 0033 made the certification write-once. Both left the ARTIFACT —
-- the thing a `✓` is a signature OF — outside the frozen set, and 0033 says so
-- explicitly ("the artifact stays mutable"). Two holes followed:
--
--   1. CERTIFIED WITH NOTHING TO SIGN. `certified_by` could be set on a row whose
--      `artifact` is null. The human `✓` then displayed over a session that
--      produced no reviewable work — a signature on a blank page.
--
--   2. CERTIFIED AT A, DISPLAYED OVER B. `artifact` stayed mutable after
--      certification, so a session certified while its artifact was A could have
--      its artifact rewritten to B, and the same human `✓` then stood over work
--      the person never reviewed. The covenant's whole claim — "this human signed
--      THIS artifact" — was one UPDATE from being false.
--
-- ## 1. no certification without an artifact
--
-- A new BEFORE INSERT OR UPDATE trigger refuses any row that names a certifier
-- while `artifact` is null. The application already refuses to arm or confirm a
-- null-artifact session (apps/web/lib/certify-session.ts); this is the table
-- backstop under that guard, the same relationship 0032/0033's triggers have to
-- their Server Actions.
--
-- ## 2. the artifact is frozen once certified
--
-- `atrium_sessions_certification_immutable` (0033) already freezes the certify
-- and arm columns on a certified row. It is EXTENDED here — same function, CREATE
-- OR REPLACE — to freeze `artifact` too, with the same `IS DISTINCT FROM` shape so
-- a no-op UPDATE that rewrites the identical jsonb passes while any real change is
-- refused. The freeze is still on the certification, not on the session: an
-- uncertified row's artifact stays fully mutable, which is exactly when the
-- ExecutionProvider (#120) writes it.
--
-- Like every trigger in this schema, none of this binds an operator who disables
-- triggers; the same limit 0003 states.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. a certifier requires an artifact to certify
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "atrium_sessions_certify_needs_artifact"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $certify_needs_artifact$
BEGIN
  IF NEW."certified_by" IS NOT NULL AND NEW."artifact" IS NULL THEN
    RAISE EXCEPTION
      'session %: a certification is a signature on an artifact, and this session has none to sign — a %  cannot certify null work',
      NEW."id", NEW."certified_by"
      USING ERRCODE = '23514', CONSTRAINT = 'sessions_certify_needs_artifact';
  END IF;
  RETURN NEW;
END;
$certify_needs_artifact$;--> statement-breakpoint

CREATE TRIGGER "sessions_certify_needs_artifact"
  BEFORE INSERT OR UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION "atrium_sessions_certify_needs_artifact"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_sessions_certify_needs_artifact"() IS
  'Refuses any sessions row whose certified_by is non-null while artifact is null. A certification is a signature OF the reviewed artifact (#121, CS-1): a `✓` over null work is a signature on a blank page. The table backstop under the certify path''s own non-null-artifact guard. Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. the artifact is frozen once certified — EXTENDS 0033's immutability
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
    IF NEW."artifact" IS DISTINCT FROM OLD."artifact" THEN
      RAISE EXCEPTION
        'session % is certified; its artifact is what the human signed and may not change underneath the signature — a `✓` must mean "this human signed THIS artifact"',
        OLD."id"
        USING ERRCODE = '23514', CONSTRAINT = 'sessions_certification_immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$certification_immutable$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_sessions_certification_immutable"() IS
  'Refuses any UPDATE that changes or clears certified_by / certified_at / certified_held_ms, the certify_armed_* pair behind them, or the ARTIFACT the certification signed, on a row that is already certified (#121 CS-1: this human signed THIS artifact). Extends 0033, which froze the certify columns but left the artifact mutable. Leaves every other column mutable, and leaves an uncertified row''s artifact fully mutable. Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint
