-- ═════════════════════════════════════════════════════════════════════════════
-- A SESSION MAY DRAFT A READING. IT STILL MAY NOT CERTIFY ONE.
--
-- ## The sentence this migration retires
--
-- Since 0000 the proposer vocabulary has been two values:
--
--   > proposer_kind ∈ {model, human}
--
-- and the identity check beside it, `proposals_proposer_identified`, has admitted
-- exactly two shapes: a `model` proposer names a model string, a `human`
-- proposer names a user. 0017 restated, deliberately, that it was NOT touching
-- this — "a proposal's proposer decides whether the acceptance engine demands a
-- receipt window and whether θ applies, and those are acceptance-semantics
-- questions this migration does not answer" — and `apps/server`'s
-- `draftToProposal` refused an agent session outright rather than record its
-- reading as a person's.
--
-- #117 answers those questions, and the answer is the one that keeps the
-- covenant whole: an `agent` proposer is a MACHINE proposer. It takes the model
-- path in `@atrium/core` — the receipt window is checked against the messages it
-- cites, θ applies, a commitment naming somebody else waits for that person —
-- because "who staged the reading" is a person-or-machine question and an agent
-- is a machine. The widening is of WHO may STAGE a `~`, and of nothing else: an
-- agent still hits every `isHuman` certification gate exactly as a model does,
-- so a machine drafts `~` and only a human certifies `✓`, unchanged.
--
-- ## The two edits, and why they are the whole file
--
--  1. `proposer_kind` grows the value `'agent'`.
--  2. `proposals_proposer_identified` grows one arm: an `agent` proposal is
--     admitted when it carries a `proposer_user_id` (its own agent-kind `users`
--     row), the same shape a `human` proposal is admitted by. The two existing
--     arms are reproduced verbatim so a reader diffing against 0000 sees exactly
--     one arm added.
--
-- ## `ALTER TYPE … ADD VALUE` inside the migration transaction
--
-- Drizzle's migrator runs every pending migration in one transaction. Postgres
-- 12+ permits `ALTER TYPE … ADD VALUE` there but refuses to *resolve* the new
-- label in the same transaction. The re-added CHECK below therefore compares
-- `proposer_kind::text = 'agent'` rather than `proposer_kind = 'agent'`: the
-- `::text` cast resolves no enum label, so the constraint can be created in the
-- same transaction that added the value. This is the same `::text` discipline
-- 0017 used for the identical reason; written that way on purpose, not by luck.
-- The `@atrium/db/schema` mirror of this CHECK is free to use the enum
-- comparison — it is drift-reference, never applied in the add-value transaction.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TYPE "public"."proposer_kind" ADD VALUE IF NOT EXISTS 'agent' AFTER 'human';--> statement-breakpoint

ALTER TABLE "proposals" DROP CONSTRAINT "proposals_proposer_identified";--> statement-breakpoint

ALTER TABLE "proposals" ADD CONSTRAINT "proposals_proposer_identified" CHECK ((("proposals"."proposer_kind"::text = 'model' AND "proposals"."proposer_model" IS NOT NULL)
          OR ("proposals"."proposer_kind"::text = 'human' AND "proposals"."proposer_user_id" IS NOT NULL)
          OR ("proposals"."proposer_kind"::text = 'agent' AND "proposals"."proposer_user_id" IS NOT NULL)));--> statement-breakpoint

COMMENT ON CONSTRAINT "proposals_proposer_identified" ON "proposals" IS
  'Every proposal names who staged it in a shape that can be checked: a model proposal carries a model string, a human proposal carries a user id, an agent proposal carries a user id (its own agent-kind users row). The agent arm is #117 — an agent is a MACHINE proposer that takes the model acceptance path, so widening this admits WHO may stage a ~ and touches no certification gate; a machine still drafts ~ and only a human certifies ✓. Compares proposer_kind::text so the agent label added in the same transaction is not resolved at apply time.';
