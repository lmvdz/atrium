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
--   (b) a `BEFORE INSERT` guard trigger that catches a stray direct INSERT — an
--       ACCIDENT CHECK, not a boundary, and this file is careful to call it that
--       (see below and migration 0009). It reads the caller's own PL/pgSQL frame
--       text, so a caller who wants past it needs one SQL comment, at the cost of
--       no privilege anywhere. What it buys is real but small: it refuses a write
--       that did not go through the function BY MISTAKE — a migration, a psql
--       session, a stray ORM call — which is the accident the REVOKE below cannot
--       see for the owner, because the owner is not bound by a REVOKE,
--   (c) the REVOKE, which IS the boundary for a deployment that runs the app
--       under a role that is neither the owner nor a superuser, and
--   (d) `BEFORE UPDATE` refused outright: rewriting an `op` in place edits history
--       underneath an anchor and leaves no trace for drift detection to find.
--       This one is unconditional, so a comment does not defeat it — there is no
--       legitimate UPDATE caller to admit, so the guard admits none.
--
-- THE REAL WRITE BOUNDARY, STATED PLAINLY. In every deployment this repo ships,
-- the app connects as the table OWNER, and the owner is bound by neither the
-- REVOKE (c) nor — per 0009, proved on real PG16 — the frame guard (b). So for
-- the app-as-owner deployment the write boundary is exactly one thing: E2's
-- `sendUrl` door only ever calls `atrium_append_ydoc_update` with parameterized
-- args, and no other statement reaches the table from application code. The
-- durable, unforgeable boundary — running the app under a non-owner role so the
-- REVOKE actually binds it — is #208's scope and is NOT built here. The
-- authorization that DOES bind every caller of the function (owner included) is
-- the membership check INSIDE the SECURITY DEFINER body, which no comment and no
-- privilege bypasses; that is where the trust lives, exactly as 0009 moved
-- core_events' trust onto core_events_invariants rather than onto its guard.
--
-- E2 builds the HTTP door (`sendUrl`) on top of (a). This migration owns the
-- authorization inside the function; it deliberately owns no HTTP.
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
  'The durable Yjs update log a room''s conversation document is folded from (#201). Written through atrium_append_ydoc_update(), which is where the membership authorization lives. The ydoc_updates_append_guard trigger catches a stray direct INSERT but is an accident check, not a boundary (see migration 0009): a comment defeats it, and the owner — which the app connects as — is not bound by the REVOKE. Content a human ✓ signs lives here, which is why the authorization is inside the function rather than merely relied on from a REVOKE; the durable non-owner boundary is #208.';--> statement-breakpoint

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
-- ## The role vocabulary, in SQL, because a SECURITY DEFINER body cannot call TS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `packages/auth/src/room-access.ts`'s `effectiveRoomRole` resolves a member's
-- authority to NULL — and the read side then DENIES — whenever either the
-- `memberships.role` string or the `workspace_members.role` string fails
-- `parseRole` (`packages/auth/src/authz.ts`): a role is a comma list, every
-- component must be one of exactly {owner, admin, member}, and an empty or
-- trailing-comma list is unknown. `lowerOf` returns whichever original string is
-- lower, so `parseRole(lowerOf(a, b))` is NULL iff `parseRole(a)` is NULL OR
-- `parseRole(b)` is NULL — i.e. BOTH strings must be known.
--
-- WHERE THIS ACTUALLY BITES: `memberships.role` is a Postgres enum
-- (`membership_role` = {owner, admin, member}), so the column already refuses an
-- unknown value and `atrium_role_is_known(m.role)` is defensive against a future
-- enum change, never firing today. `workspace_members.role` is free `text` (Better
-- Auth stores a comma list), so it is the side that can hold `'billing'` or
-- `'suspended,admin'` — which is exactly where the read side's `parseRole`
-- null-branch, and this check on `wm.role`, do real work. Both are checked so the
-- two gates stay in agreement even if the enum ever grows a value parseRole does
-- not know.
--
-- This helper is a SECOND encoding of that {owner, admin, member} vocabulary.
-- `room-access.ts` deliberately keeps the role LATTICE in TypeScript ("the join
-- is SQL and the ceiling is TypeScript") to avoid two components drifting on a
-- shared constant — and this is exactly that hazard, entered on purpose, because
-- a SECURITY DEFINER SQL function cannot call `parseRole`. The three role names
-- are the shared constant; if that set ever changes, it changes in `authz.ts`
-- `roles` AND here, and `integration/db/ydoc-append-boundary.test.ts` is the
-- thing that fails if they drift. It validates that a role is KNOWN, not that it
-- clears any threshold — every known role may write a document; an UNKNOWN role
-- is refused, exactly as `effectiveRoomRole` returns null and the read denies.
CREATE FUNCTION "atrium_role_is_known"(p_role text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $known$
  SELECT p_role IS NOT NULL
     AND cardinality(string_to_array(p_role, ',')) >= 1
     AND NOT EXISTS (
       SELECT 1
       FROM unnest(string_to_array(p_role, ',')) AS part
       WHERE btrim(part) NOT IN ('owner', 'admin', 'member')
     );
$known$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_role_is_known"(text) IS
  'True iff a role string parses the way packages/auth/src/authz.ts parseRole parses it: a comma list whose every trimmed component is one of {owner, admin, member}, non-empty. A SECOND, deliberate encoding of the role vocabulary the read side keeps in TypeScript — it exists because a SECURITY DEFINER body cannot call parseRole, and the drift risk is covered by ydoc-append-boundary.test.ts. Used to make the write gate refuse an unrecognised role, matching effectiveRoomRole returning null and the read side denying.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## The append function — the authorization inside the door
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Membership is checked against the SAME predicate the read side checks
-- (`packages/auth/src/room-access.ts`, `loadRoomMembership`), and this comment is
-- literal about "same" because an earlier draft claimed it while checking less:
--   * a `memberships` row for (room, actor),
--   * a live (non-archived) room,
--   * a surviving `workspace_members` row for the room's workspace, AND
--   * a role that `effectiveRoomRole` would not resolve to NULL — i.e. BOTH the
--     room role and the workspace role are recognised (atrium_role_is_known).
-- 0004's core_events function checks only the first, and that asymmetry would be
-- a real one here: the shape proxy that decides who may READ a room's stream uses
-- `loadRoomMembership`, so a write gate with a weaker rule would let a removed
-- member — or a member whose role string the read side refuses to parse — keep
-- appending to a document they can no longer open. Two gates over one document,
-- agreeing by construction.
--
-- What `loadRoomMembership` does NOT check, and neither does this, so the two do
-- not drift the other way: `emailVerified`. That gate is applied ONE layer up, at
-- the shape route and E2's door (`currentSession().emailVerified`), not inside
-- `loadRoomMembership`; the SQL function is reached only after that check has
-- passed, so re-imposing it here would be a condition the read authority does not
-- have. There is also no minimum-role threshold: document writes are a member
-- capability, so validity — not rank — is what the function checks.
--
-- `FOR SHARE OF m, wm` locks BOTH joined relations, not just `memberships`. The
-- content of `ydoc_updates` is what a human `✓` signs, so this write is treated
-- like the CERTIFY path in room-access.ts (`membership-and-workspace` scope), not
-- like the tolerant append/broadcast path: a concurrent workspace-level revoke
-- (`DELETE FROM workspace_members`) must WAIT for this append to commit or abort
-- rather than slipping between the check and the insert and landing a durable,
-- covenant-adjacent write for someone the read side already rejects. Locking
-- `memberships` alone left that exact race open.
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
  v_role text;
  v_workspace_role text;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION
      'a ydoc update needs an authenticated author; the document stream has no anonymous writer'
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_updates_append_actor_authorized';
  END IF;

  SELECT m."role", wm."role" INTO v_role, v_workspace_role
  FROM "memberships" m
  JOIN "rooms" r ON r."id" = m."room_id"
  JOIN "workspace_members" wm
    ON wm."organization_id" = r."workspace_id" AND wm."user_id" = m."user_id"
  WHERE m."room_id" = p_room
    AND m."user_id" = p_actor_id
    AND r."archived_at" IS NULL
  FOR SHARE OF m, wm;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'actor "%" may not write room %''s document: no live membership', p_actor_id, p_room
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_updates_append_actor_authorized';
  END IF;

  -- The last of loadRoomMembership's conditions: effectiveRoomRole resolves an
  -- unrecognised role on EITHER side to NULL and the read side denies. Match it,
  -- so a member whose role string the read cannot parse cannot write either.
  IF NOT (atrium_role_is_known(v_role) AND atrium_role_is_known(v_workspace_role)) THEN
    RAISE EXCEPTION
      'actor "%" may not write room %''s document: unrecognised role (room %, workspace %)',
      p_actor_id, p_room, v_role, v_workspace_role
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_updates_append_actor_authorized';
  END IF;

  INSERT INTO "ydoc_updates" ("room", "op") VALUES (p_room, p_op)
  RETURNING "ydoc_updates"."id" INTO v_id;

  RETURN v_id;
END;
$append$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_append_ydoc_update"(uuid, uuid, bytea) IS
  'The appending door onto ydoc_updates that a REVOKE can control, and the only path any role short of the table owner has: it authorizes the author against the SAME predicate loadRoomMembership uses on the read side — a live membership of a non-archived room whose workspace still carries the member, plus a role recognised on BOTH the room and the workspace side (atrium_role_is_known, matching effectiveRoomRole) — takes FOR SHARE on memberships AND workspace_members so a concurrent revoke cannot race the insert, then inserts. It is NOT the only statement that can reach the table: the owner can INSERT directly and ydoc_updates_append_guard is an accident check, not a boundary (see migration 0009); the authorization that binds every caller of THIS function, owner included, is the membership check in this SECURITY DEFINER body, which no comment and no privilege bypasses. emailVerified is deliberately not re-checked here, because loadRoomMembership does not check it either — it is enforced one layer up at the route/door. EXECUTE is granted to the application role only. E2''s sendUrl door is an HTTP wrapper over this and nothing else. The durable non-owner write boundary is #208.';--> statement-breakpoint

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
DECLARE
  v_role text;
  v_workspace_role text;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION
      'presence needs an authenticated author; an anonymous cursor is an unattributable identity claim'
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_awareness_actor_authorized';
  END IF;

  -- Same predicate as the read side and the same FOR SHARE OF m, wm as the
  -- append above, for the same reasons: a workspace-level revoke must not race
  -- the write, and an unrecognised role denies exactly as effectiveRoomRole does.
  SELECT m."role", wm."role" INTO v_role, v_workspace_role
  FROM "memberships" m
  JOIN "rooms" r ON r."id" = m."room_id"
  JOIN "workspace_members" wm
    ON wm."organization_id" = r."workspace_id" AND wm."user_id" = m."user_id"
  WHERE m."room_id" = p_room
    AND m."user_id" = p_actor_id
    AND r."archived_at" IS NULL
  FOR SHARE OF m, wm;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'actor "%" may not appear in room %: no live membership', p_actor_id, p_room
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_awareness_actor_authorized';
  END IF;

  IF NOT (atrium_role_is_known(v_role) AND atrium_role_is_known(v_workspace_role)) THEN
    RAISE EXCEPTION
      'actor "%" may not appear in room %: unrecognised role (room %, workspace %)',
      p_actor_id, p_room, v_role, v_workspace_role
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_awareness_actor_authorized';
  END IF;

  INSERT INTO "ydoc_awareness" ("client_id", "room", "op", "updated")
  VALUES (p_client_id, p_room, p_op, now())
  ON CONFLICT ("client_id", "room")
  DO UPDATE SET "op" = EXCLUDED."op", "updated" = now();
END;
$awareness$;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## The guards — accident checks, and honest about it (see migration 0009)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- READ THIS BEFORE TRUSTING THE CHECK BELOW. An earlier draft of this file said
-- `GET DIAGNOSTICS … PG_CONTEXT` "cannot be set, faked or passed in by the
-- caller, which is why it is the check". That sentence is FALSE, and this repo
-- already proved it false on a real Postgres 16: #22's gauntlet, rounds 7-9,
-- migration 0009. PG_CONTEXT is the live PL/pgSQL call stack and each frame
-- carries the VERBATIM SQL text of its statement, so a substring search over it
-- is satisfied by one SQL comment — embed `/* function atrium_append_ydoc_update(
-- */` in a direct INSERT and this guard passes it, at the cost of no privilege
-- anywhere. 0009's header proves there is no unforgeable replacement token
-- either (a GUC, an advisory-lock token, a temp witness, a nonce are all mintable
-- by the caller, because caller and function are the same session and role) and
-- that the only real boundary is privilege: after the REVOKE below, a non-owner
-- non-superuser role never reaches this trigger, and a role inside that set is
-- not bound by any trigger.
--
-- So this is an ACCIDENT CHECK, kept for what it genuinely buys: it refuses a
-- stray direct INSERT that skipped the function BY MISTAKE — a migration, a psql
-- session, a stray ORM call — which is the one accident the REVOKE cannot catch
-- for the owner (the role the app connects as in every deployment this repo
-- ships). It is NOT a boundary and this file does not call it one. The boundary
-- is the authorization INSIDE atrium_append_ydoc_update, plus #208's app-as-
-- non-owner deployment. Unlike 0009's core_events guard it takes no advisory
-- lock, because ydoc_updates has no lock convention — so the frame check is the
-- whole of this accident check, and its reach is exactly one comment short of
-- everything.
CREATE FUNCTION "atrium_ydoc_updates_append_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
  v_context text;
BEGIN
  GET DIAGNOSTICS v_context = PG_CONTEXT;
  IF position('function atrium_append_ydoc_update(' in v_context) = 0 THEN
    -- The message says what was OBSERVED, not what is guaranteed (0009's
    -- correction): a direct INSERT here did not come through the append function,
    -- which mints no authorization. This check reads the caller's own statement
    -- text and is an accident check, not a boundary — see migration 0009.
    RAISE EXCEPTION
      'this INSERT into ydoc_updates did not come through atrium_append_ydoc_update(), which is where the membership check lives; a write that skips it skips that authorization. This check reads the caller''s own statement text and is an accident check, not a boundary (see migration 0009) — the boundary is the authorization inside the function plus privilege (#208)'
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_updates_append_through_procedure';
  END IF;
  RETURN NEW;
END;
$guard$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_ydoc_updates_append_guard"() IS
  'An ACCIDENT CHECK on INSERTs into ydoc_updates, deliberately NOT called a boundary (see migration 0009, #22 gauntlet r7). It refuses a direct INSERT whose PL/pgSQL call stack does not name atrium_append_ydoc_update — which catches a stray write that skipped the function by mistake (a migration, a psql session, an ORM call). It does NOT bind an adversary and no rewrite of it could: GET DIAGNOSTICS PG_CONTEXT carries the verbatim statement text of every caller frame, so a substring search over it is satisfied by one SQL comment at the cost of no privilege. The boundary is the membership authorization inside atrium_append_ydoc_update (which no comment bypasses) plus privilege: after the REVOKE only the owner and a superuser can INSERT at all, and #208 tracks running the app as a non-owner so the REVOKE binds it. Verified by ydoc-append-boundary.test.ts, which records the comment-forge bypass as truth rather than testing only the unadorned insert.';--> statement-breakpoint

CREATE TRIGGER "ydoc_updates_append_guard"
  BEFORE INSERT ON "ydoc_updates"
  FOR EACH ROW EXECUTE FUNCTION "atrium_ydoc_updates_append_guard"();--> statement-breakpoint

COMMENT ON TRIGGER "ydoc_updates_append_guard" ON "ydoc_updates" IS
  'Accident check, not a boundary — see atrium_ydoc_updates_append_guard() and migration 0009. A comment in the INSERT statement defeats it; the authorization that binds every caller is inside atrium_append_ydoc_update.';--> statement-breakpoint

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
-- Same accident-check status as the append guard above (see migration 0009): the
-- frame check is defeated by one SQL comment, so it catches a stray direct write
-- by mistake and does NOT bind an adversary. The boundary is the membership
-- authorization inside atrium_upsert_ydoc_awareness plus privilege (#208).
CREATE FUNCTION "atrium_ydoc_awareness_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
  v_context text;
BEGIN
  GET DIAGNOSTICS v_context = PG_CONTEXT;
  IF position('function atrium_upsert_ydoc_awareness(' in v_context) = 0 THEN
    RAISE EXCEPTION
      'this direct % into ydoc_awareness did not come through atrium_upsert_ydoc_awareness(), where the membership check lives. This check reads the caller''s own statement text and is an accident check, not a boundary (see migration 0009) — the boundary is the authorization inside the function plus privilege (#208)', TG_OP
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_awareness_write_through_procedure';
  END IF;
  RETURN NEW;
END;
$guard$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_ydoc_awareness_guard"() IS
  'An ACCIDENT CHECK on writes to ydoc_awareness, not a boundary (see migration 0009). The PG_CONTEXT frame check is satisfied by one SQL comment at no privilege cost, so it catches a stray direct write by mistake and does not bind an adversary; the boundary is the membership authorization inside atrium_upsert_ydoc_awareness plus privilege (#208).';--> statement-breakpoint

CREATE TRIGGER "ydoc_awareness_write_guard"
  BEFORE INSERT OR UPDATE ON "ydoc_awareness"
  FOR EACH ROW EXECUTE FUNCTION "atrium_ydoc_awareness_guard"();--> statement-breakpoint

COMMENT ON TRIGGER "ydoc_awareness_write_guard" ON "ydoc_awareness" IS
  'Accident check, not a boundary — see atrium_ydoc_awareness_guard() and migration 0009. A comment in the statement defeats it; the authorization that binds every caller is inside atrium_upsert_ydoc_awareness.';--> statement-breakpoint

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
-- together.
--
-- ON A PRE-EXISTING PUBLICATION WE RECONCILE, rather than trust the set we find.
-- An older migration or a hand edit could have left the publication naming a
-- different set, and "Electric can stream these two" is the claim this block has
-- to make on an existing volume as much as on a clean one — so both tables are
-- ADDed if missing (ADD TABLE errors on an already-published table, hence the
-- per-table guard). We do NOT strip other tables a deployment may have added
-- deliberately, and we do not need to: the real ceiling on what the sync service
-- can read is the least-privilege `atrium_electric` role holding SELECT on
-- exactly these two tables (`deploy/electric-role.sql`), NOT the publication's
-- breadth. A table in the publication that the role cannot SELECT is still
-- refused. So "Electric cannot stream `core_events`" is a fact about the ROLE'S
-- GRANTS first and the publication second — both layers say it, neither relies on
-- the other, and this reconcile keeps the publication layer true on a reused
-- volume without pretending it is the whole boundary.
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
  ELSE
    -- Reconcile the two tables we own into a publication that already existed.
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'electric_publication_default'
        AND schemaname = 'public' AND tablename = 'ydoc_updates'
    ) THEN
      ALTER PUBLICATION "electric_publication_default" ADD TABLE "ydoc_updates";
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'electric_publication_default'
        AND schemaname = 'public' AND tablename = 'ydoc_awareness'
    ) THEN
      ALTER PUBLICATION "electric_publication_default" ADD TABLE "ydoc_awareness";
    END IF;
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
