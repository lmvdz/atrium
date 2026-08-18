-- ═════════════════════════════════════════════════════════════════════════════
-- THE COVENANT VERDICT IS A READ-ONLY PROJECTION — the server's `✓`/`~` reading of
-- every certified span in a room, landed in a durable table, REVOKEd to clients, and
-- synced read-only to browsers over the SAME per-room Electric shape `ydoc_updates`
-- uses.
--
-- Phase 6, #206 (E6, the verdict projection); map #162. The verdict SOURCE is the
-- already-built server-side drift sweep (`apps/web/lib/room-drift-sweep.ts` →
-- `apps/web/lib/room-covenant-reads.ts`, over the fail-closed read authority). This
-- migration does NOT compute drift — E3/E7 own that. It gives the sweep a durable place
-- to PROJECT its verdict so a client renders `✓`/`~` from a synced row instead of an
-- SSR-baked map refreshed only by `router.refresh()`.
--
-- ## THE WRITE BOUNDARY — a projection only the server may author (RESERVED, #208)
--
-- A `✓`/`~` here is the covenant's server-derived reading of a HUMAN signature. A
-- client that could write this table could paint a `✓` over content a human never
-- vouched for, or bury a `~` the sweep raised — the exact authorship-blindness the
-- DETECT arm exists to close. So, mirroring migration 0053's boundary for
-- `ydoc_updates`:
--
--   * INSERT / UPDATE / DELETE / TRUNCATE are REVOKEd from PUBLIC and from every
--     application role (the 0004/0053 loop: a non-superuser login role holding SELECT
--     on `core_events`). Those roles get SELECT and nothing else.
--   * There is NO client/app write door at all — UNLIKE `ydoc_updates`, whose members
--     legitimately APPEND through `atrium_append_ydoc_update`. The verdict is
--     server-derived, so the only writer is the table OWNER, which is the server
--     process in every deployment this repo ships (`upsertCovenantStatus`).
--   * The durable non-owner boundary — running the app under a role the REVOKE
--     actually binds — is #208's, exactly as for the ydoc tables.
--
-- The REVOKE/role semantics on this covenant-authority table are DRAFTED for Lars's
-- ratification (map #162's reserved-for-Lars line). This migration implements them;
-- it does not ratify them.
--
-- ## Electric's access — publication here, SELECT grant reserved to #208
--
-- Electric streams a table only if (a) it is in the publication and (b) the
-- least-privilege `atrium_electric` role can SELECT it. This migration does (a) — the
-- owner adds `covenant_status` to `electric_publication_default`, and sets REPLICA
-- IDENTITY FULL, which Electric requires and its role cannot set. It does NOT do (b):
-- the `atrium_electric` SELECT grant lives in `deploy/electric-role.sql` (#208's
-- reserved role definition), NOT in a migration — exactly as the ydoc tables' SELECT
-- grant does. So PRODUCTION streaming of `covenant_status` needs one reserved line
-- added there:  GRANT SELECT ON TABLE "covenant_status" TO "atrium_electric";
-- That grant is RESERVED for Lars (#208) and is deliberately not made here.
--
-- ## No generated columns, on purpose (T0's op_digest lesson)
--
-- The shape proxy forwards no `columns` param, so Electric streams every column. A
-- GENERATED column would then have to be named explicitly or Electric errors — so this
-- table has none: `generation` is a plain bigint the server upsert bumps
-- (`generation + 1`), not a generated expression.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TYPE "covenant_status_kind" AS ENUM ('ok', 'drift', 'unresolved');--> statement-breakpoint

-- The room column is `room` (not `room_id`): the shape proxy pins its predicate as
-- `where room = $1`, the SAME predicate the two ydoc tables use, so a synced table
-- scopes on a `room` column of that exact name. `covenant_anchors` — the human-`✓`
-- ledger, never synced — spells it `room_id`; this table is on the wire, so it takes
-- the wire's column name.
CREATE TABLE "covenant_status" (
  "room" uuid NOT NULL,
  "object_id" uuid NOT NULL,
  "status" "covenant_status_kind" NOT NULL,
  -- Per-row MONOTONE token, bumped on every upsert, so a client folding out-of-order
  -- Electric deliveries keeps the newest verdict for a span. Monotone per
  -- (room, object_id), not global — the upsert's `generation + 1` guarantees it.
  "generation" bigint DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "covenant_status_pk" PRIMARY KEY ("room", "object_id"),
  CONSTRAINT "covenant_status_generation_positive" CHECK ("covenant_status"."generation" >= 1),
  -- Scoped to the room (cascade with the room), and a real accepted object in THAT
  -- room (composite, cascade with the object) — a `~`/`✓` over a span that no longer
  -- exists is meaningless.
  CONSTRAINT "covenant_status_room_fk"
    FOREIGN KEY ("room") REFERENCES "rooms"("id") ON DELETE CASCADE,
  CONSTRAINT "covenant_status_object_same_room_fk"
    FOREIGN KEY ("room", "object_id")
    REFERENCES "accepted_objects"("room_id", "id") ON DELETE CASCADE
);--> statement-breakpoint

-- The shape's initial snapshot scans `room = $1`; this index is that read path.
CREATE INDEX "covenant_status_room_idx" ON "covenant_status" USING btree ("room");--> statement-breakpoint

COMMENT ON TABLE "covenant_status" IS
  'The durable, read-only projection of the SERVER''s covenant verdict (✓/~) for every certified span in a room (#206, E6). Source = the built drift sweep (room-drift-sweep → room-covenant-reads over the fail-closed read authority); E6 projects, it does not compute drift. Written only by the table OWNER via upsertCovenantStatus (no client/app write door — unlike ydoc_updates); INSERT/UPDATE/DELETE are REVOKEd from PUBLIC and every application role, which get SELECT only. Synced read-only to clients over the same per-room Electric shape ydoc_updates uses (room = $1). The REVOKE/role semantics are DRAFTED for Lars''s ratification; the durable non-owner boundary is #208, and the atrium_electric SELECT grant for production streaming is a reserved line in deploy/electric-role.sql, not here.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## Privileges — the 0004/0053 shape, minus the write door
-- ─────────────────────────────────────────────────────────────────────────────
--
-- PUBLIC loses every write verb. Then every non-superuser login role this repo
-- already treats as an application role — identified, as 0004/0053 identify it, by
-- holding SELECT on `core_events` — is given SELECT and nothing else. There is NO
-- EXECUTE-on-a-door grant here because there is no door: the verdict is server-owned,
-- so an application role reads the projection and never writes it. The owner is not
-- bound by these REVOKEs (it authors the projection); the Electric replication role is
-- NOT in this loop (it holds no SELECT on core_events) and receives nothing here — its
-- SELECT is the reserved deploy/electric-role.sql line (#208).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "covenant_status" FROM PUBLIC;--> statement-breakpoint

DO $privileges$
DECLARE
  v_owner name;
  v_role name;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = 'covenant_status' AND n.nspname = 'public';

  FOR v_role IN
    SELECT r.rolname FROM pg_roles r
    WHERE r.rolcanlogin
      AND NOT r.rolsuper
      AND r.rolname <> v_owner
      AND has_table_privilege(r.rolname, 'public.core_events', 'SELECT')
  LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.covenant_status FROM %I', v_role);
    EXECUTE format('GRANT SELECT ON TABLE public.covenant_status TO %I', v_role);
  END LOOP;
END;
$privileges$;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## Electric's publication + REPLICA IDENTITY (the owner's half of the read path)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- IDEMPOTENT, and RECONCILING, exactly as 0053: the publication is a cluster object
-- with no IF NOT EXISTS for ADD TABLE, so the membership is guarded. On a database
-- that never had the publication (a migration run before Electric bring-up) it is
-- created naming this table; on one that has it, this table is ADDed if missing. The
-- ydoc tables' membership is 0053's to reconcile and is left untouched.
DO $publication$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'electric_publication_default') THEN
    CREATE PUBLICATION "electric_publication_default" FOR TABLE "covenant_status";
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'electric_publication_default'
      AND schemaname = 'public' AND tablename = 'covenant_status'
  ) THEN
    ALTER PUBLICATION "electric_publication_default" ADD TABLE "covenant_status";
  END IF;
END;
$publication$;--> statement-breakpoint

-- REPLICA IDENTITY FULL is Electric's requirement and is normally Electric's to set
-- by ALTERing the table — which needs ownership the least-privilege replication role
-- deliberately lacks. So the owner sets it here. The usual FULL cost (every UPDATE/
-- DELETE writes the whole old row to WAL) is negligible: one small row per certified
-- span, upserted on recompute. Idempotent by nature.
ALTER TABLE "covenant_status" REPLICA IDENTITY FULL;
