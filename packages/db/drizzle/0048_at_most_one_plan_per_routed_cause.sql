-- ═════════════════════════════════════════════════════════════════════════════
-- AT MOST ONE PLAN PER ROUTED CAUSE MESSAGE — THE BOARD'S OWN IDEMPOTENCY.
--
-- #148 FIX 1, the board-level analogue of 0047's funded-arm claim. 0047 made a
-- plan deliberately EXEMPT from the funded-arm uniqueness, reasoning that "two
-- free boards from one message spend nothing". That is true for SPEND, and the
-- spend exemption stands: a plan still takes no funded_arms claim, because a plan
-- is not a draw and must not consume a draw claim.
--
-- What the spend-scoped reasoning did not weigh is a DURABLE ROUTING DAEMON. The
-- channel loop (apps/loop) opens a plan by sending open_plan and only THEN
-- journaling the request; a crash in that window replays the goal and re-sends
-- open_plan. The funded-arm claim covers the SESSION double-fund, but the second
-- plan is free — so the replay opens a permanently-orphaned empty board: it never
-- draws (the cause has already advanced past its draw) and never settles (a plan
-- settles only after a child session, and it has none). Orphan boards accumulate,
-- one per crash, forever. The board needs a claim of its own.
--
-- A PARTIAL UNIQUE INDEX, not a table (contrast funded_arms): the draw-taking
-- appends are two — session_opened and session_signaled{resume} — projecting into
-- two tables, so only a shared claim table could span them, and a partial index
-- on sessions would have silently missed every resume (0047's own note). A plan
-- is opened by exactly ONE append (plan_opened) projecting into exactly ONE table
-- (plans), so the partial unique index on plans(room_id, cause_message_id) IS the
-- honest spelling of "at most one plan per cause" — there is no second append for
-- it to miss.
--
-- WHERE cause_message_id IS NOT NULL: a hand-opened plan cites nothing (0047's
-- named case) and stays free — many boards, no cause, no collision. Postgres
-- treats NULLs as distinct in a unique index anyway; the explicit predicate makes
-- the "routed plans only" scope legible rather than incidental, and matches the
-- partial-index house style (sessions_execution_claim_idx, session_subscriptions).
--
-- Append-only: 0047 is untouched; this is a CREATE and a COMMENT refinement.
-- public.-qualified throughout, per the hardened search_path the house style has
-- assumed since 0043.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX "plans_room_cause_routed_key"
  ON "public"."plans" ("room_id", "cause_message_id")
  WHERE "cause_message_id" IS NOT NULL;--> statement-breakpoint

COMMENT ON INDEX "public"."plans_room_cause_routed_key" IS
  'AT MOST ONE PLAN PER ROUTED CAUSE (#148 FIX 1). The board-level analogue of funded_arms_room_cause_pk: a durable routing daemon opens a plan by sending open_plan then journaling the request, and a crash between them replays the goal and re-sends open_plan — this refuses the re-send so exactly one board is opened per cause across any crash seam. commands.ts asks the same question first (requirePlanCauseUnclaimed) and gives the legible refusal; this is the authority, and it binds a writer that never passed the command. PARTIAL on cause_message_id IS NOT NULL: a hand-opened plan cites nothing and stays free. DISTINCT from funded_arms: a plan takes no draw claim (a plan is not a draw); this is a plan claim.';--> statement-breakpoint

COMMENT ON COLUMN "plans"."cause_message_id" IS
  'THE NEW-WORK ARM''s board provenance (#128, #124 resolution 3), and the key for the board-level plan claim (#148 FIX 1). Nullable — the resolution names the hand-opened plan outright, and a null cause stays free. A PLAN NEVER DRAWS (#124 resolution 2): it takes NO funded_arms claim, and that spend exemption stands. But a non-null cause is bound by plans_room_cause_routed_key to at most one plan per (room, cause), so a daemon crash-replay re-send of open_plan cannot open an orphaned second board. Same-room by plans_cause_same_room_fk, and by atrium_core_events_routing_cause_same_room one layer up on the ledger row itself.';
