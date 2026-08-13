-- ═════════════════════════════════════════════════════════════════════════════
-- THE PLAN RLIMIT, ENFORCED AT THE SPAWN BOUNDARY — A DRAW IS AN AUTHORIZED DRAW.
--
-- #118, from #115's binding resolution. A plan carries a human-set **rlimit
-- slice**: a ceiling on the number of *authorized draws* (spawns/continues)
-- Atrium may grant it. Every `session_opened` is one draw; the enforced quantity
-- is `plans.authorized_draws` — the count Atrium ITSELF granted and records under
-- the ledger lock, which a session cannot lie to it about — checked against
-- `plans.rlimit_slice` at the authorization boundary. This extends #102/#110's
-- certify/authorize gate from CERTIFY to SPEND.
--
-- Two things are load-bearing and both are structural:
--
--   1. **Enforce on AUTHORIZED DRAWS, not on adapter-reported spend.** The `~`
--      dollar layer already on `plans` — `budget_limit_micros` (the human's
--      dollar intent) and `spent_micros` (the adapter's rollup) — is human-visible
--      and reconciled, and is NEVER the enforcement variable. The slice is
--      denominated in draws precisely so a session that reports spend=0 still
--      cannot get one more draw than the slice funds. This file keeps the two
--      layers in separate columns; a divergence between them is a row that won't
--      balance, not a gate.
--
--   2. **human = init sets the ceiling; a machine never raises its own.** The
--      ONLY writer of `rlimit_slice` is the projection of `plan_rlimit_set`, the
--      human-only `set_plan_rlimit` verb, refused for a non-human BEFORE the
--      append exactly as a machine trying to certify is (`commands.ts`). A
--      machine-authored slice raise is campaign-stopping and is refused by
--      construction: there is no other path to the column.
--
-- The refusal is DURABLE and RECEIPTED. A spawn that would exceed the slice
-- appends a `draw_refused` ledger row (`reason=budget`) instead of a
-- `session_opened` — a visible row, never a silent stop-after. Both new kinds are
-- ledger-only: added to `event_type`, KEPT OUT of `coreEventTypes`, folded by no
-- covenant reducer.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. The two new ledger-only event kinds
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ALTER TYPE … ADD VALUE in the migrator's single transaction: permitted, and
-- not USED as an enum label anywhere here (the room CHECK below compares
-- `payload->>'type'` as TEXT), so it is safe alongside the ADD VALUEs — the same
-- discipline 0023 and 0026/0027 rely on.
ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'plan_rlimit_set';--> statement-breakpoint
ALTER TYPE "public"."event_type" ADD VALUE IF NOT EXISTS 'draw_refused';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. The slice and the committed authorized-draw accounting
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `rlimit_slice` is nullable — NULL is an unfunded plan (no ceiling, the pre-#118
-- behaviour). `authorized_draws` counts up from zero as the spawn gate grants
-- draws. Both are STRUCTURALLY SEPARATE from `spent_micros`: the enforcement
-- layer (draws Atrium granted) and the reconciliation layer (dollars the adapter
-- reported) never share a column.
ALTER TABLE "plans" ADD COLUMN "rlimit_slice" bigint;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "authorized_draws" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "plans" ADD CONSTRAINT "plans_rlimit_slice_nonnegative"
  CHECK ("plans"."rlimit_slice" IS NULL OR "plans"."rlimit_slice" >= 0);--> statement-breakpoint

ALTER TABLE "plans" ADD CONSTRAINT "plans_authorized_draws_nonnegative"
  CHECK ("plans"."authorized_draws" >= 0);--> statement-breakpoint

COMMENT ON COLUMN "plans"."rlimit_slice" IS
  'The ENFORCED ceiling (#118): a human-set ceiling on the number of authorized draws (spawns/continues) this plan may be granted, denominated in DRAWS not micro-dollars. NULL = unfunded (no ceiling). The only writer is the projection of plan_rlimit_set (the human-only set_plan_rlimit verb); no machine-authored path raises a slice. Enforcement compares authorized_draws to this, never the adapter-reported spent_micros — so a session under-reporting spend cannot overspend by construction.';--> statement-breakpoint

COMMENT ON COLUMN "plans"."authorized_draws" IS
  'The committed authorized-draw accounting (#118): how many draws Atrium has granted under this plan. Incremented by one in the same append transaction as each session_opened it grants (projectSessionOpened), under the global ledger lock, so it equals count(sessions) for the plan by construction and cannot be forged. The quantity the spawn gate enforces the slice against.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 3. The payload-room CHECK, extended to the two new kinds
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The same discriminated CHECK 0007 introduced and 0023 last extended, with two
-- WHEN arms added. Each new kind declares exactly a top-level `roomId` (like
-- `message_posted` and the six lifecycle kinds), so each maps to ARRAY['roomId']
-- on the left and payload->>'roomId' on the right. The `coalesce(…, false)` tail
-- is unchanged and still refuses any kind its CASE does not name — which is why
-- these arms MUST land with the enum values, or an append of either kind would be
-- refused at INSERT. DROP + ADD is validated against every existing row, and the
-- new arms are a strict superset, so every row that passed the old check passes
-- this one.
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
        ELSE "core_events"."room_id"::text
      END, false));
