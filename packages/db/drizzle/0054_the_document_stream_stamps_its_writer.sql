-- ═════════════════════════════════════════════════════════════════════════════
-- THE DOCUMENT STREAM STAMPS ITS WRITER — the authenticated authorship of every
-- Yjs update, persisted on the row it belongs to.
--
-- Phase 6, #202 (E2, the authenticated `sendUrl` door); map #162. Migration 0053
-- (E1) built `ydoc_updates` and the `atrium_append_ydoc_update` door in front of
-- it, and authorized the writer's live room membership INSIDE the function. What
-- 0053 did NOT do — deliberately, it is E2's scope — is record WHO wrote each
-- update. This migration adds that record, and it is the covenant-critical half:
--
--   * `apps/web/lib/server-room-replica.ts`'s named infra gap #3 says it in as
--     many words — "the authenticated writer must be PERSISTED alongside each
--     durable update … or those items read as unknown, fail-closed". A replica
--     caught up from the durable stream after a restart sees content but, without
--     this stamp, not the author who produced it. `writer_user_id`/`writer_kind`
--     are that persisted author.
--   * A `✓` (0050/0051) is a signature over rendered content folded from
--     `ydoc_updates`. DETECT (#164/#182) can only re-stale a covenant it can
--     ATTRIBUTE. An unattributable update is the one case it cannot see — so the
--     attribution is written at append time, from the session, and never later.
--
-- ## THE ONE PROPERTY THIS FILE EXISTS FOR
--
-- The writer identity is stamped from the SERVER-AUTHENTICATED SESSION ONLY. It
-- is NEVER read from a client field, a query parameter, a request body, or the
-- Yjs update bytes. The door (`apps/web/app/api/rooms/[room]/ydoc/route.ts`)
-- passes `p_actor_id` = the session's user id and nothing the client can name;
-- and this function does not merely trust that id's KIND either — it reads the
-- actor's `principal_kind` from the immutable `users` row (Better Auth declares
-- it `input: false`, migration 0018, so no session can assert its way to a
-- different kind). An agent session that claims `principalKind: 'human'` is
-- therefore stamped `agent`, because the kind is looked up here from the identity,
-- not taken from anything the caller said.
--
-- ## APPEND-ONLY WITH REPLAY DEDUPE — never re-attribute
--
-- A Yjs update is an immutable fact. If the exact bytes of a victim's update are
-- replayed — captured off the wire and PUT again through the attacker's own
-- session — the write must DEDUPE to the original row and must NOT create a
-- second row attributed to the replayer. `op_digest` is a GENERATED STORED
-- `sha256(op)`, unique per `(room, op_digest)`, so a byte-identical replay
-- collides; the function's `ON CONFLICT (room, op_digest) DO NOTHING` returns the
-- ORIGINAL row's id and leaves its writer stamp untouched. The digest is
-- generated rather than supplied, so a caller cannot present a digest that
-- disagrees with the bytes it is meant to summarise.
--
-- ## THE WRITE BOUNDARY IS UNCHANGED (0053/0009 still stand)
--
-- This migration adds columns and re-defines the append function's BODY; it does
-- not touch the membership authorization, the REVOKE, the accident-check guard
-- trigger (still an accident check, not a boundary — migration 0009), or the
-- append-only UPDATE refusal. The trust that binds every caller is still the
-- membership check inside the SECURITY DEFINER body; #208 is still the durable
-- app-as-non-owner boundary.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## The writer-kind vocabulary
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `human` and `agent` are the two kinds a `users.principal_kind` can be (0018) —
-- an authenticated participant that wrote through the door. `system` is the third
-- and names a write that carries NO authenticated author: a migration, a future
-- compactor, or any owner-level direct INSERT that skipped the door. It is the
-- honest fail-closed stamp — "nobody's session wrote this" — and DETECT reads it
-- as unattributed exactly as `server-room-replica.ts:catchUp` reads a
-- writer-less item as unknown rather than inventing one. The door NEVER produces
-- `system`: it always stamps the session's real kind explicitly.
CREATE TYPE "ydoc_writer_kind" AS ENUM ('human', 'agent', 'system');--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## The three columns
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `writer_user_id` is the authenticated author's `users` id — or NULL for a
-- `system` write. `ON DELETE RESTRICT`: content in this table is what a `✓`
-- signs, so an author who has written covenant-adjacent content pins their own
-- `users` row rather than letting a hard delete either cascade the content away
-- or orphan its attribution. (Anonymising an author without destroying the
-- content they signed over is a separate policy decision, not this file's.)
ALTER TABLE "ydoc_updates" ADD COLUMN "writer_user_id" uuid;--> statement-breakpoint

-- NOT NULL DEFAULT 'system': every row carries a kind, and a write that did not
-- come through the door (an owner-level direct INSERT — the #208 territory 0009
-- describes) is honestly stamped `system` / no user rather than inheriting a
-- person's kind. The door never relies on this default — it always stamps the
-- session's real kind. ADD COLUMN with a constant default is a metadata-only
-- change in PG11+, so it neither rewrites the table nor fires the append-only
-- UPDATE trigger on the rows it back-fills.
ALTER TABLE "ydoc_updates" ADD COLUMN "writer_kind" "ydoc_writer_kind" NOT NULL DEFAULT 'system';--> statement-breakpoint

-- `op_digest` is `sha256(op)`, GENERATED STORED so it is ALWAYS the hash of the
-- bytes actually stored and can never be supplied — or forged — by a caller. It
-- is the replay-dedupe key below. A generated column is computed by the ALTER
-- itself, not by a row UPDATE, so it too does not trip the append-only trigger.
ALTER TABLE "ydoc_updates" ADD COLUMN "op_digest" bytea GENERATED ALWAYS AS (sha256("op")) STORED;--> statement-breakpoint

-- The author is a real user (or nobody). By construction the door only ever
-- stamps an actor that just passed the membership check — whose `memberships`
-- row already FKs `users` — but the referential guarantee is stated on the table
-- rather than relied on from the call path.
ALTER TABLE "ydoc_updates"
  ADD CONSTRAINT "ydoc_updates_writer_user_fk"
  FOREIGN KEY ("writer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- The stamp is internally consistent: a `system` write has no user, and a
-- `human`/`agent` write always names one. Written as an equality of two booleans
-- so neither direction can drift — `system` XOR a present user is refused.
ALTER TABLE "ydoc_updates"
  ADD CONSTRAINT "ydoc_updates_writer_stamp_consistent"
  CHECK (("writer_kind" = 'system') = ("writer_user_id" IS NULL));--> statement-breakpoint

-- THE REPLAY-DEDUPE KEY. Unique per room, on the generated digest of the bytes,
-- so a byte-identical update lands at most once in a room. This is what makes a
-- replay of a victim's update collide with — rather than re-attribute — the
-- original. Per-room on purpose: two different rooms may legitimately carry the
-- same bytes, and each is its own document.
ALTER TABLE "ydoc_updates"
  ADD CONSTRAINT "ydoc_updates_room_op_digest_key" UNIQUE ("room", "op_digest");--> statement-breakpoint

COMMENT ON COLUMN "ydoc_updates"."writer_user_id" IS
  'The authenticated author of this update, stamped from the server-authenticated session by atrium_append_ydoc_update() and from nothing a client can name — never a body field, a query param, or the Yjs update bytes. NULL only for a writer_kind = system write, which carries no authenticated author. FK ON DELETE RESTRICT because this content is what a ✓ signs (#202).';--> statement-breakpoint

COMMENT ON COLUMN "ydoc_updates"."writer_kind" IS
  'human/agent for an update written through the authenticated door — looked up from the actor''s immutable users.principal_kind (0018), so an agent session claiming to be human is still stamped agent. system for a write that carried no session (a direct owner INSERT, a migration, a future compactor); the door never produces it. Default system is the honest fail-closed stamp for a door-less write (#202).';--> statement-breakpoint

COMMENT ON COLUMN "ydoc_updates"."op_digest" IS
  'sha256(op), GENERATED STORED so it is always the hash of the stored bytes and can never be supplied or forged by a caller. With the ydoc_updates_room_op_digest_key unique constraint it is the replay-dedupe key: a byte-identical update replayed through another session collides with the original row and is NOT re-attributed (#202).';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## The append function, re-defined to stamp the writer
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Same signature as 0053 (uuid, uuid, bytea), so every existing caller and test
-- keeps working and simply starts getting a stamped row. The membership
-- authorization is BYTE-FOR-BYTE 0053's — a live membership of a non-archived
-- room whose workspace still carries the member, plus a role recognised on both
-- sides (atrium_role_is_known), under FOR SHARE OF m, wm so a concurrent revoke
-- cannot race the insert. What is new is below the authorization:
--
--   1. the writer KIND is read from the actor's users row, not taken from any
--      argument — there is no writer-kind parameter to forge;
--   2. the INSERT stamps writer_user_id = p_actor_id (the session's user) and
--      that looked-up kind;
--   3. ON CONFLICT (room, op_digest) DO NOTHING makes a byte-replay idempotent
--      and, crucially, non-re-attributing: the original row's writer stamp is
--      never touched, and the original id is returned.
CREATE OR REPLACE FUNCTION "atrium_append_ydoc_update"(
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
  v_principal_kind text;
  -- Computed once, and schema-qualified so a search_path game cannot swap the
  -- hash out from under a SECURITY DEFINER body.
  v_digest bytea := pg_catalog.sha256(p_op);
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
  -- unrecognised role on EITHER side to NULL and the read side denies. Match it.
  IF NOT (atrium_role_is_known(v_role) AND atrium_role_is_known(v_workspace_role)) THEN
    RAISE EXCEPTION
      'actor "%" may not write room %''s document: unrecognised role (room %, workspace %)',
      p_actor_id, p_room, v_role, v_workspace_role
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_updates_append_actor_authorized';
  END IF;

  -- THE WRITER KIND, FROM THE IDENTITY AND NOT FROM THE CALLER. principal_kind is
  -- NOT NULL on users and immutable (0018), so this is the actor's true kind. An
  -- agent that authenticated and then claimed 'human' anywhere upstream is stamped
  -- 'agent' here, because nothing upstream reaches this SELECT. Membership above
  -- guarantees the row exists; fail closed if it somehow does not.
  SELECT u."principal_kind"::text INTO v_principal_kind
  FROM "users" u
  WHERE u."id" = p_actor_id;

  IF v_principal_kind IS NULL THEN
    RAISE EXCEPTION
      'actor "%" has no principal kind; refusing to stamp an unattributable author', p_actor_id
      USING ERRCODE = '42501', CONSTRAINT = 'ydoc_updates_append_actor_authorized';
  END IF;

  -- The stamp is the session's user and the identity's true kind. op_digest is
  -- generated, so it is not — and cannot be — supplied here.
  INSERT INTO "ydoc_updates" ("room", "op", "writer_user_id", "writer_kind")
  VALUES (p_room, p_op, p_actor_id, v_principal_kind::"ydoc_writer_kind")
  ON CONFLICT ("room", "op_digest") DO NOTHING
  RETURNING "ydoc_updates"."id" INTO v_id;

  IF v_id IS NULL THEN
    -- A byte-identical update already exists in this room: a legitimate resend or
    -- a hostile replay, indistinguishable and both handled the same way. Return
    -- the ORIGINAL row's id and leave its writer stamp exactly as it was — the
    -- replayer never re-attributes the victim's content to themselves.
    SELECT "ydoc_updates"."id" INTO v_id
    FROM "ydoc_updates"
    WHERE "ydoc_updates"."room" = p_room
      AND "ydoc_updates"."op_digest" = v_digest;
  END IF;

  RETURN v_id;
END;
$append$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_append_ydoc_update"(uuid, uuid, bytea) IS
  'The appending door onto ydoc_updates (#201/#202). Authorizes the author against the SAME predicate loadRoomMembership uses on the read side (live membership, non-archived room, surviving workspace member, role recognised on both sides), under FOR SHARE OF m, wm so a concurrent revoke cannot race the insert — unchanged from 0053. It then STAMPS the writer: writer_user_id = p_actor_id (the server-authenticated session''s user, never anything a client named) and writer_kind = the actor''s immutable users.principal_kind (0018), so an agent claiming human is stamped agent. The write is append-only with replay dedupe: ON CONFLICT (room, op_digest) DO NOTHING makes a byte-identical replay return the original row''s id and never re-attribute it. emailVerified is enforced one layer up at the door, as on the read side. EXECUTE is granted to the application role only; the accident-check guard and the REVOKE are unchanged (see 0053/0009), and the durable non-owner boundary is #208.';
