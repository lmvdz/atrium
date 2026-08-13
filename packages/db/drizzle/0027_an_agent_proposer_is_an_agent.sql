-- ═════════════════════════════════════════════════════════════════════════════
-- AN AGENT PROPOSER NAMES AN AGENT — THE HALF THE CHECK CANNOT STATE.
--
-- #117 fix round 2, from the blind dual-lineage gauntlet (F5, both foreign
-- lineages converged). 0026 widened `proposer_kind` with `'agent'` and grew the
-- `proposals_proposer_identified` CHECK one arm:
--
--   > (proposer_kind = 'agent' AND proposer_user_id IS NOT NULL)
--
-- and its COMMENT claims the agent arm carries "a user id (its own agent-kind
-- users row)". The CHECK proves only the first half of that sentence. A CHECK
-- constraint sees one row of one table; it cannot look across to `users` to
-- learn whether `proposer_user_id` names a `principal_kind='agent'` identity. So
--
--   INSERT INTO proposals (proposer_kind, proposer_user_id, …)
--   VALUES ('agent', '<a HUMAN uuid>', …)
--
-- satisfies the CHECK — the id is NOT NULL — while naming a person as the agent
-- that staged the reading. That is a dishonest attribution, not a self-certify
-- path (0018 already refuses an `actor_kind`/`principal_kind` mismatch on the
-- append side, so an agent-dressed reading still hits every certification gate as
-- a machine's does, and only a human certifies `✓`). But the constraint must do
-- what its comment says: an agent proposal must name an agent.
--
-- ## The mechanism, and why it is a trigger and not a foreign key
--
-- Exactly the shape 0021's `agents_user_is_agent` and 0024's
-- `rooms_agent_user_is_agent` use, for the same reason: this is the reciprocal
-- half a foreign key cannot state. `proposer_user_id` already REFERENCES
-- `users(id)` (ON DELETE SET NULL), so the id names a real identity — but a
-- foreign key cannot condition on the *kind* of the referenced row, and only the
-- `'agent'` arm is constrained (a `'human'` proposer names a human, a `'model'`
-- proposer names no user at all). A BEFORE INSERT OR UPDATE trigger reads
-- `users.principal_kind`, fires only for the agent arm, and refuses the row when
-- the named identity is missing or is not an agent. It fires for the whole life
-- of the row (INSERT and UPDATE of either column), takes no row lock
-- (`principal_kind` is immutable — `users_principal_kind_immutable`, 0017 §2, so
-- there is no UPDATE to race), and fails closed.
--
-- ## `proposer_kind::text` inside the trigger body
--
-- Drizzle's migrator runs every pending migration in ONE transaction, so this
-- migration can share a transaction with 0026's `ALTER TYPE … ADD VALUE 'agent'`
-- on a fresh database. Postgres refuses to resolve a newly-added enum label in
-- the transaction that added it. The guard compares `NEW."proposer_kind"::text =
-- 'agent'` for the same reason 0026's re-added CHECK did: the `::text` cast
-- resolves no enum label, so the trigger is safe to create in that shared
-- transaction. Same `::text` discipline, same reason, on purpose.
--
-- The trigger has no `@atrium/db/schema` mirror, exactly as 0021's and 0024's
-- do not: a plpgsql trigger is not a drizzle-representable object. It lives in
-- the migration, and the schema-parity suite holds the CHECK it completes.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "atrium_proposals_agent_proposer_is_agent"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $proposals_agent_is_agent$
DECLARE
  v_kind text;
BEGIN
  IF NEW."proposer_kind"::text <> 'agent' THEN
    RETURN NEW;
  END IF;
  SELECT u."principal_kind"::text INTO v_kind
  FROM public."users" u WHERE u."id" = NEW."proposer_user_id";
  IF v_kind IS NULL THEN
    RAISE EXCEPTION
      'proposal %: proposer_user_id "%" is not an identity in this database, but an agent proposal must name its own agent-kind users row', NEW."id", NEW."proposer_user_id"
      USING ERRCODE = '23514', CONSTRAINT = 'proposals_agent_proposer_is_agent';
  END IF;
  IF v_kind <> 'agent' THEN
    RAISE EXCEPTION
      'proposal %: proposer_user_id "%" is a % principal, but an agent proposal must name an agent identity — a machine drafts ~ as itself, and dressing a person''s uuid as the agent that staged the reading is the dishonest attribution this refuses', NEW."id", NEW."proposer_user_id", v_kind
      USING ERRCODE = '23514', CONSTRAINT = 'proposals_agent_proposer_is_agent';
  END IF;
  RETURN NEW;
END;
$proposals_agent_is_agent$;--> statement-breakpoint

CREATE TRIGGER "proposals_agent_proposer_is_agent"
  BEFORE INSERT OR UPDATE ON "proposals"
  FOR EACH ROW EXECUTE FUNCTION "atrium_proposals_agent_proposer_is_agent"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_proposals_agent_proposer_is_agent"() IS
  'Refuses any proposals row with proposer_kind=agent whose proposer_user_id names a users row that is not principal_kind=agent (#117 fix r2, F5). The half proposals_proposer_identified cannot state: a CHECK proves proposer_user_id IS NOT NULL but cannot cross to users.principal_kind, so an agent proposal could name a human uuid and read as its own agent-kind row when it is not. Mirrors 0021 agents_user_is_agent and 0024 rooms_agent_user_is_agent. Fires BEFORE INSERT OR UPDATE for the agent arm only. Compares proposer_kind::text so the agent label 0026 added is safe to reference in a shared migration transaction. No row lock — principal_kind is immutable (0017). Does not bind an operator who disables triggers.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## The rows already here — the half a BEFORE-INSERT trigger cannot reach.
--
-- #117 gauntlet leftover (F5), folded in by #118. The trigger above guards every
-- FUTURE write, but a trigger validates nothing about rows that predate it. On
-- this branch 0026 (proposer_kind gains 'agent') and 0027 co-ship, so no `agent`
-- proposal can exist yet and this passes trivially — but making the invariant a
-- one-time assertion over ALL existing rows, not only future ones, is what makes
-- it hold over the whole table rather than the tail of it. The same LEFT JOIN
-- shape mirrors the trigger's two refusal branches (a missing identity, or a
-- non-agent one), and the same `::text` discipline keeps the newly-added 'agent'
-- label safe to reference inside the migrator's single transaction.
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
      'proposal %: proposer_kind=agent names a % — an agent proposal must name its own agent-kind users row. The trigger guards future writes; this one-time check refuses the rows already here (#117 F5).', v_bad, v_kind
      USING ERRCODE = '23514', CONSTRAINT = 'proposals_agent_proposer_is_agent';
  END IF;
END $$;
