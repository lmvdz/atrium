-- ─────────────────────────────────────────────────────────────────────────────
-- issue #22 — the durable ledger, and composite (room_id, id) FK discipline.
--
-- THE APPEND INVARIANT, quoted verbatim from #22. Everything about the shape of
-- `core_events` follows from it:
--
--   "the durable ledger must contain ONLY events accepted in canonical order —
--    room_seq is assigned transactionally at append, so an out-of-order event is
--    rejected at the command layer and never persisted. The reducer watermark is
--    a defense-in-depth guard, not a data path; if refused events could reach the
--    log, full replay (which re-sorts) would accept what live ingestion refused
--    and the two states would diverge."
--
-- So there is no status column, no `rejected` flag and no quarantine table here:
-- a refused event is not history and must leave no row. The command layer calls
-- @atrium/core's `appendEvent` inside the same transaction as the INSERT below,
-- and a rejection aborts that transaction.
--
-- TWO SEQUENCES — this is #19 r3's global-cursor consequence, resolved:
--   `seq`      bigserial, PRIMARY KEY, the total order ACROSS rooms. Core state
--              gates on a global cursor, so the ledger owes it a global order.
--   `room_seq` the per-room client protocol from #12, gap-free and
--              duplicate-free via UNIQUE(room_id, room_seq) plus serialized
--              assignment, so `since(room, room_seq)` recovers an identical
--              history after a dropped socket.
--
-- COMPOSITE FKs: a plain foreign key checks that a row exists; only a composite
-- (room_id, id) one checks that it exists IN THIS ROOM. Rooms are the isolation
-- boundary, so every reference that could cross one is rewritten below.
--
-- This file is hand-ordered. drizzle-kit emitted the composite FOREIGN KEYs
-- before the UNIQUE indexes they reference, which Postgres rejects; the unique
-- targets are therefore created first. The snapshot in meta/ describes the same
-- end state either way.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "public"."event_type" AS ENUM('proposal_recorded', 'proposal_rejected', 'object_accepted', 'object_corrected', 'relation_added', 'message_posted', 'attention_resolved');--> statement-breakpoint
CREATE TABLE "core_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"room_seq" bigint NOT NULL,
	"id" text NOT NULL,
	"type" "event_type" NOT NULL,
	"actor" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"appended_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_events_room_seq_positive" CHECK ("core_events"."room_seq" >= 1),
	CONSTRAINT "core_events_payload_id_matches" CHECK ("core_events"."payload"->>'id' = "core_events"."id"),
	CONSTRAINT "core_events_payload_type_matches" CHECK ("core_events"."payload"->>'type' = "core_events"."type"::text),
	CONSTRAINT "core_events_payload_has_at" CHECK (jsonb_exists("core_events"."payload", 'at'))
);
--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "core_events_room_seq_key" ON "core_events" USING btree ("room_id","room_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "core_events_id_key" ON "core_events" USING btree ("id");--> statement-breakpoint
CREATE INDEX "core_events_room_order_idx" ON "core_events" USING btree ("room_id","room_seq");--> statement-breakpoint
CREATE INDEX "core_events_order_idx" ON "core_events" USING btree ("occurred_at","id");--> statement-breakpoint

-- ── seen_seq: the per-user read cursor, widened to match room_seq ────────────
-- Added and backfilled rather than swapped, so no cursor is lost. The old
-- `last_read_seq` is dropped in the next migration, once nothing reads it.
ALTER TABLE "memberships" ADD COLUMN "seen_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "memberships" SET "seen_seq" = "last_read_seq";--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_seen_seq_nonnegative" CHECK ("memberships"."seen_seq" >= 0);--> statement-breakpoint

-- ── room_id on the tables that only had a bare id reference ──────────────────
-- Added nullable, derived from the parent, then made NOT NULL: the column is
-- new but the rows may not be, and a NOT NULL default of nothing would fail on
-- any database that already has provenance or correction rows.
ALTER TABLE "corrections" ADD COLUMN "room_id" uuid;--> statement-breakpoint
UPDATE "corrections" c SET "room_id" = o."room_id" FROM "accepted_objects" o WHERE o."id" = c."object_id";--> statement-breakpoint
ALTER TABLE "corrections" ALTER COLUMN "room_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "corrections" ADD COLUMN "event_id" text;--> statement-breakpoint
ALTER TABLE "object_sources" ADD COLUMN "room_id" uuid;--> statement-breakpoint
UPDATE "object_sources" s SET "room_id" = o."room_id" FROM "accepted_objects" o WHERE o."id" = s."object_id";--> statement-breakpoint
ALTER TABLE "object_sources" ALTER COLUMN "room_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "proposal_sources" ADD COLUMN "room_id" uuid;--> statement-breakpoint
UPDATE "proposal_sources" s SET "room_id" = p."room_id" FROM "proposals" p WHERE p."id" = s."proposal_id";--> statement-breakpoint
ALTER TABLE "proposal_sources" ALTER COLUMN "room_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_sources" ADD CONSTRAINT "object_sources_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_sources" ADD CONSTRAINT "proposal_sources_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "corrections_event_key" ON "corrections" USING btree ("event_id");--> statement-breakpoint

-- ── out with the bare-id foreign keys ────────────────────────────────────────
ALTER TABLE "accepted_objects" DROP CONSTRAINT "accepted_objects_objective_id_accepted_objects_id_fk";--> statement-breakpoint
ALTER TABLE "accepted_objects" DROP CONSTRAINT "accepted_objects_proposal_id_proposals_id_fk";--> statement-breakpoint
ALTER TABLE "accepted_objects" DROP CONSTRAINT "accepted_objects_superseded_by_id_accepted_objects_id_fk";--> statement-breakpoint
ALTER TABLE "attention_items" DROP CONSTRAINT "attention_items_object_id_accepted_objects_id_fk";--> statement-breakpoint
ALTER TABLE "corrections" DROP CONSTRAINT "corrections_object_id_accepted_objects_id_fk";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_reply_to_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "relations" DROP CONSTRAINT "relations_from_object_id_accepted_objects_id_fk";--> statement-breakpoint
ALTER TABLE "relations" DROP CONSTRAINT "relations_to_object_id_accepted_objects_id_fk";--> statement-breakpoint
ALTER TABLE "relations" DROP CONSTRAINT "relations_to_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "object_sources" DROP CONSTRAINT "object_sources_object_id_accepted_objects_id_fk";--> statement-breakpoint
ALTER TABLE "object_sources" DROP CONSTRAINT "object_sources_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "proposal_sources" DROP CONSTRAINT "proposal_sources_proposal_id_proposals_id_fk";--> statement-breakpoint
ALTER TABLE "proposal_sources" DROP CONSTRAINT "proposal_sources_message_id_messages_id_fk";--> statement-breakpoint

-- ── the composite targets, BEFORE anything references them ───────────────────
CREATE UNIQUE INDEX "accepted_objects_room_id_key" ON "accepted_objects" USING btree ("room_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_room_id_key" ON "messages" USING btree ("room_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_room_id_key" ON "proposals" USING btree ("room_id","id");--> statement-breakpoint

-- ── and in with the composite ones ───────────────────────────────────────────
-- No ON DELETE SET NULL anywhere below: Postgres would null every referencing
-- column including room_id, which is NOT NULL, so the action could only fail.
-- NO ACTION is checked at end of statement, so a room-wide cascade still works.
ALTER TABLE "accepted_objects" ADD CONSTRAINT "accepted_objects_objective_same_room_fk" FOREIGN KEY ("room_id","objective_id") REFERENCES "public"."accepted_objects"("room_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_objects" ADD CONSTRAINT "accepted_objects_superseded_by_same_room_fk" FOREIGN KEY ("room_id","superseded_by_id") REFERENCES "public"."accepted_objects"("room_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_objects" ADD CONSTRAINT "accepted_objects_proposal_same_room_fk" FOREIGN KEY ("room_id","proposal_id") REFERENCES "public"."proposals"("room_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_object_same_room_fk" FOREIGN KEY ("room_id","object_id") REFERENCES "public"."accepted_objects"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_object_same_room_fk" FOREIGN KEY ("room_id","object_id") REFERENCES "public"."accepted_objects"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_same_room_fk" FOREIGN KEY ("room_id","reply_to_id") REFERENCES "public"."messages"("room_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_from_object_same_room_fk" FOREIGN KEY ("room_id","from_object_id") REFERENCES "public"."accepted_objects"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_object_same_room_fk" FOREIGN KEY ("room_id","to_object_id") REFERENCES "public"."accepted_objects"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_message_same_room_fk" FOREIGN KEY ("room_id","to_message_id") REFERENCES "public"."messages"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_sources" ADD CONSTRAINT "object_sources_object_same_room_fk" FOREIGN KEY ("room_id","object_id") REFERENCES "public"."accepted_objects"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_sources" ADD CONSTRAINT "object_sources_message_same_room_fk" FOREIGN KEY ("room_id","message_id") REFERENCES "public"."messages"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_sources" ADD CONSTRAINT "proposal_sources_proposal_same_room_fk" FOREIGN KEY ("room_id","proposal_id") REFERENCES "public"."proposals"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_sources" ADD CONSTRAINT "proposal_sources_message_same_room_fk" FOREIGN KEY ("room_id","message_id") REFERENCES "public"."messages"("room_id","id") ON DELETE cascade ON UPDATE no action;
