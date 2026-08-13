-- ═════════════════════════════════════════════════════════════════════════════
-- THE ROWS ALREADY HERE — THE HALF A BEFORE-INSERT TRIGGER CANNOT REACH.
--
-- #118 fix r2, HIGH-4. The #117 F5 one-time validation — a `DO $$` block that
-- refuses any EXISTING `proposer_kind='agent'` proposal naming a non-agent
-- principal — was folded into 0027 by fix round 1. That was a mistake in
-- MIGRATION HYGIENE, not in the SQL: a database that has already run 0027 records
-- it applied by hash and NEVER re-runs it, so appending statements to an already
-- journaled migration means the appended statements run on a fresh volume and are
-- silently SKIPPED on every existing database — exactly the databases that could
-- carry the rows this check is for. 0027 is reverted to its pre-fold-in form (the
-- trigger and its comment, nothing more) and the validation lives here, as its
-- own journal entry, so every database — fresh or upgraded — runs it exactly once.
--
-- The trigger 0027 installs guards every FUTURE write; a trigger validates
-- nothing about rows that predate it. Making the invariant a one-time assertion
-- over ALL existing rows is what makes it hold over the whole table rather than
-- only its tail. On the branch that shipped 0026 (proposer_kind gains 'agent') and
-- 0027 (the trigger), no `agent` proposal can exist before this, so this passes
-- trivially there — but on any database where an `agent` proposal was written
-- between 0026 and this migration, it is the only thing that refuses a dishonest
-- one already durable.
--
-- ## The `::text` discipline, unchanged
--
-- Drizzle's migrator runs every pending migration in ONE transaction, so on a
-- fresh database this shares a transaction with 0026's `ALTER TYPE … ADD VALUE
-- 'agent'`. Postgres refuses to resolve a newly-added enum label in the
-- transaction that added it. Every comparison here is written through `::text`
-- (`proposer_kind::text = 'agent'`, `principal_kind::text <> 'agent'`), which
-- resolves no enum label, so the block is safe in that shared transaction — the
-- same discipline 0026/0027 relied on, kept for the same reason. The LEFT JOIN
-- shape mirrors the trigger's two refusal branches: a missing identity, or a
-- non-agent one.
-- ═════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_bad text;
  v_kind text;
BEGIN
  SELECT p."id"::text, coalesce(u."principal_kind"::text, '<no such identity>')
    INTO v_bad, v_kind
  FROM public."proposals" p
  LEFT JOIN public."users" u ON u."id" = p."proposer_user_id"
  WHERE p."proposer_kind"::text = 'agent'
    AND (u."id" IS NULL OR u."principal_kind"::text <> 'agent')
  LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'proposal %: proposer_kind=agent names a % — an agent proposal must name its own agent-kind users row. The trigger guards future writes; this one-time check refuses the rows already here (#117 F5, moved out of 0027 by #118 HIGH-4).', v_bad, v_kind
      USING ERRCODE = '23514', CONSTRAINT = 'proposals_agent_proposer_is_agent';
  END IF;
END $$;
