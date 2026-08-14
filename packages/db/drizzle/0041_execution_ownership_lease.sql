-- ═════════════════════════════════════════════════════════════════════════════
-- EXECUTION-OWNERSHIP LEASE — reconciliation must know WHOSE dead session it is.
--
-- #120 round-5 F4. Startup reconciliation drives every `open` session with a
-- spent draw to a terminal receipt, on the premise that an `open` session at
-- boot is a dead LOCAL execution this process's lineage owns. Round 4 gated that
-- on a single boot flag (`EXECUTION_PROVIDER` set), and the gauntlet broke it two
-- ways the flag cannot see:
--
--   * disabled→enabled: a session opened while execution was DISABLED (the
--     documented external-settle mode) is a LIVE session waiting on an outside
--     settler. Reboot with a provider set and the flag says "reconcile everything
--     open" — force-failing that live external settle and fabricating a receipt.
--   * two concurrent instances: each boot's flag is true, so each force-fails the
--     OTHER instance's still-running sessions.
--
-- The flag is a process-global proxy for a per-session fact: does a LIVE local
-- execution own THIS session? These two columns record that fact durably.
--
--   * `execution_owner` — the instance id of the process whose ExecutionProvider
--     is running the session, stamped by the coordinator when it claims the
--     session (the same write that proves the session has a committed granted
--     draw, #120 F1). NULL for a session no local execution owns — an
--     external-settle session — which reconciliation must therefore NEVER touch.
--   * `execution_heartbeat_at` — bumped on a timer while the owner runs. A lease
--     whose heartbeat has gone stale belongs to a DEAD owner and is the only kind
--     reconciliation acts on; a fresh heartbeat is a live owner (this process OR a
--     concurrent peer) and its session is left running.
--
-- Both NULLABLE and both PROCESS-LIVENESS BOOKKEEPING — not covenant state, not
-- written by the ledger projection, and never read to flip a `~` to a `✓`. The
-- session projection's exit UPDATE (`projectSessionExit`) touches neither, so a
-- lease survives the settle it precedes; reconciliation filters on `status =
-- 'open'`, so a stale lease on an already-exited row is inert.
--
-- No trigger interaction: `sessions_terminal_immutable` (0025) freezes a terminal
-- row's status and receipt columns only, and every lease write is scoped to
-- `status = 'open'`, so it never presents an UPDATE to a terminal row.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "sessions" ADD COLUMN "execution_owner" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "execution_heartbeat_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "sessions_execution_owner_idx" ON "sessions" USING btree ("status","execution_owner","execution_heartbeat_at");--> statement-breakpoint

COMMENT ON COLUMN "sessions"."execution_owner" IS
  'Process-liveness bookkeeping (#120 r5 F4), NOT covenant state. The instance id of the process whose ExecutionProvider owns this session, or NULL for a session no local execution owns (external-settle). Reconciliation reconciles only leased sessions whose owner has gone silent, and never an unleased (external-settle) session.';--> statement-breakpoint

COMMENT ON COLUMN "sessions"."execution_heartbeat_at" IS
  'Process-liveness bookkeeping (#120 r5 F4). Last heartbeat from the owning process; a stale value means a dead owner, and only those sessions are reconciled. A fresh value is a live owner (this process or a concurrent peer) whose session is left running.';
