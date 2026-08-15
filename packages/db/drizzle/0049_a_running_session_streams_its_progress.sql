-- ═════════════════════════════════════════════════════════════════════════════
-- A RUNNING SESSION STREAMS ITS PROGRESS — the late-join snapshot column (#159).
--
-- Decided in #152. A running session's work streams as ephemeral WS frames
-- (`session_heartbeat`, `session_diff_delta`, lost on reconnect) and a durable
-- phase timeline (`session_phase_changed`, a ledger-only room event). Neither is
-- enough for a client that JOINS mid-run: the frames it missed are gone, and the
-- phase events replay but carry no diff/heartbeat. This column is the third leg —
-- a bounded projection SNAPSHOT the server refreshes as progress arrives:
--
--   { progressSeq, phase, spendMicros, contextPct, diff, updatedAt, heartbeatAt }
--
-- A late joiner reads it (an authenticated row read) and then applies live frames
-- whose `progressSeq` is greater; a seq gap ⇒ drop and refetch. `diff` reuses the
-- receipt's own `SessionDiff` dialect — ceilinged and coherence-checked — so there
-- is ONE diff schema, not a second lossier copy free to disagree.
--
-- COVENANT (#152 boundary, point 1). This is a projection row, NOT a ledger
-- payload, and it lives on `sessions` — no `accepted_objects` column, no
-- `plans.rlimit_slice`, no `plans.authorized_draws`. So a progress write can never
-- reach a `✓`; `progress-writeset.test.ts` folds a progress projection and pins the
-- write-set to `sessions` alone. Nothing here is epistemic: there is no
-- `certified`/`verified` field and there can never be one, every value is a `~`
-- draft the running process reported.
--
-- CLEARED AT TERMINAL. `projectSessionExit` sets this column NULL in the same
-- transaction as the exit receipt: at settle/fail the durable receipt
-- (`sessions.artifact`) REPLACES the stream wholesale, and a stale preview must
-- never outlive the real object. `sessions_terminal_immutable` (0025) freezes a
-- terminal row's status/receipt columns but not this one, and the clear is part of
-- the same exit UPDATE that legitimately writes the terminal, so it is not a later
-- mutation of a frozen row.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "sessions" ADD COLUMN "progress" jsonb;--> statement-breakpoint

-- THE DURABLE PHASE EVENT joins the ledger's `event_type` enum — added but KEPT OUT
-- of `coreEventTypes`, exactly as the eleven other ledger-only kinds are (the
-- reducer folds none of them). `ADD VALUE IF NOT EXISTS` is idempotent and, as in
-- 0045, safe alongside the CHECK recreate below: the constraint reads
-- `payload->>'type'` as TEXT, never the enum value, so the same-transaction
-- restriction on a freshly-added enum value does not bite.
ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'session_phase_changed';--> statement-breakpoint

-- THE LEDGER-SIDE ROOM-MATCH BACKSTOP (0007/0023/0045) must NAME the new kind, or a
-- `session_phase_changed` append — whose payload carries a top-level `roomId`, the
-- same shape the lifecycle kinds have — falls through the CASE to NULL on the right,
-- `room_id IS NOT DISTINCT FROM NULL` is false against a NOT NULL room, and the
-- append is refused. This recreates the constraint with `session_phase_changed`
-- added to BOTH arms (required-keys = ARRAY['roomId']; declared room = payload
-- roomId), the whole allowlist otherwise byte-identical to 0045's.
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
        WHEN 'plan_rlimit_set' THEN ARRAY['roomId']
        WHEN 'draw_refused' THEN ARRAY['roomId']
        WHEN 'session_signaled' THEN ARRAY['roomId']
        WHEN 'session_subscribed' THEN ARRAY['roomId']
        WHEN 'session_phase_changed' THEN ARRAY['roomId']
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
        WHEN 'plan_rlimit_set' THEN "core_events"."payload"->>'roomId'
        WHEN 'draw_refused' THEN "core_events"."payload"->>'roomId'
        WHEN 'session_signaled' THEN "core_events"."payload"->>'roomId'
        WHEN 'session_subscribed' THEN "core_events"."payload"->>'roomId'
        WHEN 'session_phase_changed' THEN "core_events"."payload"->>'roomId'
        ELSE "core_events"."room_id"::text
      END, false));--> statement-breakpoint

COMMENT ON COLUMN "sessions"."progress" IS
  'Live progress snapshot (#159, decided in #152). A `~` preview of a running session''s work — { progressSeq, phase, spendMicros, contextPct, diff, updatedAt, heartbeatAt } — written by the report_session_progress projection and CLEARED (set null) by the settle projection, where the durable receipt replaces the stream wholesale. Non-epistemic, sessions-local: no certified/verified field, no route to an accepted_objects `✓`.';
