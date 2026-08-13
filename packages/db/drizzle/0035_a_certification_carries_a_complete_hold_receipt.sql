-- ═════════════════════════════════════════════════════════════════════════════
-- A CERTIFICATION CARRIES A COMPLETE HOLD RECEIPT, OR IT IS NOT WRITTEN.
--
-- #121 fix round, finding CS-2. 0032 and 0033 put a DB backstop under HUMANITY
-- (the certifier is a person) and under WRITE-ONCE (a certification is not
-- rewritten). The HOLD itself had none: nothing at the table stopped
-- `UPDATE sessions SET certified_by = <a human uuid>` on its own, leaving
-- `certify_armed_at`, `certified_held_ms` and `certified_at` all null. The
-- humanity trigger accepts that row — the name IS a human — and a render that
-- reads name + kind alone then mints `✓` from it: a certification with no hold
-- behind it, the asymmetric friction the covenant requires reduced to a single
-- column write.
--
-- The arm→confirm path in the application always writes the four together, in the
-- right order, measured by the server (apps/web/lib/certify-session.ts). This is
-- the table backstop under that path, the twin of 0032/0033: `certified_by` may
-- become (or be inserted) non-null ONLY when the whole receipt is present —
--
--   * `certify_armed_at`   — the hold was armed (there was an interval to measure);
--   * `certified_held_ms`  — a measured duration, and one AT LEAST the server's
--                            gate (CERTIFY_REQUIRED_HOLD_MS = 2000ms; the value is
--                            the covenant's 2s, written in apps/web/lib/certify-hold.ts
--                            and repeated here because a trigger cannot import it);
--   * `certified_at`       — the moment it was stamped.
--
-- A row missing any part is an incomplete certification and RAISES. The render
-- (src/components/control/state.ts `sessionCertified`) fails closed on the same
-- shape independently — belt and braces, the way an unreadable principal kind is
-- refused in both places.
--
-- BEFORE INSERT OR UPDATE, checking NEW only: a certification is complete the
-- instant `certified_by` is set, whether the row is inserted that way or updated
-- into it. No cross-table read, so the house `search_path` needs no qualification
-- here.
--
-- FIRING ORDER IS DELIBERATE. Postgres fires row-level BEFORE triggers in
-- alphabetical order by trigger NAME, and this one is named to sort LAST of the
-- certify triggers (`certify_receipt_complete` > `certified_by_is_human` (0032) >
-- `certify_armed_by_is_human` (0033) > `certify_needs_artifact` (0034)). That is
-- the right precedence: "is the certifier even a human, and is there an artifact"
-- are more fundamental than "is the hold receipt complete", so an agent name or a
-- null artifact still raises ITS message rather than this one. Completeness is the
-- last gate, not the first.
--
-- Like every trigger in this schema, none of this binds an operator who disables
-- triggers; the same limit 0003 states.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "atrium_sessions_certify_receipt_complete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $certify_receipt_complete$
BEGIN
  IF NEW."certified_by" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."certify_armed_at" IS NULL THEN
    RAISE EXCEPTION
      'session %: certified_by is set but certify_armed_at is null — a certification with no hold behind it is not a certification (the covenant''s asymmetric friction, enforced here)', NEW."id"
      USING ERRCODE = '23514', CONSTRAINT = 'sessions_certify_receipt_complete';
  END IF;
  IF NEW."certified_at" IS NULL THEN
    RAISE EXCEPTION
      'session %: certified_by is set but certified_at is null — a signature carries the moment it was made', NEW."id"
      USING ERRCODE = '23514', CONSTRAINT = 'sessions_certify_receipt_complete';
  END IF;
  IF NEW."certified_held_ms" IS NULL THEN
    RAISE EXCEPTION
      'session %: certified_by is set but certified_held_ms is null — a hold that measured nothing is not a hold', NEW."id"
      USING ERRCODE = '23514', CONSTRAINT = 'sessions_certify_receipt_complete';
  END IF;
  IF NEW."certified_held_ms" < 2000 THEN
    RAISE EXCEPTION
      'session %: certified_held_ms % is under the server hold gate (2000ms) — the friction the covenant requires was not met', NEW."id", NEW."certified_held_ms"
      USING ERRCODE = '23514', CONSTRAINT = 'sessions_certify_receipt_complete';
  END IF;
  RETURN NEW;
END;
$certify_receipt_complete$;--> statement-breakpoint

CREATE TRIGGER "sessions_certify_receipt_complete"
  BEFORE INSERT OR UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION "atrium_sessions_certify_receipt_complete"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_sessions_certify_receipt_complete"() IS
  'Refuses any sessions row whose certified_by is non-null while any part of its hold receipt is missing — certify_armed_at, certified_at, certified_held_ms — or whose certified_held_ms is under the server gate (2000ms, CERTIFY_REQUIRED_HOLD_MS). Makes "a `✓` requires a held human signature, not a name in a column" a table fact (#121 CS-2), the twin of 0032 (humanity) and 0033 (write-once). The render fails closed on the same shape. Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint
