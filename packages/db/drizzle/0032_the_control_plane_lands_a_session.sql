-- ═════════════════════════════════════════════════════════════════════════════
-- THE CONTROL PLANE LANDS A SESSION — its artifact, and a human-only certify.
--
-- #121. The visible control plane's review pane shows a settled session's diff +
-- tests + receipt + ARTIFACT, and its land/certify action is gated on a formal
-- human `✓` (hold-to-arm). Two things the sessions table did not carry:
--
--   * `artifact` (jsonb) — #120's ExecutionProvider forward slot: the branch,
--     commit, diff stat and test summary a settled session produced. Nullable;
--     an audit or a dry-run leaves it null, and a session that predates its
--     provider leaves it null too. Non-epistemic (#114 T3), the same as
--     `exit_summary` beside it — a process receipt, never a covenant `~`→`✓`.
--
--   * `certified_by` / `certified_at` / `certified_held_ms` — WHO landed the
--     session, WHEN, and how long they held the arm control. NULL until a person
--     formally certifies. `certified_by` references a `users` row and is held to
--     a `human` principal by the trigger below, so "no non-human path lands"
--     is a table fact, not only a Server Action guard — a machine or a voice
--     path cannot write a name here even with triggers left on.
--
-- The sessions terminal-immutable trigger (0025) freezes only status and the
-- exit receipt columns (exit_summary, spend_micros, context_pct,
-- settled_by_event_id); it leaves these new columns mutable, so a human may
-- certify a session AFTER it has settled — which is exactly when its artifact
-- exists to be reviewed. The freeze on the exit receipt is untouched.
--
-- The `certified_by`-is-human trigger is modelled on 0021's
-- `agents_owner_is_human`: it reads the referenced `users` row's immutable
-- `principal_kind` (0017), so there is no UPDATE for the check to race, and it
-- allows NULL (the uncertified state) while refusing any non-human name. Like
-- every trigger in this schema, it does not bind an operator who disables
-- triggers; the same limit 0003 states.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "sessions" ADD COLUMN "artifact" jsonb;--> statement-breakpoint

ALTER TABLE "sessions" ADD COLUMN "certified_by" uuid;--> statement-breakpoint

ALTER TABLE "sessions" ADD COLUMN "certified_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "sessions" ADD COLUMN "certified_held_ms" integer;--> statement-breakpoint

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_certified_by_fk"
  FOREIGN KEY ("certified_by") REFERENCES "public"."users"("id") ON DELETE set null;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "atrium_sessions_certified_by_is_human"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $certified_by_is_human$
DECLARE
  v_kind text;
BEGIN
  IF NEW."certified_by" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT u."principal_kind"::text INTO v_kind
  FROM public."users" u WHERE u."id" = NEW."certified_by";
  IF v_kind IS NULL THEN
    RAISE EXCEPTION
      'session %: certifier "%" is not an identity in this database', NEW."id", NEW."certified_by"
      USING ERRCODE = '23514', CONSTRAINT = 'sessions_certified_by_is_human';
  END IF;
  IF v_kind <> 'human' THEN
    RAISE EXCEPTION
      'session %: certifier "%" is a % principal, but a session is landed only by a human — a certification is a human-only act (the covenant''s second pair of eyes), enforced here rather than assumed', NEW."id", NEW."certified_by", v_kind
      USING ERRCODE = '23514', CONSTRAINT = 'sessions_certified_by_is_human';
  END IF;
  RETURN NEW;
END;
$certified_by_is_human$;--> statement-breakpoint

CREATE TRIGGER "sessions_certified_by_is_human"
  BEFORE INSERT OR UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION "atrium_sessions_certified_by_is_human"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_sessions_certified_by_is_human"() IS
  'Refuses any sessions row whose certified_by names a users row that is not principal_kind=human. Allows NULL (the uncertified state). This makes "a session is landed only by a human" a table fact (#121): no non-human path — no machine, no voice — can write a certifier name even with triggers left on. No row lock — principal_kind is immutable (0017), so there is no update to race. Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint
