-- ═════════════════════════════════════════════════════════════════════════════
-- THE READ MODEL NAMES WHO CERTIFIED, SO THE RENDERED ✓ IS THE ENFORCED ONE.
--
-- The covenant (init.md §5, and @atrium/core's `epistemic.ts`) has exactly one
-- certification predicate:
--
--   confirmed  ==  isHuman(acceptedBy) || humanTouchedAt !== null
--
-- and until now no product code read it. `epistemicStateOf` was called by one
-- file in the repository — its own test. The `✓` a user saw came instead from
-- `apps/web/lib/replay-view.ts`, which derived a `verification` from *row
-- existence*: an `accepted_objects` row rendered `✓` whether a person or a
-- machine accepted it. Two predicates, and the enforced one was unobservable.
-- They agreed only by the accident that `modelMintingGate` restricts a machine
-- to the two types whose UI branches did not read `accepted`.
--
-- The reason the read model could not answer "did a person certify this" is that
-- it had thrown away the two facts the predicate needs. `accepted_by` is a plain
-- `users` FK written by `humanId(actor)` — NULL for a model, and, since 0017,
-- ALSO a real uuid for an `agent`, which is a non-human that carries an
-- identity. So `accepted_by IS NOT NULL` is not `isHuman`; it never was, and
-- after 0017 it is provably not. And `human_touched_at` — the field a human
-- CORRECTION moves to promote `~`→`✓` — had no column at all, no wire field, no
-- consumer outside `packages/core`. A regression that certified a machine's
-- reading was invisible everywhere a person could see.
--
-- This migration projects both. `apps/server/src/projections.ts` now writes
-- `accepted_by_kind` (from `ObjectRecord.acceptedBy.kind`) and `human_touched_at`
-- (from `ObjectRecord.humanTouchedAt`) on `object_accepted` AND on
-- `object_corrected`, and `replay-view.ts` derives its `verification` from
-- `epistemicStateOf` — the SAME function the reducer's supersession gate reads —
-- via `epistemicStateFromAcceptance`. The second answer is deleted, not tested.
--
-- ## Why `accepted_by_kind` is NOT NULL and `human_touched_at` is nullable
--
-- Every accepted row has an accepter, and its KIND is the thing that decides the
-- glyph; a nullable kind would be a row the predicate cannot read, which is a
-- machine's reading free to render as a fact the day a projection forgets the
-- column. So it is NOT NULL, and the enum is `actor_kind` — the same enum
-- `_ActorKindParity` pins to @atrium/core's `Actor['kind']`, so a kind the union
-- gains is a kind this column can hold, both directions.
--
-- `human_touched_at` is genuinely absent while an object is only a machine's
-- reading — that IS the `~` state — so its column is nullable, exactly as
-- `ObjectRecord.humanTouchedAt` is `Timestamp | null`.
--
-- ## The backfill, and why it is the honest one for the rows that exist
--
-- New columns need a value for rows already on disk. The fold that produced
-- those rows is gone, so the backfill reconstructs the two facts from what the
-- old projection *did* keep:
--
--   * `accepted_by_kind` — a row with a non-null `accepted_by` was written by
--     `humanId(actor)`, which returned an id ONLY for a `human` (an `agent`
--     could not accept before 0017 landed, and no accepted row predates it), so
--     that row was human-accepted. A null `accepted_by` on an accepted object is
--     a `model` acceptance — the only other accepter of an object. `system`
--     never accepts an object, so it is not a case here.
--   * `human_touched_at` — a human acceptance set it to the acceptance instant,
--     which is `created_at`; and a human CORRECTION set it to the correction
--     instant, which is the earliest human correction this object carries. Both
--     are recovered below; a model-accepted object never touched by a person
--     stays NULL, which is `~`.
--
-- This is a one-time reconstruction of historical rows and says nothing about
-- new writes: those come from the projection, which reads the fold directly. A
-- fresh database (every integration run) has no rows here and the backfill is
-- inert.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. accepted_by_kind — NOT NULL, defaulting to the fail-closed 'model'
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Added NOT NULL DEFAULT 'model' in one step: existing rows take 'model' (`~`),
-- the fail-closed value, and the human-accepted ones are corrected to 'human'
-- immediately below. The default is not a convenience — see the column COMMENT:
-- the projection always writes this, so the default is reached only by a writer
-- that forgot who accepted, and the safe answer there is "a machine did".
ALTER TABLE "accepted_objects"
  ADD COLUMN "accepted_by_kind" "actor_kind" NOT NULL DEFAULT 'model';--> statement-breakpoint

-- A row with a non-null `accepted_by` was written by `humanId(actor)`, which
-- returned an id ONLY for a `human` (an `agent` could not accept before 0017,
-- and no accepted row predates it). So it was human-accepted.
UPDATE "accepted_objects"
SET "accepted_by_kind" = 'human'::"actor_kind"
WHERE "accepted_by" IS NOT NULL;--> statement-breakpoint

COMMENT ON COLUMN "accepted_objects"."accepted_by_kind" IS
  'The kind of the actor that accepted this object, projected from the fold''s ObjectRecord.acceptedBy.kind. The read model''s half of @atrium/core''s one certification predicate epistemicStateOf = isHuman(acceptedBy) || humanTouchedAt !== null: accepted_by alone cannot answer isHuman because an agent (0017) also carries a users id, so the KIND is projected. NOT NULL — every accepted row has an accepter kind, and a null would let a forgotten projection render a machine''s reading as a fact. Pinned to Actor[''kind''] by _ActorKindParity. Read by replay-view.ts via epistemicStateFromAcceptance so the rendered ✓ and the reducer''s gate are one function (#98/H5/H6).';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. human_touched_at — nullable, backfilled from acceptances and corrections
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "accepted_objects" ADD COLUMN "human_touched_at" timestamptz;--> statement-breakpoint

-- A human acceptance set humanTouchedAt to the acceptance instant (created_at).
UPDATE "accepted_objects"
SET "human_touched_at" = "created_at"
WHERE "accepted_by" IS NOT NULL
  AND "human_touched_at" IS NULL;--> statement-breakpoint

-- A human correction of a machine-accepted object promoted it: the touch is the
-- earliest human correction this object carries. `by_user_id` is written by
-- `humanId(actor)`, so a non-null value is a human's correction.
UPDATE "accepted_objects" a
SET "human_touched_at" = c."first_touch"
FROM (
  SELECT "object_id", min("created_at") AS "first_touch"
  FROM "corrections"
  WHERE "by_user_id" IS NOT NULL
  GROUP BY "object_id"
) c
WHERE a."id" = c."object_id"
  AND a."human_touched_at" IS NULL;--> statement-breakpoint

COMMENT ON COLUMN "accepted_objects"."human_touched_at" IS
  'When a human first touched this object — accepted it, or corrected it afterwards — or NULL while it is still only a machine''s reading (that IS the ~ state, so the column is nullable, as ObjectRecord.humanTouchedAt is Timestamp | null). The second half of epistemicStateOf, projected from the fold on object_accepted AND object_corrected: a person''s correction promotes ~→✓, so the correction projection moves this too. Backfilled from acceptance instants and the earliest human correction per object (#98/H5).';
