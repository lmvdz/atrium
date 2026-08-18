-- ═════════════════════════════════════════════════════════════════════════════
-- THE DOCUMENT STREAM CARRIES A MONOTONE SEQUENCE — an immutable, gap-free,
-- per-room ordinal on every `ydoc_updates` row, so the server replica keys its
-- dedupe, its freshness position, and its gap-detection on a STABLE ROW IDENTITY
-- instead of a positional array index or a row count.
--
-- Phase 6, #203 (E3, the server replica); map #162. This migration closes a bug
-- CLASS, not an instance. The class: the replica used the SNAPSHOT ARRAY INDEX as
-- a row's stream ordinal (`room-replica-manager.ts` folded rows with `position =
-- for-loop index`), deduped on it, and computed freshness as
-- `consumed = appliedRows.size` vs `head = count(*)`. Because `head()` and
-- `snapshot()` are SEPARATE statements, a row committed between them — a
-- later-committed row whose in-flight txn stamped an EARLIER `appended_at` — can
-- REORDER the `(appended_at, id)`-ordered snapshot. A new row then lands on an
-- array index an already-applied row already owns: the fold dedupes it away
-- (SKIPPED), yet the count still reaches the head, so the freshness gate PASSES
-- over content the replica never folded — a potential false `✓`. The predecessors
-- of this same class were the fold-counter and, before it, the array-index count;
-- an immutable stable identity is what ends the lineage.
--
-- ## THE ONE PROPERTY THIS FILE EXISTS FOR
--
-- `stream_seq` is a per-room, gap-free, strictly-increasing bigint minted at
-- append time under an advisory lock — the SAME discipline `core_events.room_seq`
-- uses (migration 0003): `max(stream_seq) + 1` per room, taken while holding a
-- per-room advisory transaction lock so two concurrent appends cannot mint the
-- same number, and reused by an aborted / deduped INSERT so the sequence never
-- gaps. A row's `stream_seq` is INTRINSIC to the row and never changes, so:
--
--   * DEDUPE keys on it — a row re-read across snapshots reuses its seq and folds
--     as a no-op; a reordered row can no longer collide with a DIFFERENT row's
--     ordinal, because a seq belongs to exactly one row for the life of the room.
--   * FRESHNESS keys on it — the replica's consumed position is the highest
--     CONTIGUOUS seq it has folded, and the gate passes only when that reaches the
--     required head with NO gap below it. A reordered/late row is either folded
--     (counted in the contiguous prefix) or a gap (not counted) — never skipped
--     yet counted.
--
-- Gap-free is load-bearing, which is why this is minted under a lock rather than a
-- `GENERATED ALWAYS AS IDENTITY`: an identity column gaps on every rollback and
-- every `ON CONFLICT DO NOTHING`, and a permanent hole below the head would stall
-- the "highest contiguous seq" gate forever (it could never reach the head).
--
-- ## THE WRITE BOUNDARY IS UNCHANGED (0053/0054/0009 still stand)
--
-- This migration adds one column, one unique key, one ordered index, and
-- re-defines the append function's BODY to mint the seq. It does not touch the
-- membership authorization, the REVOKE, the accident-check guard trigger, the
-- writer stamp (0054), or the append-only UPDATE refusal (0053). The trust that
-- binds every caller is still the membership check inside the SECURITY DEFINER
-- body; #208 is still the durable app-as-non-owner boundary.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## The column, back-filled to a per-room contiguous ordinal
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Added NULLABLE first, so ADD COLUMN is a metadata-only change that neither
-- rewrites the table nor trips the append-only UPDATE trigger on existing rows.
ALTER TABLE "ydoc_updates" ADD COLUMN "stream_seq" bigint;--> statement-breakpoint

-- Back-fill every existing row with its per-room position in the SAME total order
-- the catch-up snapshot reads — `(appended_at, id)` — so a replica that folds the
-- back-filled stream sees exactly the order it always did, now keyed by a stable
-- seq. The back-fill is an UPDATE, which the `ydoc_updates_no_update` append-only
-- trigger (0053) refuses; it is a legitimate one-time schema migration, so the
-- trigger is disabled for the duration of THIS statement only and re-enabled
-- immediately. (Migrations run as the table owner; disabling a trigger you own is
-- owner territory, exactly like the ALTERs around it.)
ALTER TABLE "ydoc_updates" DISABLE TRIGGER "ydoc_updates_no_update";--> statement-breakpoint

UPDATE "ydoc_updates" u
SET "stream_seq" = ordered.rn
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "room" ORDER BY "appended_at", "id") AS rn
  FROM "ydoc_updates"
) AS ordered
WHERE u."id" = ordered."id";--> statement-breakpoint

ALTER TABLE "ydoc_updates" ENABLE TRIGGER "ydoc_updates_no_update";--> statement-breakpoint

-- Now that every row carries one, the column is NOT NULL and strictly positive
-- (the sequence starts at 1 per room, exactly like core_events.room_seq).
ALTER TABLE "ydoc_updates" ALTER COLUMN "stream_seq" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "ydoc_updates"
  ADD CONSTRAINT "ydoc_updates_stream_seq_positive" CHECK ("stream_seq" >= 1);--> statement-breakpoint

-- One seq per room, ever: this is what makes the seq a STABLE ROW IDENTITY the
-- replica can dedupe and gap-detect on. A concurrent append that tried to mint a
-- colliding number would fail this key rather than silently reorder — the advisory
-- lock in the append function is what keeps that from happening on the happy path.
ALTER TABLE "ydoc_updates"
  ADD CONSTRAINT "ydoc_updates_room_stream_seq_key" UNIQUE ("room", "stream_seq");--> statement-breakpoint

-- The catch-up snapshot now folds in `stream_seq` order; this index is that scan.
CREATE INDEX "ydoc_updates_room_seq_idx" ON "ydoc_updates" USING btree ("room", "stream_seq");--> statement-breakpoint

COMMENT ON COLUMN "ydoc_updates"."stream_seq" IS
  'A per-room, gap-free, strictly-increasing bigint minted at append time under a per-room advisory lock (the core_events.room_seq discipline, migration 0003). It is the STABLE ROW IDENTITY the server replica keys on (#203): dedupe by seq (a re-read row folds as a no-op), and freshness as the highest CONTIGUOUS seq folded vs the head max(stream_seq) — so a reordered/late row is folded or a detectable gap, never skipped-yet-counted. Minted under a lock rather than GENERATED AS IDENTITY because gap-free is load-bearing: an identity column gaps on rollback / ON CONFLICT and a permanent hole would stall the contiguous-prefix gate.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## The append function, re-defined to mint the sequence
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Same signature as 0054 (uuid, uuid, bytea) — every caller and test keeps
-- working. The authorization body is BYTE-FOR-BYTE 0054's (which was 0053's): a
-- live membership of a non-archived room whose workspace still carries the member,
-- roles recognised on both sides, under FOR SHARE OF m, wm; then the writer-kind
-- lookup from the immutable users row. What is new is ONLY the seq mint, below the
-- kind lookup and around the INSERT:
--
--   1. take a PER-ROOM advisory xact lock, so concurrent appends to the SAME room
--      serialise their mint (different rooms do not contend);
--   2. v_stream_seq := max(stream_seq)+1 for the room, read under that lock;
--   3. the INSERT carries the minted seq. ON CONFLICT (room, op_digest) DO NOTHING
--      still makes a byte-replay idempotent and non-re-attributing — and because a
--      no-op INSERT never advances max(stream_seq), the replayer does NOT consume
--      a number, so the sequence stays gap-free.
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
  v_stream_seq bigint;
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

  -- THE MONOTONE SEQUENCE (#203). Serialise the mint per room, then take
  -- max(stream_seq)+1 under the lock — the core_events.room_seq discipline (0003).
  -- A per-room lock (the constant namespaces it away from core_events' own lock)
  -- lets different rooms append concurrently while making same-room appends mint
  -- distinct, contiguous numbers.
  PERFORM pg_advisory_xact_lock(2039486117, hashtext(p_room::text));
  SELECT coalesce(max(y."stream_seq"), 0) + 1 INTO v_stream_seq
  FROM "ydoc_updates" y
  WHERE y."room" = p_room;

  -- The stamp is the session's user and the identity's true kind; the seq is the
  -- one minted under the lock. op_digest is generated, so it is not supplied here.
  INSERT INTO "ydoc_updates" ("room", "op", "writer_user_id", "writer_kind", "stream_seq")
  VALUES (p_room, p_op, p_actor_id, v_principal_kind::"ydoc_writer_kind", v_stream_seq)
  ON CONFLICT ("room", "op_digest") DO NOTHING
  RETURNING "ydoc_updates"."id" INTO v_id;

  IF v_id IS NULL THEN
    -- A byte-identical update already exists in this room: a legitimate resend or
    -- a hostile replay, indistinguishable and both handled the same way. The INSERT
    -- was a no-op, so v_stream_seq was NEVER consumed — max(stream_seq) is
    -- unchanged and the sequence stays gap-free. Return the ORIGINAL row's id and
    -- leave its writer stamp and its seq exactly as they were.
    SELECT "ydoc_updates"."id" INTO v_id
    FROM "ydoc_updates"
    WHERE "ydoc_updates"."room" = p_room
      AND "ydoc_updates"."op_digest" = v_digest;
  END IF;

  RETURN v_id;
END;
$append$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_append_ydoc_update"(uuid, uuid, bytea) IS
  'The appending door onto ydoc_updates (#201/#202/#203). Authorizes the author against the SAME predicate loadRoomMembership uses (live membership, non-archived room, surviving workspace member, role recognised on both sides), under FOR SHARE OF m, wm — unchanged from 0053/0054. It stamps the writer (writer_user_id = the session''s user, writer_kind = the actor''s immutable users.principal_kind) and now MINTS a per-room gap-free monotone stream_seq under a per-room advisory lock (max(stream_seq)+1, the core_events.room_seq discipline) — the stable row identity the E3 server replica dedupes and gap-detects on (#203). Append-only with replay dedupe: ON CONFLICT (room, op_digest) DO NOTHING returns the original row''s id, never re-attributes it, and — because a no-op INSERT never advances max(stream_seq) — never consumes a seq, so the sequence stays gap-free. emailVerified is enforced one layer up at the door. EXECUTE is granted to the application role only; the accident-check guard, the REVOKE, and the append-only UPDATE refusal are unchanged (0053/0009); the durable non-owner boundary is #208.';
