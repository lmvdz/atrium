-- ═════════════════════════════════════════════════════════════════════════════
-- SIX LEDGER-ONLY LIFECYCLE EVENTS, AND THE ROOM CHECK THAT ENUMERATES THEM.
--
-- #116, from #114's resolution. The agent/plan/session lifecycle rides the same
-- spine everything else does: six new `event_type` values that land in
-- `core_events` with a `room_seq` and an append order. They are LEDGER-ONLY —
-- added to the enum but KEPT OUT of `coreEventTypes` (schema.ts), so the covenant
-- reducer and `CoreState` never fold them, exactly the standing `message_posted`
-- and `attention_resolved` hold. The `plans`/`sessions` tables and
-- `attention_items` are their projections.
--
-- All six carry a top-level `roomId`, like `message_posted` and
-- `attention_resolved`. The `core_events_payload_room_matches` CHECK is
-- **extended to enumerate them** — mandatory, because that CHECK FAILS CLOSED:
-- its final `coalesce(…, false)` refuses any `type` its CASE does not name, so an
-- append of one of these kinds would be REFUSED at INSERT until the CHECK learns
-- the kind. Adding the enum value without the CHECK arm would take the whole
-- lifecycle offline; the two land together.
--
-- ## ALTER TYPE … ADD VALUE in the migration transaction
--
-- drizzle's migrator runs every pending migration in one transaction. Postgres
-- 12+ permits ADD VALUE there but refuses to USE the new label in the same
-- transaction — 0017 relies on the same permission for `actor_kind`. Nothing
-- here uses these labels as enum labels: the CHECK below compares
-- `payload->>'type'` as TEXT against string literals, resolving no enum label at
-- all, so it is safe to apply alongside the ADD VALUEs.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. The six lifecycle event types
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'plan_opened';--> statement-breakpoint
ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'plan_settled';--> statement-breakpoint
ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'session_opened';--> statement-breakpoint
ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'session_settled';--> statement-breakpoint
ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'session_failed';--> statement-breakpoint
ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'signal_raised';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. The room CHECK, extended to the six new kinds
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The same discriminated CHECK 0007 introduced, with six WHEN arms added. Each
-- new kind declares exactly the top-level `roomId` key (like message_posted), so
-- each maps to ARRAY['roomId'] on the left and payload->>'roomId' on the right.
-- The `coalesce(…, false)` tail is unchanged, and it is what still refuses a
-- ninth, un-enumerated kind — the fail-closed property this whole check exists
-- for. DROP + ADD is validated against every existing row, and the new arms are a
-- strict superset, so every row that passed the old check passes this one.
ALTER TABLE "core_events" DROP CONSTRAINT "core_events_payload_room_matches";--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_payload_room_matches" CHECK (coalesce(array_remove(ARRAY[
        CASE WHEN "core_events"."payload"->'proposal'->>'roomId' IS NOT NULL THEN 'proposal.roomId' END,
        CASE WHEN "core_events"."payload"->'object'->>'roomId' IS NOT NULL THEN 'object.roomId' END,
        CASE WHEN "core_events"."payload"->'relation'->>'roomId' IS NOT NULL THEN 'relation.roomId' END,
        CASE WHEN "core_events"."payload"->>'roomId' IS NOT NULL THEN 'roomId' END
      ], NULL) = CASE "core_events"."payload"->>'type'
        WHEN 'proposal_recorded' THEN ARRAY['proposal.roomId']
        WHEN 'object_accepted' THEN ARRAY['object.roomId']
        WHEN 'relation_added' THEN ARRAY['relation.roomId']
        WHEN 'message_posted' THEN ARRAY['roomId']
        WHEN 'attention_resolved' THEN ARRAY['roomId']
        WHEN 'plan_opened' THEN ARRAY['roomId']
        WHEN 'plan_settled' THEN ARRAY['roomId']
        WHEN 'session_opened' THEN ARRAY['roomId']
        WHEN 'session_settled' THEN ARRAY['roomId']
        WHEN 'session_failed' THEN ARRAY['roomId']
        WHEN 'signal_raised' THEN ARRAY['roomId']
        WHEN 'proposal_rejected' THEN ARRAY[]::text[]
        WHEN 'proposal_superseded' THEN ARRAY[]::text[]
        WHEN 'object_corrected' THEN ARRAY[]::text[]
      END AND "core_events"."room_id"::text IS NOT DISTINCT FROM CASE "core_events"."payload"->>'type'
        WHEN 'proposal_recorded' THEN "core_events"."payload"->'proposal'->>'roomId'
        WHEN 'object_accepted' THEN "core_events"."payload"->'object'->>'roomId'
        WHEN 'relation_added' THEN "core_events"."payload"->'relation'->>'roomId'
        WHEN 'message_posted' THEN "core_events"."payload"->>'roomId'
        WHEN 'attention_resolved' THEN "core_events"."payload"->>'roomId'
        WHEN 'plan_opened' THEN "core_events"."payload"->>'roomId'
        WHEN 'plan_settled' THEN "core_events"."payload"->>'roomId'
        WHEN 'session_opened' THEN "core_events"."payload"->>'roomId'
        WHEN 'session_settled' THEN "core_events"."payload"->>'roomId'
        WHEN 'session_failed' THEN "core_events"."payload"->>'roomId'
        WHEN 'signal_raised' THEN "core_events"."payload"->>'roomId'
        ELSE "core_events"."room_id"::text
      END, false));
