-- ═════════════════════════════════════════════════════════════════════════════
-- 0010 — the read model names who staged the reading, not just what it claims
--
-- #22 gauntlet r9, defect 1. As an ordinary `member`, over one socket, two
-- commands: `record_proposal` with `proposer: {kind:'model', model:'…'}`,
-- `confidence: 1`, a `commitment` payload owned by a colleague, and a `quote`
-- that appears in no cited message — then `accept_proposal` on it. Both acked,
-- `issues: []`, and out came a durable `accepted_objects` row committing the
-- colleague, beside a `proposals` row reading `proposer_kind='model'`,
-- `proposer_model='claude-opus-4.6'`, `confidence=1`.
--
-- The refusal that closes it lives in `@atrium/core` (`selfStagedReadingRefusal`)
-- and in the command layer, which no longer lets a socket choose `proposer` at
-- all. This migration is the fact both of those need and the fact every *reader*
-- needed and did not have:
--
-- > `proposer_kind` / `proposer_model` say what the reading **claims to be**.
-- > Nothing said who **typed it**.
--
-- The `core_events` row always knew — its `actor_kind`/`actor_id` are derived
-- from the authenticated session and cannot be written by a caller. But that is
-- the log. The projection is what the product reads, and in the projection the
-- only marking that survived was the one the attacker picked. Two columns, and
-- the answer stops depending on replaying the ledger by hand.
--
--  * `staged_by_kind` / `staged_by_id` — shaped like `core_events.actor_kind` and
--    `actor_id`, not like `proposer_*`, because the stager is an `Actor` and has a
--    `system` variant `proposer_kind` has no spelling for. `staged_by_id` is the
--    user id for a human and the model id for a model, under the same check
--    constraint `core_events` uses. Not an FK, for the same reason `actor_id` is
--    not one: the column is polymorphic, and "who staged this attribution" is a
--    fact about an append rather than a live pointer.
--  * `quote` — the span the attribution is computed from. `proposal_sources`
--    carried the citation list; nothing carried the sentence, so a `~` could not
--    be checked by eye against the message it named.
--
-- ## Backfill
--
-- Every existing proposal's real stager is in its own `proposal_recorded` row.
-- The backfill reads it from there rather than inventing one — same principle as
-- 0006's heal: derive from the row, never from a default. A proposal with no
-- surviving ledger row (only possible if `core_events` was truncated under it)
-- falls back to its recorded proposer, which is the most that can honestly be
-- said about it. On a fresh database both statements touch nothing.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "proposals" ADD COLUMN "staged_by_kind" "actor_kind";--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "staged_by_id" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "quote" text;--> statement-breakpoint

UPDATE "proposals" p
   SET "staged_by_kind" = e."actor_kind",
       "staged_by_id"   = e."actor_id",
       "quote"          = e."payload"->'proposal'->>'quote'
  FROM "core_events" e
 WHERE e."payload"->>'type' = 'proposal_recorded'
   AND e."payload"->'proposal'->>'id' = p."id"::text;--> statement-breakpoint

-- No ledger row to read: say what the proposer column says and no more. `::text`
-- through the cast because `proposer_kind` and `actor_kind` are different enums
-- that happen to share two labels.
UPDATE "proposals"
   SET "staged_by_kind" = "proposer_kind"::text::"actor_kind",
       "staged_by_id"   = coalesce("proposer_user_id"::text, "proposer_model")
 WHERE "staged_by_kind" IS NULL;--> statement-breakpoint

ALTER TABLE "proposals" ALTER COLUMN "staged_by_kind" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "proposals" ADD CONSTRAINT "proposals_staged_by_id_matches_kind"
  CHECK (("staged_by_kind" = 'system') = ("staged_by_id" IS NULL));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_staged_by_id_not_blank"
  CHECK ("staged_by_id" IS NULL OR length("staged_by_id") > 0);--> statement-breakpoint

CREATE INDEX "proposals_staged_by_idx" ON "proposals" ("staged_by_kind", "staged_by_id");--> statement-breakpoint

COMMENT ON COLUMN "proposals"."staged_by_kind" IS
  'Who typed this proposal, from the ledger row''s trusted actor — as against proposer_kind/proposer_model, which is what the reading claims to be. #22 r9 D1: a member staged a machine-attributed commitment against a colleague and the read model could only repeat the marking he chose.';--> statement-breakpoint
COMMENT ON COLUMN "proposals"."quote" IS
  'The verbatim span of a cited message the reading rests on. Every attribution rule is computed from it; proposal_sources carries the citation list and this carries the sentence.';
