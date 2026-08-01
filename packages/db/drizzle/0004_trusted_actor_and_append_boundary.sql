-- ─────────────────────────────────────────────────────────────────────────────
-- issue #22, gauntlet round 3 — the append function becomes an authorization
-- boundary, and the actor becomes a trusted COLUMN (#21's contract).
--
-- ## WHAT THIS MIGRATION IS ABOUT, AND WHAT IT DELIBERATELY IS NOT
--
-- Round 2 made the append path *structural*: a `SECURITY DEFINER` function that
-- takes the ledger's advisory lock, mints `room_seq` under it and inserts, plus
-- a `BEFORE INSERT` trigger that refuses anything arriving another way. The r2
-- delta gauntlet accepted the shape and then took it apart on the substance:
--
--   > the SECURITY DEFINER append function is executable by PUBLIC, accepts
--   > arbitrary event JSON, and performs neither membership authorization nor
--   > reducer validation; calling it directly satisfies both the call-stack and
--   > lock checks, inserts a ledger row, and emits no doorbell.
--
-- Every clause of that was true. A guard that only asks "did you come through
-- the front door" is a guard on the door, not on the room: the door was open to
-- PUBLIC, and everything the *server* does before calling it — check that the
-- caller is in the room, run the event through the reducer, ring the bell so
-- other instances read the row — was on the caller's honour. This migration
-- moves each of those inside, or removes the ability to skip it.
--
-- **Operator territory, stated plainly rather than implied away.** A superuser
-- who sets `session_replication_role = replica`, or restores a dump with
-- `pg_restore --disable-triggers`, bypasses every trigger in this file. There is
-- no SQL that prevents that and this migration does not pretend otherwise: those
-- are deliberate acts by somebody holding the keys to the database, and the only
-- controls that reach them are operational (who has superuser, what runs in
-- restore windows, what the audit log says). What *is* claimed is the class
-- below it — an ordinary writer, a migration, a seed script, an admin at a psql
-- prompt, a second application with the same connection string — and that class
-- is now refused structurally rather than by convention.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. The enums #21 grew
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `proposal_superseded` is a sixth core event type (#8 re-interpretation): a
-- staged reading retired by a newer one, which is neither accepted nor rejected.
-- The three correction verbs come from #21's resolution of #5 — `retype`,
-- `reattribute` and `reopen` were named there and the scaffold had not built
-- them. Both enums are held to @atrium/core by compile-time parity asserts in
-- `packages/db/src/schema.ts`; this is their persistence half.
ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'proposal_superseded';--> statement-breakpoint
ALTER TYPE "public"."correction_action" ADD VALUE IF NOT EXISTS 'retype';--> statement-breakpoint
ALTER TYPE "public"."correction_action" ADD VALUE IF NOT EXISTS 'reattribute';--> statement-breakpoint
ALTER TYPE "public"."correction_action" ADD VALUE IF NOT EXISTS 'reopen';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. The actor becomes a column, and the payload may not carry one
-- ─────────────────────────────────────────────────────────────────────────────
--
-- #21's blocking round-1 finding was that every human-only gate in the reducer
-- read `event.actor`, and `event.actor` was a payload field — so a worker
-- emitting `{"actor":{"kind":"human","userId":"alice"}}` *was* Alice as far as
-- four rounds of trust gates were concerned. `CoreEvent` now has no place to put
-- an actor and **throws** at parse time on an input that carries one.
--
-- That inverts this ledger's r1 major 2. `core_events_payload_actor_matches`
-- asserted `payload->'actor' = actor`, which is now unsatisfiable. Deleting it
-- would delete the finding, so it is *replaced* rather than dropped: the finding
-- was "a lifted column that can disagree with the payload lets a writer mint a
-- row that replays as something other than what it is", and the only equality
-- left that says that is **the payload holds no actor at all**. One actor per
-- row, in one place, by constraint — which is a stronger version of the same
-- rule, not a weaker one.
ALTER TABLE "core_events" DROP CONSTRAINT "core_events_payload_actor_matches";--> statement-breakpoint
CREATE TYPE "public"."actor_kind" AS ENUM('human', 'model', 'system');--> statement-breakpoint
ALTER TABLE "core_events" ADD COLUMN "actor_kind" "actor_kind";--> statement-breakpoint
ALTER TABLE "core_events" ADD COLUMN "actor_id" text;--> statement-breakpoint

-- Data-preserving: add, backfill from the column that is about to go, constrain,
-- drop. There are no rows in a fresh database, but a migration that would have
-- lost data if there had been any is a migration nobody can trust next time.
--
-- The append-only trigger from 0003 raises on any UPDATE, including this one —
-- which is the trigger doing its job. It is disabled for exactly the two
-- backfill statements and re-enabled immediately, in the same transaction, so
-- there is no window in which the table is writable to anything else. A schema
-- migration rewriting a column is the one legitimate caller that rule has, and
-- "disable it here, visibly, for two statements" is a better answer than
-- carving a permanent exception into the trigger for a case that happens once.
ALTER TABLE "core_events" DISABLE TRIGGER "core_events_no_update";--> statement-breakpoint
UPDATE "core_events" SET
  "actor_kind" = ("actor"->>'kind')::"actor_kind",
  "actor_id" = coalesce("actor"->>'userId', "actor"->>'model');--> statement-breakpoint
-- The payload's copy goes too, so the new CHECK below is satisfiable by rows
-- that predate it. `#-` deletes a key at a path.
UPDATE "core_events" SET "payload" = "payload" #- '{actor}' WHERE jsonb_exists("payload", 'actor');--> statement-breakpoint
ALTER TABLE "core_events" ENABLE TRIGGER "core_events_no_update";--> statement-breakpoint
ALTER TABLE "core_events" ALTER COLUMN "actor_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "core_events" DROP COLUMN "actor";--> statement-breakpoint

ALTER TABLE "core_events" ADD CONSTRAINT "core_events_payload_has_no_actor" CHECK (NOT jsonb_exists("core_events"."payload", 'actor'));--> statement-breakpoint
-- NULL exactly for the system actor and only for it: `{kind:'system', actor_id:
-- 'alice'}` is a row that reads as a person having done what the process did.
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_actor_id_matches_kind" CHECK (("core_events"."actor_kind" = 'system') = ("core_events"."actor_id" IS NULL));--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_actor_id_not_blank" CHECK ("core_events"."actor_id" IS NULL OR length("core_events"."actor_id") > 0);--> statement-breakpoint
CREATE INDEX "core_events_actor_idx" ON "core_events" USING btree ("actor_kind","actor_id");--> statement-breakpoint

-- The canonical order, in the collation the reducer actually sorts in.
--
-- @atrium/core orders events by `(at, id)` with JavaScript's `<`, which is
-- UTF-16 code-unit order — byte order, for the ASCII uuids these ids are. The
-- database's default collation is not: under most ICU/glibc locales `-` is
-- variable-weighted and two ids can compare one way in Postgres and the other
-- way in the reducer. That is the r1 lock-key lesson in a second costume — two
-- components that must agree on a shared rule, agreeing by luck. `COLLATE "C"`
-- is byte order, so the index below and the gate that reads it sort exactly the
-- way the reducer does.
CREATE INDEX "core_events_canonical_order_idx" ON "core_events" USING btree ("occurred_at" DESC, "id" COLLATE "C" DESC);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 3. attention_items.rationale → reason jsonb (#21 major 8)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Core stopped producing the rendered sentence as the stored value: it produces
-- a discriminated `RationaleReason` and renders on demand. Storing the sentence
-- freezes a template into every row — change the wording and history reports the
-- old one — and makes "which rule raised this" a substring search over prose.
--
-- The backfill wraps any pre-existing sentence as `{"kind":"mention","request":
-- …}`, which is the one variant whose payload *is* free text, so no row is lost
-- and none is given a rule it did not come from.
ALTER TABLE "attention_items" ADD COLUMN "reason" jsonb;--> statement-breakpoint
UPDATE "attention_items" SET "reason" = jsonb_build_object('kind', 'mention', 'request', "rationale") WHERE "reason" IS NULL;--> statement-breakpoint
ALTER TABLE "attention_items" ALTER COLUMN "reason" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attention_items" DROP CONSTRAINT "attention_items_rationale_present";--> statement-breakpoint
ALTER TABLE "attention_items" DROP COLUMN "rationale";--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_reason_has_kind" CHECK (length(coalesce("attention_items"."reason"->>'kind', '')) > 0);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 4. The append function becomes the authorization boundary
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Four changes, one per clause of the finding.
--
-- **(a) It is no longer executable by PUBLIC.** `REVOKE EXECUTE … FROM PUBLIC`,
-- with a `GRANT` to the table owner (the role the app connects as in every
-- deployment this repo ships) and to each non-superuser login role that the r2
-- migration had already identified as an app role. r2 granted it to PUBLIC on
-- the reasoning that the trigger was the real guard; that made the door the
-- guard, and the door was unlocked.
--
-- **(b) Membership is authorized inside.** A human actor must hold a membership
-- row in the room being written, read `FOR SHARE` in this transaction so a
-- concurrent revoke waits for the append rather than slipping between the check
-- and the insert. The command layer checks this too — twice before, in fact —
-- but "the caller checked" is exactly the property that stops being true the
-- moment there is a second caller.
--
-- **(c) The reducer's refusals are enforced here, in the only form SQL can hold
-- them.** @atrium/core refuses an event for exactly two reasons, and both are
-- properties of *position* rather than of content: `out_of_order` (it does not
-- sort strictly after the state's cursor in canonical `(at, id)` order) and
-- `duplicate` (its id is already spent). Position is precisely what a database
-- can check, and both are checked below — the ordering gate against the ledger's
-- own maximum under the append lock, the duplicate gate by
-- `core_events_id_key`.
--
-- That is the whole of what "reducer validation" can structurally mean here, and
-- it is worth being exact about why. The reducer's *other* verdict,
-- `applied_with_issue`, is not a refusal: the event happened, it takes its
-- position, and the problem is recorded beside it. There is nothing for a
-- boundary to reject. So the two rejection reasons are the complete list, and
-- with them enforced, **no caller — through the server or around it — can put a
-- row in this table that a replay would refuse to fold.** That was the invariant
-- this ticket exists to hold, and it now holds against writers the server has
-- never heard of.
--
-- What is *not* claimed: full `CoreEvent` schema validation. A model claim
-- missing its quote, a payload whose object type disagrees with its payload
-- shape — those are zod schemas in TypeScript, and re-implementing them in
-- plpgsql would create a second copy of the rules, free to drift from the first.
-- The structural essentials that replay depends on are constraints (the id, type
-- and `at` equalities from r2; the no-actor rule above), and the rest is
-- deliberately one implementation in one language.
--
-- **(d) The doorbell rings inside.** `pg_notify` was in the server, so a row
-- inserted by anything else landed durably and silently: no peer instance heard
-- it, and — per blocking finding 1 — the subscribers of every other instance sat
-- at their cursors indefinitely. It is now emitted by the function, in the same
-- transaction, so no path can insert without announcing. `p_origin` is the
-- appending instance's id and defaults to NULL, which no instance matches: an
-- append by something that is not an app instance rings the bell for everybody,
-- which is the right way round.
DROP FUNCTION IF EXISTS "atrium_append_core_event"(uuid, text, "event_type", jsonb, jsonb, timestamptz);--> statement-breakpoint

CREATE FUNCTION "atrium_append_core_event"(
  p_room_id uuid,
  p_event_id text,
  p_type "event_type",
  p_actor_kind "actor_kind",
  p_actor_id text,
  p_payload jsonb,
  p_occurred_at timestamptz,
  p_origin text DEFAULT NULL
) RETURNS TABLE ("seq" bigint, "room_seq" bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $append$
DECLARE
  v_room_seq bigint;
  v_seq bigint;
  v_max_at timestamptz;
  v_max_id text;
  v_member boolean;
BEGIN
  -- `0x41545232` = 1096045106 — "ATR2". Duplicated in apps/server/src/ledger.ts
  -- as LEDGER_ADVISORY_LOCK_KEY, and an integration test reads this function's
  -- deployed body and asserts the two agree: r1 shipped a hand-conversion typo
  -- where the migration took 1096041522 and the server took 1096045106, both
  -- took *a* lock, neither ever contended, and every single-process test stayed
  -- green while the mutual-exclusion guarantee was simply absent.
  PERFORM pg_advisory_xact_lock(1096045106::bigint);

  -- (b) Membership, inside the boundary.
  IF p_actor_kind = 'human' THEN
    IF p_actor_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION
        'human actor "%" is not a user id; core_events may not be appended to on behalf of an identity that cannot be a member of a room', p_actor_id
        USING ERRCODE = '42501', CONSTRAINT = 'core_events_append_actor_authorized';
    END IF;
    -- `PERFORM … FOR SHARE` rather than `SELECT EXISTS(… FOR SHARE)`: the row
    -- lock has to be taken on the membership row itself, and a lock inside a
    -- subquery is a lock on whatever the planner decided to materialise. FOUND
    -- is set by PERFORM, so this reads the row, locks it, and answers in one
    -- statement. A concurrent revoke now waits for this append to commit or
    -- abort instead of slipping between the check and the insert.
    PERFORM 1 FROM "memberships" m
    WHERE m."room_id" = p_room_id AND m."user_id" = p_actor_id::uuid
    FOR SHARE;
    v_member := FOUND;
    IF NOT v_member THEN
      RAISE EXCEPTION
        'actor "%" holds no membership in room % and may not append to its history', p_actor_id, p_room_id
        USING ERRCODE = '42501', CONSTRAINT = 'core_events_append_actor_authorized';
    END IF;
  END IF;
  -- A model or the system actor is not a room member and cannot be: those are
  -- server-side identities, and reaching this function at all now requires
  -- EXECUTE, which only the application role holds. The room check for them is
  -- the grant.

  -- (c) The reducer's ordering gate, in SQL. `COLLATE "C"` because the reducer
  -- compares ids with JavaScript's `<` — see the index comment above.
  SELECT e."occurred_at", e."id" INTO v_max_at, v_max_id
  FROM "core_events" e
  ORDER BY e."occurred_at" DESC, e."id" COLLATE "C" DESC
  LIMIT 1;

  IF v_max_at IS NOT NULL AND NOT (
    p_occurred_at > v_max_at
    OR (p_occurred_at = v_max_at AND (p_event_id COLLATE "C") > (v_max_id COLLATE "C"))
  ) THEN
    RAISE EXCEPTION
      'event (%, %) does not sort strictly after the ledger cursor (%, %) in canonical (at, id) order; a replay would refuse it and the durable log would stop reproducing the live state',
      p_occurred_at, p_event_id, v_max_at, v_max_id
      USING ERRCODE = '55000', CONSTRAINT = 'core_events_append_canonical_order';
  END IF;

  -- Minted under the lock, in the same transaction as the INSERT: an append
  -- that aborts gives its number straight back, so `room_seq` stays contiguous
  -- while the global `seq` (a bigserial, which does not roll back) may gap.
  SELECT coalesce(max(e."room_seq"), 0) + 1 INTO v_room_seq
  FROM "core_events" e
  WHERE e."room_id" = p_room_id;

  INSERT INTO "core_events" ("room_id", "room_seq", "id", "type", "actor_kind", "actor_id", "payload", "occurred_at")
  VALUES (p_room_id, v_room_seq, p_event_id, p_type, p_actor_kind, p_actor_id, p_payload, p_occurred_at)
  RETURNING "core_events"."seq" INTO v_seq;

  -- (d) The doorbell, inside the boundary. Postgres queues notifications and
  -- delivers them at commit, so it can neither precede nor outlive the row it is
  -- about. The payload is a position and an origin, never an event body: the
  -- receiver reads the row out of the ledger, because it has to fold it anyway
  -- and a relayed copy is a second history free to disagree with the first.
  PERFORM pg_notify('atrium_ledger', json_build_object(
    'origin', p_origin,
    'roomId', p_room_id,
    'seq', v_seq,
    'roomSeq', v_room_seq
  )::text);

  "seq" := v_seq;
  "room_seq" := v_room_seq;
  RETURN NEXT;
END;
$append$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_append_core_event"(uuid, text, "event_type", "actor_kind", text, jsonb, timestamptz, text) IS
  'The only way a row reaches core_events, and the authorization boundary in front of it: takes the ledger advisory lock, authorizes the actor''s membership, refuses anything that does not sort strictly after the canonical cursor, mints room_seq, inserts, and rings the cross-instance doorbell. EXECUTE is granted to the application role only. Privileged bypasses (session_replication_role, pg_restore --disable-triggers) are operator territory and out of scope.';--> statement-breakpoint

-- ── privileges: the door is locked now ───────────────────────────────────────
--
-- The owner is granted explicitly rather than relied upon: the function is
-- SECURITY DEFINER and owned by that role, and an owner's implicit EXECUTE is
-- the kind of thing that is true until somebody changes the owner.
REVOKE EXECUTE ON FUNCTION "atrium_append_core_event"(uuid, text, "event_type", "actor_kind", text, jsonb, timestamptz, text) FROM PUBLIC;--> statement-breakpoint

DO $privileges$
DECLARE
  v_owner name;
  v_role name;
  v_signature text := 'public.atrium_append_core_event(uuid, text, event_type, actor_kind, text, jsonb, timestamptz, text)';
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = 'core_events' AND n.nspname = 'public';

  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_signature, v_owner);

  -- Every non-superuser login role the r2 migration had already treated as an
  -- app role: it revoked their direct INSERT and granted them the function. They
  -- keep the function and nothing else.
  FOR v_role IN
    SELECT r.rolname FROM pg_roles r
    WHERE r.rolcanlogin
      AND NOT r.rolsuper
      AND r.rolname <> v_owner
      AND has_table_privilege(r.rolname, 'public.core_events', 'SELECT')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_signature, v_role);
  END LOOP;
END;
$privileges$;
