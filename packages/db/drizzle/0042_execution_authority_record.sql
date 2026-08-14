-- ═════════════════════════════════════════════════════════════════════════════
-- EXECUTION-AUTHORITY RECORD — a granted draw is BORN with determinate authority.
--
-- #120 round-6 design consolidation. Round 5 closed each execution finding with a
-- separate mechanism, and the seams between them became the round-5 defect cluster
-- both foreign lineages converged on. The campaign-stopping one (F1): the draw
-- committed in the `session_opened` transaction, then `runGranted` claimed the
-- lease SEPARATELY — a kill between the two left a session `open`, its draw spent,
-- with NO lease. Reconciliation only touches leased sessions, so the wedge was
-- never recovered: spent, unleased, never-reconciled.
--
-- The fix is to write the session's whole execution authority IN the same append
-- transaction as `session_opened` (`projectSessionOpened`). These columns hold it:
--
--   * `execution_mode` — `provider` (a wired ExecutionProvider owns this session's
--     execution AND its terminal) or `external` (no provider this boot; an outside
--     member settles it — the documented external-settle mode). Decided at grant,
--     carried in the `session_opened` event so replay is deterministic. NULL only
--     for rows opened before this migration — read as `external` (unleased, owner
--     check governs their settle), which is what they already behaved as.
--   * `execution_authority` — the unforgeable settlement CAPABILITY for a
--     `provider` session, minted at grant. It authorizes writing the session's
--     terminal (settled OR failed): `settle_session` of a provider session is
--     refused unless the caller presents this exact token. ROW-ONLY by design —
--     never in the ledger event, never on the wire — so a room member (the opener
--     included) never sees it and cannot forge either outcome. The coordinator
--     obtains it from `claim`; the reconciler reads it off the row; neither is the
--     wire. NULL for an `external` session, which needs no token.
--   * `execution_claimed_at` — NULL while a granted provider session is unclaimed,
--     set exactly ONCE when the coordinator claims it (`unclaimed → running`). The
--     claim's guarded UPDATE keys on this being NULL, so a re-entrant claim of an
--     already-running session matches zero rows.
--
-- The lease columns from 0032 (`execution_owner`, `execution_heartbeat_at`) are
-- now stamped AT GRANT for a provider session, not at claim — so a granted-but-
-- never-claimed provider session already has a lease and is reconcilable the
-- moment its granting process dies. That is the whole of the F1 fix.
--
-- All THREE are process-liveness / capability bookkeeping, NOT covenant state, and
-- never read to flip a `~` to a `✓`. `sessions_terminal_immutable` (0025) freezes
-- only a terminal row's status and receipt columns; every write here is at grant
-- (an insert) or scoped to `status = 'open'` (the claim), so none presents an
-- UPDATE to a terminal row.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "sessions" ADD COLUMN "execution_mode" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "execution_authority" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "execution_claimed_at" timestamp with time zone;--> statement-breakpoint

-- A provider session is claimable exactly once. The partial index makes the
-- claim's `WHERE ... execution_claimed_at IS NULL AND execution_mode = 'provider'`
-- guard a cheap lookup and documents the unclaimed-provider set as the hot path.
CREATE INDEX "sessions_execution_claim_idx"
  ON "sessions" USING btree ("execution_mode","execution_claimed_at")
  WHERE "status" = 'open';--> statement-breakpoint

COMMENT ON COLUMN "sessions"."execution_mode" IS
  'Execution-authority record (#120 r6). `provider` = a wired ExecutionProvider owns this session''s execution and its terminal; `external` = no provider this boot, an outside member settles it (external-settle mode). Written in the session_opened transaction. NULL for pre-migration rows, read as external.';--> statement-breakpoint

COMMENT ON COLUMN "sessions"."execution_authority" IS
  'Execution-authority record (#120 r6), capability bookkeeping NOT covenant state. The unforgeable token that authorizes writing a provider session''s terminal (settled OR failed). Minted at grant, ROW-ONLY (never in the event or on the wire); held by the coordinator (via claim) and the reconciler (via row read), never a wire client. NULL for an external session.';--> statement-breakpoint

COMMENT ON COLUMN "sessions"."execution_claimed_at" IS
  'Execution-authority record (#120 r6). NULL while a granted provider session is unclaimed; set exactly once when the coordinator claims it (unclaimed → running). The claim keys on this being NULL, so a re-entrant claim matches zero rows.';
