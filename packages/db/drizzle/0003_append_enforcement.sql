-- ─────────────────────────────────────────────────────────────────────────────
-- issue #22, gauntlet round 2 — the append path becomes structural, the lifted
-- ordering columns become equalities, and attention items gain a polymorphic
-- subject (routed from #21).
--
-- WHY THIS MIGRATION EXISTS. Round 1 shipped the append invariant as a
-- *convention*: `apps/server` took a transaction-scoped advisory lock, minted
-- `room_seq` under it, folded the event through the reducer, and inserted. Both
-- critics said the same thing about it — the lock is cooperative. Any other
-- writer holding the same database role (a future migration, a seed script, an
-- admin at a psql prompt) could INSERT straight into `core_events`, skipping
-- canonical minting, the reducer and gap-free assignment, and reintroduce
-- exactly the divergence the invariant exists to exclude.
--
-- A REVOKE is the textbook answer and it is not sufficient here: the role this
-- app runs as owns the table (and, under the compose Postgres image, is a
-- superuser), and neither an owner nor a superuser is bound by a REVOKE. So the
-- enforcement is a trigger that reads its own call stack:
--
--   * `atrium_append_core_event(...)` is the only way a row reaches
--     `core_events`. It takes the ledger's advisory lock, mints `room_seq`
--     under it, and inserts.
--   * `core_events_append_guard` refuses any INSERT whose PG_CONTEXT call stack
--     does not run through that function, and refuses again if the advisory
--     lock is not actually held by this transaction.
--   * The REVOKE is here too, for a deployment that runs the app under a
--     dedicated non-owner role: that role needs EXECUTE on the function and
--     nothing else. See the DO block below.
--
-- The honest limit: a role with CREATE privilege could define its own function
-- with the same name and satisfy the stack check. Anyone with that privilege
-- can also DROP the trigger, so the guard is aimed at the accident — the
-- migration, the fix-up script, the well-meant backfill — and not at a DBA
-- determined to lie to the log.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── the ordering fields, as equalities (r1 major 2) ──────────────────────────
--
-- Existence was never the claim worth making. What matters is that the durable
-- order (`occurred_at`) and the canonical order the reducer replays in
-- (`payload.at`) are the same order, and likewise that the lifted `actor` is
-- the actor inside the event. Otherwise a writer can mint a row that replays
-- into a different position than it occupies.
--
-- The `::timestamptz` cast is only session-independent because the second check
-- forces a timezone designator onto every `at`. With one, the cast cannot mean
-- two different instants in two sessions — which is what makes it safe to put
-- inside a CHECK at all.
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_payload_at_has_offset" CHECK ("core_events"."payload"->>'at' ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$');--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_payload_at_matches" CHECK (("core_events"."payload"->>'at')::timestamptz = "core_events"."occurred_at");--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_payload_actor_matches" CHECK ("core_events"."payload"->'actor' = "core_events"."actor");--> statement-breakpoint

-- ── the append procedure ─────────────────────────────────────────────────────
--
-- `0x41545232` = 1096045106 — "ATR2", the ledger's advisory lock key. It is
-- duplicated in `apps/server/src/ledger.ts` as LEDGER_ADVISORY_LOCK_KEY and an
-- integration test asserts the two agree, because a lock key that drifts is a
-- lock that is never contended and never noticed.
--
-- The server still takes the lock itself, *before* it catches up and folds —
-- that ordering is what makes the fold see every committed row before minting a
-- position, and it is confirmed sound. Re-taking it here is free (advisory
-- locks are re-entrant within a transaction) and means the invariant holds even
-- for a caller that forgot.
CREATE FUNCTION "atrium_append_core_event"(
  p_room_id uuid,
  p_event_id text,
  p_type "event_type",
  p_actor jsonb,
  p_payload jsonb,
  p_occurred_at timestamptz
) RETURNS TABLE ("seq" bigint, "room_seq" bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $append$
DECLARE
  v_room_seq bigint;
  v_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(1096045106::bigint);

  -- Minted under the lock, in the same transaction as the INSERT: an append
  -- that aborts gives its number straight back, so `room_seq` stays contiguous
  -- while the global `seq` (a bigserial, which does not roll back) may gap.
  SELECT coalesce(max(e."room_seq"), 0) + 1 INTO v_room_seq
  FROM "core_events" e
  WHERE e."room_id" = p_room_id;

  INSERT INTO "core_events" ("room_id", "room_seq", "id", "type", "actor", "payload", "occurred_at")
  VALUES (p_room_id, v_room_seq, p_event_id, p_type, p_actor, p_payload, p_occurred_at)
  RETURNING "core_events"."seq" INTO v_seq;

  "seq" := v_seq;
  "room_seq" := v_room_seq;
  RETURN NEXT;
END;
$append$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_append_core_event"(uuid, text, "event_type", jsonb, jsonb, timestamptz) IS
  'The only way a row reaches core_events. Takes the ledger advisory lock, mints room_seq under it, inserts. Enforced by the core_events_append_guard trigger.';--> statement-breakpoint

-- ── the guard ────────────────────────────────────────────────────────────────
CREATE FUNCTION "atrium_core_events_append_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
  v_context text;
  v_locked boolean;
BEGIN
  -- PG_CONTEXT is the live plpgsql call stack. It cannot be set, faked or
  -- passed in by the caller, which is the whole reason it is the check: a
  -- session variable or a flag column would just move the convention.
  GET DIAGNOSTICS v_context = PG_CONTEXT;
  IF position('function atrium_append_core_event(' in v_context) = 0 THEN
    RAISE EXCEPTION
      'core_events is append-only through atrium_append_core_event(); a direct INSERT bypasses canonical minting, the reducer and the append lock'
      USING ERRCODE = '42501', CONSTRAINT = 'core_events_append_through_procedure';
  END IF;

  -- classid/objid are how Postgres stores a bigint advisory key: the high 32
  -- bits in classid, the low 32 in objid. 1096045106 fits in 32 bits, so
  -- classid is 0. objsubid 1 marks the single-argument (bigint) form.
  SELECT EXISTS (
    SELECT 1 FROM pg_locks
    WHERE locktype = 'advisory'
      AND pid = pg_backend_pid()
      AND classid = 0
      AND objid = 1096045106
      AND objsubid = 1
      AND granted
  ) INTO v_locked;
  IF NOT v_locked THEN
    RAISE EXCEPTION
      'the ledger advisory lock is not held by this transaction; core_events may not be appended to without it'
      USING ERRCODE = '55000', CONSTRAINT = 'core_events_append_lock_held';
  END IF;

  RETURN NEW;
END;
$guard$;--> statement-breakpoint

CREATE TRIGGER "core_events_append_guard"
  BEFORE INSERT ON "core_events"
  FOR EACH ROW EXECUTE FUNCTION "atrium_core_events_append_guard"();--> statement-breakpoint

-- ── append-only, in the database rather than in a comment ────────────────────
--
-- UPDATE only. Not DELETE, and not TRUNCATE, deliberately: `core_events.room_id`
-- cascades from `rooms`, so deleting a room has to be able to take its events
-- with it, and the integration suite truncates between files. Rewriting a row
-- in place has no legitimate caller at all, and it is the one that would let
-- history be edited after the fact without leaving a trace.
CREATE FUNCTION "atrium_core_events_no_update"() RETURNS trigger
LANGUAGE plpgsql
AS $immutable$
BEGIN
  RAISE EXCEPTION 'core_events is append-only: % is not permitted on a ledger row', TG_OP
    USING ERRCODE = '42501', CONSTRAINT = 'core_events_append_only';
END;
$immutable$;--> statement-breakpoint

CREATE TRIGGER "core_events_no_update"
  BEFORE UPDATE ON "core_events"
  FOR EACH ROW EXECUTE FUNCTION "atrium_core_events_no_update"();--> statement-breakpoint

-- ── privileges ───────────────────────────────────────────────────────────────
--
-- PUBLIC first, then any login role that is neither a superuser nor the table's
-- owner: those are the roles a REVOKE can actually bind. The owner is skipped
-- on purpose — the append function is SECURITY DEFINER and runs as the owner,
-- so revoking the owner's INSERT would break every append, not just the direct
-- ones. Superusers are skipped because a REVOKE does not bind them; the trigger
-- above is what covers that case, and an integration test proves it by trying a
-- direct INSERT as the (superuser) test role and being refused.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "core_events" FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "atrium_append_core_event"(uuid, text, "event_type", jsonb, jsonb, timestamptz) TO PUBLIC;--> statement-breakpoint

DO $privileges$
DECLARE
  v_owner name;
  v_role name;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = 'core_events' AND n.nspname = 'public';

  FOR v_role IN
    SELECT r.rolname FROM pg_roles r
    WHERE r.rolcanlogin
      AND NOT r.rolsuper
      AND r.rolname <> v_owner
      AND has_table_privilege(r.rolname, 'public.core_events', 'INSERT')
  LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.core_events FROM %I', v_role);
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.atrium_append_core_event(uuid, text, event_type, jsonb, jsonb, timestamptz) TO %I',
      v_role);
  END LOOP;
END;
$privileges$;--> statement-breakpoint

-- ── the read cursor may not point past the end of the room (r1 major 5) ──────
--
-- Cross-table, so it cannot be a CHECK. A `seen_seq` past the room's head
-- claims to have read history that does not exist; the client that trusts it
-- then asks `since(room, n)` for a gap that will never arrive, and its "since
-- you left" divider sits in the future forever. The command layer refuses it
-- too — this is the half that also holds for a writer that is not the command
-- layer.
CREATE FUNCTION "atrium_memberships_seen_seq_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $seen$
DECLARE
  v_head bigint;
BEGIN
  -- 0 is "nothing read yet" and is always legal, including for a brand-new room
  -- with no events. Short-circuiting it keeps every membership INSERT from
  -- paying for a max() over the ledger.
  IF NEW."seen_seq" = 0 THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(max(e."room_seq"), 0) INTO v_head
  FROM "core_events" e
  WHERE e."room_id" = NEW."room_id";

  IF NEW."seen_seq" > v_head THEN
    RAISE EXCEPTION
      'seen_seq % is past the head of room % (%)', NEW."seen_seq", NEW."room_id", v_head
      USING ERRCODE = '23514', CONSTRAINT = 'memberships_seen_seq_within_room_head';
  END IF;

  RETURN NEW;
END;
$seen$;--> statement-breakpoint

CREATE TRIGGER "memberships_seen_seq_within_room_head"
  BEFORE INSERT OR UPDATE OF "seen_seq" ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION "atrium_memberships_seen_seq_guard"();--> statement-breakpoint

-- ── attention items: a polymorphic subject (routed from #21) ─────────────────
--
-- `object_id` was a composite foreign key onto `accepted_objects`, which made
-- `needs_decision` unstorable: a decision never auto-accepts, so at the moment
-- somebody has to rule on one, the thing waiting is the PROPOSAL and no object
-- exists yet. Core carries the `subjectKind` discriminator; this is its
-- persistence half.
--
-- Postgres has no "foreign key to one of two tables", and the naive answers are
-- both worse: drop the FK (rooms stop being an isolation boundary for the one
-- table whose whole job is telling people what needs them) or add a nullable
-- column per target and a check constraint keeping them in step with the
-- discriminator (two writers, one truth). Instead the discriminator is
-- *projected* into two generated columns, each null unless the kind selects it,
-- each carrying its own composite `(room_id, …)` FK. Nothing can write them
-- inconsistently with `subject_kind`, exactly one is non-null per row, and both
-- edges stay room-scoped.
--
-- The rename is data-preserving: add, backfill, constrain, then drop. There are
-- no rows in practice — nothing writes attention items until #21's routing
-- lands — but a migration that would have lost data if there had been any is a
-- migration nobody can trust the next time.
CREATE TYPE "public"."attention_subject_kind" AS ENUM('object', 'proposal');--> statement-breakpoint
ALTER TABLE "attention_items" DROP CONSTRAINT "attention_items_object_same_room_fk";--> statement-breakpoint
DROP INDEX "attention_items_user_object_class_key";--> statement-breakpoint
ALTER TABLE "attention_items" ADD COLUMN "subject_kind" "attention_subject_kind" DEFAULT 'object' NOT NULL;--> statement-breakpoint
ALTER TABLE "attention_items" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
UPDATE "attention_items" SET "subject_id" = "object_id";--> statement-breakpoint
ALTER TABLE "attention_items" ALTER COLUMN "subject_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attention_items" DROP COLUMN "object_id";--> statement-breakpoint
ALTER TABLE "attention_items" ADD COLUMN "subject_object_id" uuid GENERATED ALWAYS AS (CASE WHEN "subject_kind" = 'object' THEN "subject_id" END) STORED;--> statement-breakpoint
ALTER TABLE "attention_items" ADD COLUMN "subject_proposal_id" uuid GENERATED ALWAYS AS (CASE WHEN "subject_kind" = 'proposal' THEN "subject_id" END) STORED;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_object_same_room_fk" FOREIGN KEY ("room_id","subject_object_id") REFERENCES "public"."accepted_objects"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_proposal_same_room_fk" FOREIGN KEY ("room_id","subject_proposal_id") REFERENCES "public"."proposals"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attention_items_user_subject_class_key" ON "attention_items" USING btree ("user_id","subject_kind","subject_id","class");
