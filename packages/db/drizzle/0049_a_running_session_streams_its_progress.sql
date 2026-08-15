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
-- never outlive the real object. The clear is part of the same exit UPDATE that
-- legitimately writes the terminal (OLD.status is still 'open'), so the
-- `sessions_terminal_immutable` progress clause added below does not fire on it —
-- that clause binds a LATER mutation of an already-terminal row. And a
-- `status = 'open' OR progress IS NULL` CHECK (below) makes terminal-null a
-- construction-time invariant, so no writer can resurrect a preview onto an exited
-- session even with triggers disabled.
-- ═════════════════════════════════════════════════════════════════════════════

-- IDEMPOTENT (round-1 gauntlet, finding 6): `IF NOT EXISTS`, so a partial re-run of
-- this migration's statements does not error on an already-added column.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "progress" jsonb;--> statement-breakpoint

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
--
-- IDEMPOTENT + LOCK-PATTERNED (round-1 gauntlet, finding 6). Two changes over 0045's
-- plain `DROP` + validated `ADD`:
--
--   * IDEMPOTENT: `DROP … IF EXISTS` immediately before the `ADD` (so the pair is
--     re-runnable — a re-apply drops then re-adds), and the `VALIDATE` guarded on
--     `convalidated`, so a partial re-apply does not error.
--   * NOT VALID + VALIDATE: the correct lock-safer SHAPE for a live ledger — a plain
--     validated `ADD CONSTRAINT … CHECK` scans the whole table under ACCESS EXCLUSIVE,
--     whereas `NOT VALID` is metadata-only and `VALIDATE` scans under the weaker SHARE
--     UPDATE EXCLUSIVE. Existing rows already satisfy it (the sole change from 0045 is
--     the `session_phase_changed` arm, and no pre-existing row carries that brand-new
--     enum type), so validation cannot fail.
--
-- HONEST BOUND, measured (drizzle-orm 0.45.2 `pg-core/dialect.cjs` `migrate`): the
-- migrator wraps ALL pending migrations in ONE outer transaction, so the ACCESS
-- EXCLUSIVE this `DROP` takes is held until the whole batch commits and the `VALIDATE`
-- runs under it regardless of its own weaker lock request. The lock decoupling is
-- therefore realized only when these statements run in SEPARATE transactions — a
-- manual/ops apply, or a future migrator that commits per-file — which the idempotency
-- guards now make safe. Under the batched migrator the win here is idempotency; the
-- shape is correct and future-proof rather than currently lock-reducing.
ALTER TABLE "core_events" DROP CONSTRAINT IF EXISTS "core_events_payload_room_matches";--> statement-breakpoint
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
      END, false)) NOT VALID;--> statement-breakpoint

-- Validate under SHARE UPDATE EXCLUSIVE, not the ACCESS EXCLUSIVE a validated ADD
-- would have taken. Guarded on `convalidated` so a re-run is a no-op rather than a
-- redundant scan.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'core_events_payload_room_matches'
      AND conrelid = 'core_events'::regclass
      AND convalidated
  ) THEN
    ALTER TABLE "core_events" VALIDATE CONSTRAINT "core_events_payload_room_matches";
  END IF;
END $$;--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- TERMINAL-NULL PROGRESS IS A TABLE FACT (round-1 gauntlet, finding 5).
--
-- The settle projection (`projectSessionExit`) clears `sessions.progress` to NULL in
-- the same UPDATE that writes the terminal receipt — the durable receipt replaces
-- the live stream wholesale (#152 convergence). That is one writer's discipline; this
-- makes it the TABLE's, our construction-time-invariant doctrine (§ the covenant's
-- prefer-a-CHECK rule). A settled/failed session may not carry a live `~` preview:
--
--   status = 'open' OR progress IS NULL
--
-- so a raw UPDATE (or a future projection) that resurrected a preview onto an exited
-- session — re-opening the "stale preview outlives the receipt" hazard the clear
-- closes — is refused by the row itself. The column is brand-new and all-NULL here,
-- so every existing row satisfies it and the validated add is instant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_progress_open_or_null'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT "sessions_progress_open_or_null"
      CHECK ("status" = 'open' OR "progress" IS NULL);
  END IF;
END $$;--> statement-breakpoint

-- And the terminal-immutability trigger (0025) grows a `progress` clause, so the same
-- rule is enforced the moment a row is ALREADY terminal (the CHECK covers the row's
-- new value; this covers a mutation of an already-frozen row). Once settled/failed,
-- `progress` is written once — to NULL, by the exit UPDATE whose OLD.status is still
-- 'open' so this branch does not fire — and may not change thereafter. `CREATE OR
-- REPLACE` re-defines 0025's function in place; the trigger binding is unchanged.
CREATE OR REPLACE FUNCTION "atrium_sessions_terminal_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $terminal$
BEGIN
  IF OLD."status"::text IN ('settled', 'failed') THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION
        'session % is % and may not become %; a session takes exactly one exit, and settled ↔ failed is two contradictory receipts for one process',
        OLD."id", OLD."status", NEW."status"
        USING ERRCODE = '23514', CONSTRAINT = 'sessions_terminal_immutable';
    END IF;
    IF NEW."exit_summary" IS DISTINCT FROM OLD."exit_summary"
       OR NEW."spend_micros" IS DISTINCT FROM OLD."spend_micros"
       OR NEW."context_pct" IS DISTINCT FROM OLD."context_pct"
       OR NEW."settled_by_event_id" IS DISTINCT FROM OLD."settled_by_event_id" THEN
      RAISE EXCEPTION
        'session % is %; its exit receipt (exit_summary, spend_micros, context_pct, settled_by_event_id) is written once and may not be rewritten',
        OLD."id", OLD."status"
        USING ERRCODE = '23514', CONSTRAINT = 'sessions_terminal_immutable';
    END IF;
    IF NEW."progress" IS DISTINCT FROM OLD."progress" THEN
      RAISE EXCEPTION
        'session % is %; its live progress preview converged to the exit receipt and was cleared, and a terminal session may not stream a new one',
        OLD."id", OLD."status"
        USING ERRCODE = '23514', CONSTRAINT = 'sessions_terminal_immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$terminal$;--> statement-breakpoint

COMMENT ON COLUMN "sessions"."progress" IS
  'Live progress snapshot (#159, decided in #152). A `~` preview of a running session''s work — { progressSeq, phase, spendMicros, contextPct, diff, updatedAt, heartbeatAt } — written by the report_session_progress projection and CLEARED (set null) by the settle projection, where the durable receipt replaces the stream wholesale. Non-epistemic, sessions-local: no certified/verified field, no route to an accepted_objects `✓`.';
