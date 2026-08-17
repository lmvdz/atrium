-- ═════════════════════════════════════════════════════════════════════════════
-- THE DOCUMENT STREAM — Electric's two durable tables, and the door in front of
-- the one that carries meaning.
--
-- Phase 6, #201 (E1, the sync fabric); map #162. `apps/web/app/prototype/
-- electric-transport.ts` names the infrastructure this migration is half of: an
-- Electric sync service over Postgres logical replication, reading `ydoc_updates`
-- as a room-scoped shape, plus a write endpoint the app owns because Electric
-- syncs READS and never writes.
--
-- ## What the two tables are
--
--   * `ydoc_updates`   — the durable Yjs update log for a room's conversation
--                        document. Append-only. Every byte a reader folds into
--                        its `Y.Doc` came from a row here.
--   * `ydoc_awareness`  — presence: cursors, selections, who is looking. One row
--                        per (client, room), overwritten in place, ephemeral by
--                        nature and by TTL.
--
-- Column names are y-electric's, not ours (`room`, `op`, `client_id`, `updated`),
-- because the client library reads them by name and a nicer spelling here would
-- be a rename in `getUpdateFromRow` and a shape `where` that no longer matches
-- the documented example. The one deliberate departure from upstream's example
-- schema: `room` is a `uuid` REFERENCES `rooms`, not free text. Upstream's demo
-- has no rooms to scope to; we do, and the whole read gate (the app's
-- `/electric/v1/shape` proxy) turns on "is this caller a member of THAT room" —
-- a text column would let a stream key exist that no membership can be checked
-- against, and `ON DELETE CASCADE` is what stops a deleted room's document
-- outliving it.
--
-- ## THE COVENANT-ADJACENT CORNER (#201's scope boundary, spelled in)
--
-- A `✓` is a signature over rendered content (0050/0051). The content it signs
-- lives in this table. So a writer that can put a row in `ydoc_updates` can move
-- the ground under a human's `✓` — and the DETECT arm (#164) can only re-stale a
-- covenant it can attribute. `ydoc_updates` therefore gets the SAME boundary
-- `core_events` got in 0003/0004, for the same reason and in the same shape:
--
--   (a) a `SECURITY DEFINER` append function that authorizes the writer,
--   (b) a `BEFORE INSERT` guard trigger that refuses anything arriving another
--       way — the half a REVOKE cannot give us, because neither the table's owner
--       nor a superuser is bound by a REVOKE and the app connects as the owner in
--       every deployment this repo ships,
--   (c) the REVOKE anyway, for a deployment that runs the app under a role that
--       is neither, and
--   (d) `BEFORE UPDATE` refused outright: rewriting an `op` in place edits history
--       underneath an anchor and leaves no trace for drift detection to find.
--
-- E2 builds the HTTP door (`sendUrl`) on top of (a). This migration owns the
-- boundary; it deliberately owns no HTTP.
--
-- **DELETE is revoked but not trigger-refused, and that is a decision.** Yjs
-- compaction (merge N updates into one, delete the N) is a legitimate future
-- caller, and the room cascade above needs it. So DELETE is closed by privilege —
-- which binds every role except the owner and a superuser — rather than by a
-- trigger that a compactor would then have to be carved out of. When a compactor
-- is built it gets its own `SECURITY DEFINER` function and this comment gets a
-- reference to it.
--
-- **The operator limit, restated rather than implied.** Everything below is
-- bypassed by a superuser who sets `session_replication_role = replica`, or by
-- `pg_restore --disable-triggers`. That is 0004's paragraph and it is still true.
-- What is claimed is the class under it: an ordinary writer, a second app with
-- the same connection string, an admin at a psql prompt, the Electric replication
-- role, a seed script.
--
-- ## Electric's own access, and why it is a publication rather than a grant
--
-- Electric connects over logical replication and needs a publication naming the
-- tables it may stream. Created HERE, by the owner, naming exactly these two
-- tables — so the ceiling on what the sync service can ever see is a database
-- object rather than a configuration file. MEASURED, not assumed: with the
-- least-privilege `atrium_electric` role (`deploy/electric-role.sql`), asking
-- Electric for a table outside the publication answers
--
--   503 {"message":"Database table \"public.secrets\" is missing from the
--        publication \"electric_publication_default\" and Electric lacks
--        privileges to add it"}
--
-- An Electric misconfigured — or talked into — syncing `users` or `core_events`
-- does not get a filtered result; it gets a refusal, from Postgres, because it
-- holds neither ownership of those tables nor the right to alter its own
-- publication.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE "ydoc_updates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "room" uuid NOT NULL,
  "op" bytea NOT NULL,
  "appended_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- A zero-length update is not a Yjs update; it is a row that costs a shape
  -- round-trip and folds to nothing.
  CONSTRAINT "ydoc_updates_op_not_empty" CHECK (octet_length("ydoc_updates"."op") > 0),
  CONSTRAINT "ydoc_updates_room_fk" FOREIGN KEY ("room") REFERENCES "rooms"("id") ON DELETE CASCADE
);--> statement-breakpoint

-- The shape's predicate is `room = $1` and nothing else, so this index is the
-- one read path Electric's initial snapshot takes.
CREATE INDEX "ydoc_updates_room_idx" ON "ydoc_updates" USING btree ("room","appended_at");--> statement-breakpoint

COMMENT ON TABLE "ydoc_updates" IS
  'The durable Yjs update log a room''s conversation document is folded from (#201). Append-only through atrium_append_ydoc_update(); a direct INSERT is refused by the ydoc_updates_append_guard trigger. Content a human ✓ signs lives here, which is why it is gated rather than merely revoked.';--> statement-breakpoint

CREATE TABLE "ydoc_awareness" (
  "client_id" text NOT NULL,
  "room" uuid NOT NULL,
  "op" bytea NOT NULL,
  "updated" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ydoc_awareness_pk" PRIMARY KEY ("client_id","room"),
  CONSTRAINT "ydoc_awareness_client_id_not_blank" CHECK (length("ydoc_awareness"."client_id") > 0),
  CONSTRAINT "ydoc_awareness_op_not_empty" CHECK (octet_length("ydoc_awareness"."op") > 0),
  CONSTRAINT "ydoc_awareness_room_fk" FOREIGN KEY ("room") REFERENCES "rooms"("id") ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX "ydoc_awareness_room_idx" ON "ydoc_awareness" USING btree ("room","updated");--> statement-breakpoint

COMMENT ON TABLE "ydoc_awareness" IS
  'Presence for a room''s live document (#201): one overwritable row per (client, room). Carries no document content and no covenant value — but it is still room-scoped and still written only through atrium_upsert_ydoc_awareness(), because a forged cursor is an identity claim.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## The append function — the authorization boundary
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Membership is checked against ALL THREE conditions the read side checks
-- (`packages/auth/src/room-access.ts`, `loadRoomMembership`): a `memberships`
-- row, a live (non-archived) room, and a surviving `workspace_members` row for
-- the room's workspace. 0004's core_events function checks only the first, and
-- that asymmetry would be a real one here: the shape proxy that decides who may
-- READ a room's stream uses `loadRoomMembership`, so a write gate with a weaker
-- rule would let a removed member keep appending to a document they can no
-- longer open. Two gates over one document, agreeing by construction.
--
-- `FOR SHARE` for the reason 0004 gives: a concurrent revoke waits for the append
-- to commit or abort instead of slipping between the check and the insert.
CREATE FUNCTION "atrium_append_ydoc_update"(
  p_room uuid,
  p_actor_id uuid,
  p_op bytea
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $append$
DECLARE
  v_id uuid;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION
      'a ydoc update needs an authenticated author; the document stream has no anonymous writer'
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_updates_append_actor_authorized';
  END IF;

  PERFORM 1
  FROM "memberships" m
  JOIN "rooms" r ON r."id" = m."room_id"
  JOIN "workspace_members" wm
    ON wm."organization_id" = r."workspace_id" AND wm."user_id" = m."user_id"
  WHERE m."room_id" = p_room
    AND m."user_id" = p_actor_id
    AND r."archived_at" IS NULL
  FOR SHARE OF m;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'actor "%" may not write room %''s document: no live membership', p_actor_id, p_room
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_updates_append_actor_authorized';
  END IF;

  INSERT INTO "ydoc_updates" ("room", "op") VALUES (p_room, p_op)
  RETURNING "ydoc_updates"."id" INTO v_id;

  RETURN v_id;
END;
$append$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_append_ydoc_update"(uuid, uuid, bytea) IS
  'The only way a row reaches ydoc_updates, and the authorization boundary in front of it: authorizes the author''s live membership of the room (the same three conditions loadRoomMembership checks on the read side) and inserts. EXECUTE is granted to the application role only. E2''s sendUrl door is an HTTP wrapper over this and nothing else.';--> statement-breakpoint

CREATE FUNCTION "atrium_upsert_ydoc_awareness"(
  p_room uuid,
  p_actor_id uuid,
  p_client_id text,
  p_op bytea
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $awareness$
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION
      'presence needs an authenticated author; an anonymous cursor is an unattributable identity claim'
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_awareness_actor_authorized';
  END IF;

  PERFORM 1
  FROM "memberships" m
  JOIN "rooms" r ON r."id" = m."room_id"
  JOIN "workspace_members" wm
    ON wm."organization_id" = r."workspace_id" AND wm."user_id" = m."user_id"
  WHERE m."room_id" = p_room
    AND m."user_id" = p_actor_id
    AND r."archived_at" IS NULL
  FOR SHARE OF m;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'actor "%" may not appear in room %: no live membership', p_actor_id, p_room
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_awareness_actor_authorized';
  END IF;

  INSERT INTO "ydoc_awareness" ("client_id", "room", "op", "updated")
  VALUES (p_client_id, p_room, p_op, now())
  ON CONFLICT ("client_id", "room")
  DO UPDATE SET "op" = EXCLUDED."op", "updated" = now();
END;
$awareness$;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## The guards — the half a REVOKE cannot give us
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `GET DIAGNOSTICS … PG_CONTEXT` is the live plpgsql call stack. It cannot be
-- set, faked or passed in by the caller, which is why it is the check and a
-- session variable or a flag column is not: those would only move the
-- convention. 0003's guard, verbatim in shape.
CREATE FUNCTION "atrium_ydoc_updates_append_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
  v_context text;
BEGIN
  GET DIAGNOSTICS v_context = PG_CONTEXT;
  IF position('function atrium_append_ydoc_update(' in v_context) = 0 THEN
    RAISE EXCEPTION
      'ydoc_updates is append-only through atrium_append_ydoc_update(); a direct INSERT writes document content no membership authorized and no covenant anchor can attribute'
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_updates_append_through_procedure';
  END IF;
  RETURN NEW;
END;
$guard$;--> statement-breakpoint

CREATE TRIGGER "ydoc_updates_append_guard"
  BEFORE INSERT ON "ydoc_updates"
  FOR EACH ROW EXECUTE FUNCTION "atrium_ydoc_updates_append_guard"();--> statement-breakpoint

-- UPDATE only, and unconditionally. There is no legitimate caller: a Yjs update
-- is an immutable fact about what somebody typed, and rewriting one in place is
-- precisely the edit that would move content underneath a `✓` while leaving the
-- update log looking untouched — DETECT (#182) watches for NEW updates, so an
-- in-place rewrite is the one mutation drift detection could not see.
CREATE FUNCTION "atrium_ydoc_updates_no_update"() RETURNS trigger
LANGUAGE plpgsql
AS $immutable$
BEGIN
  RAISE EXCEPTION 'ydoc_updates is append-only: % is not permitted on a document update row', TG_OP
    USING ERRCODE = '42501', CONSTRAINT = 'ydoc_updates_append_only';
END;
$immutable$;--> statement-breakpoint

CREATE TRIGGER "ydoc_updates_no_update"
  BEFORE UPDATE ON "ydoc_updates"
  FOR EACH ROW EXECUTE FUNCTION "atrium_ydoc_updates_no_update"();--> statement-breakpoint

-- Awareness is an UPSERT, so its guard has to cover both arms of one statement.
CREATE FUNCTION "atrium_ydoc_awareness_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
  v_context text;
BEGIN
  GET DIAGNOSTICS v_context = PG_CONTEXT;
  IF position('function atrium_upsert_ydoc_awareness(' in v_context) = 0 THEN
    RAISE EXCEPTION
      'ydoc_awareness is written only through atrium_upsert_ydoc_awareness(); a direct % forges a presence claim for a client nobody authorized', TG_OP
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_awareness_write_through_procedure';
  END IF;
  RETURN NEW;
END;
$guard$;--> statement-breakpoint

CREATE TRIGGER "ydoc_awareness_write_guard"
  BEFORE INSERT OR UPDATE ON "ydoc_awareness"
  FOR EACH ROW EXECUTE FUNCTION "atrium_ydoc_awareness_guard"();--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## Privileges
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 0004's shape: PUBLIC loses the write verbs and the functions, then every
-- non-superuser login role that this repo already treats as an application role
-- — identified, as 0004 identifies it, by holding SELECT on `core_events` — is
-- given SELECT on the two tables and EXECUTE on the two functions, and nothing
-- else. The owner is granted EXECUTE explicitly rather than relied upon: the
-- functions are SECURITY DEFINER and owned by that role, and an owner's implicit
-- EXECUTE is the kind of thing that is true until somebody changes the owner.
--
-- The Electric replication role is deliberately NOT in that loop. It holds no
-- SELECT on `core_events` (see `deploy/electric-role.sql`), so it is not an app
-- role by this definition and receives nothing here; what it gets is the
-- publication below plus the SELECT that file grants it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "ydoc_updates" FROM PUBLIC;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "ydoc_awareness" FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "atrium_append_ydoc_update"(uuid, uuid, bytea) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "atrium_upsert_ydoc_awareness"(uuid, uuid, text, bytea) FROM PUBLIC;--> statement-breakpoint

DO $privileges$
DECLARE
  v_owner name;
  v_role name;
  v_append text := 'public.atrium_append_ydoc_update(uuid, uuid, bytea)';
  v_awareness text := 'public.atrium_upsert_ydoc_awareness(uuid, uuid, text, bytea)';
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = 'ydoc_updates' AND n.nspname = 'public';

  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_append, v_owner);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_awareness, v_owner);

  FOR v_role IN
    SELECT r.rolname FROM pg_roles r
    WHERE r.rolcanlogin
      AND NOT r.rolsuper
      AND r.rolname <> v_owner
      AND has_table_privilege(r.rolname, 'public.core_events', 'SELECT')
  LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.ydoc_updates FROM %I', v_role);
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.ydoc_awareness FROM %I', v_role);
    EXECUTE format('GRANT SELECT ON TABLE public.ydoc_updates TO %I', v_role);
    EXECUTE format('GRANT SELECT ON TABLE public.ydoc_awareness TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_append, v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_awareness, v_role);
  END LOOP;
END;
$privileges$;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## Electric's publication — the ceiling on what the sync service can see
-- ─────────────────────────────────────────────────────────────────────────────
--
-- IDEMPOTENT, because this migration has to be re-runnable against a volume that
-- already has it: `CREATE PUBLICATION` has no `IF NOT EXISTS` in Postgres 16, so
-- the existence check is explicit. A publication is a cluster-visible object
-- rather than a table, and this is the only place that names the two tables
-- together, which is what makes "Electric cannot stream `core_events`" a fact
-- about the database instead of a promise about a config file.
--
-- Requires `wal_level = logical` on the server to be USEFUL, but not to be
-- CREATED — a publication on a `wal_level = replica` server is legal and simply
-- has no subscriber. So this migration applies to a database whose server has
-- not been restarted yet, and the restart (docker-compose.yml's `command:` on
-- `postgres`) is what makes Electric able to attach. See that file's note: on an
-- existing data volume `wal_level` is a RESTART, not a re-init.
-- THE NAME IS NOT OURS TO CHOOSE. Electric derives it as
-- `electric_publication_<ELECTRIC_REPLICATION_STREAM_ID>`, and that variable
-- defaults to `default`. Measured against electricsql/electric 1.7.11: a
-- publication named anything else makes Electric refuse to start with
-- `Electric.DbConfigurationError: Publication "electric_publication_default" not
-- found in the database`. If a deployment ever sets a non-default stream id,
-- this name has to move with it — which is why `docker-compose.yml` does not set
-- one and says so.
DO $publication$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'electric_publication_default') THEN
    CREATE PUBLICATION "electric_publication_default" FOR TABLE "ydoc_updates", "ydoc_awareness";
  END IF;
END;
$publication$;--> statement-breakpoint

-- REPLICA IDENTITY FULL is Electric's requirement, not a preference, and it is
-- normally Electric that sets it — by ALTERing the table, which needs ownership.
-- The `atrium_electric` role deliberately has none, so the owner sets it here
-- instead. Measured: without it a shape request answers
-- `503 {"message":"Database table \"public.ydoc_updates\" does not have its
-- replica identity set to FULL"}`.
--
-- The usual cost of FULL — every UPDATE and DELETE writes the whole old row into
-- the WAL — is close to nothing on these two tables: `ydoc_updates` refuses
-- UPDATE outright and only ever deletes on a room cascade, and an awareness row
-- is a cursor. Idempotent by nature: setting it twice is the same statement.
ALTER TABLE "ydoc_updates" REPLICA IDENTITY FULL;--> statement-breakpoint
ALTER TABLE "ydoc_awareness" REPLICA IDENTITY FULL;
