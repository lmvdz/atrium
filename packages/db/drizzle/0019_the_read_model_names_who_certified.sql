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
-- ## The backfill reads the IMMUTABLE LEDGER, not the nullable attribution FKs
--
-- New columns need a value for rows already on disk. The fold that produced them
-- is gone, so the backfill reconstructs the two facts — but from `core_events`,
-- the append-only spine, NOT from `accepted_objects.accepted_by` or
-- `corrections.by_user_id`.
--
-- Those two columns are the wrong source, and a blind critic (#98 r2, finding 4)
-- named exactly why: BOTH are `ON DELETE SET NULL`. A human accepted an object,
-- their user row was later deleted, and `accepted_by` is now NULL — so a backfill
-- keyed on `accepted_by IS NOT NULL` reads that historical `✓` as a `model`
-- acceptance and renders it `~`. The covenant would be quietly downgraded by an
-- unrelated account deletion. `corrections.by_user_id` fails the same way for the
-- promotion-by-correction half.
--
-- `core_events.actor_kind` cannot be nulled: it is a NOT NULL column on the
-- append-only log (0003's trigger forbids UPDATE/DELETE), written from the
-- trusted actor at append and never a foreign key to a row that can vanish. It
-- is the SAME `actor_kind` every acceptance gate read to decide the write in the
-- first place. So the backfill matches each `accepted_objects` row to the
-- `object_accepted` event that minted it and takes THAT event's `actor_kind`:
--
--   * `accepted_by_kind` — the accepting event's `actor_kind` verbatim (`human`,
--     `agent`, `model`, or `system`), so an agent acceptance (0017) is recorded
--     as `agent` rather than mis-read as `human` from a surviving `accepted_by`
--     uuid. `epistemicStateFromAcceptance` then treats only `human` as `✓` via
--     `isHuman`, exactly as the live projection does off `ObjectRecord.acceptedBy.kind`.
--   * `human_touched_at` — the acceptance instant (`created_at`) when the
--     accepting event was a HUMAN's; plus the earliest human correction that
--     ACTUALLY APPLIED, at its immutable `occurred_at`. "Applied" is the load-
--     bearing word: the reducer appends an `object_corrected` event even when it
--     REFUSES or NO-OPS the correction (an empty `patch:{}` changes nothing), and
--     a refused touch must not promote a machine's `~` to `✓`. The runtime
--     projection filters exactly these — it writes only when the fold moved the
--     object — and the `corrections` table is where that write lands, so a
--     `corrections` row is the apply signal the raw ledger event is not. The
--     backfill joins it, and still reads the actor's kind and the touch instant
--     from the immutable ledger, never from `corrections.by_user_id`. A model-
--     accepted object no person ever *effectively* touched stays NULL, which is
--     `~`.
--
-- This is a one-time reconstruction of historical rows and says nothing about new
-- writes: those come from the projection, which reads the fold directly. A fresh
-- database (every integration run) has no rows here and the backfill is inert.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. accepted_by_kind — NOT NULL, defaulting to the fail-closed 'model'
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Added NOT NULL DEFAULT 'model' in one step: existing rows take 'model' (`~`),
-- the fail-closed value, and every row whose minting event survives on the
-- ledger is corrected to that event's real `actor_kind` immediately below. The
-- default is reached only by a row with no `object_accepted` event to match
-- (there are none — every accepted row came from one) or by a future writer that
-- forgot who accepted, and the safe answer there is "a machine did".
ALTER TABLE "accepted_objects"
  ADD COLUMN "accepted_by_kind" "actor_kind" NOT NULL DEFAULT 'model';--> statement-breakpoint

-- The second predicate column, nullable, added HERE (before the backfill) because
-- the acceptance UPDATE below now sets BOTH columns from the one applied event —
-- kind and touch in a single write, so they cannot disagree about who accepted.
-- Its own section-2 header and full COMMENT are below, next to the correction
-- half of its backfill.
ALTER TABLE "accepted_objects" ADD COLUMN "human_touched_at" timestamptz;--> statement-breakpoint

-- The accepter's kind AND the human-acceptance touch both come from the ONE
-- acceptance that ACTUALLY APPLIED — never from a refused duplicate.
--
-- "Applied" is the load-bearing word, exactly as it is for the correction half
-- below. The reducer folds `object_accepted` events in `(occurred_at, id)` order
-- and refuses every one after the FIRST for an object id — `applyObjectAccepted`
-- returns `already accepted` (reduce.ts). So exactly ONE `object_accepted` event
-- per object ever applied (the earliest), and a LATER human `object_accepted`
-- for a model-accepted object — the fold rejects it as a duplicate, but it still
-- sits on the append-only ledger — must not certify anything. The old backfill
-- keyed on ANY matching event: it saw that refused human duplicate, read its
-- `human` kind, and promoted a machine's `~` to `✓` in history (#98 r3/r4, the
-- acceptance-side twin of the correction over-promotion r3 fixed).
--
-- This picks the single applied acceptance per object with `DISTINCT ON` in the
-- same order the reducer folds (`occurred_at`, then `id`), room-scoped, and reads
-- BOTH columns from it: the kind verbatim (so `agent` (0017) is `agent`, not a
-- `human` mis-read from a surviving `accepted_by` uuid), and — when that one
-- applied event was a HUMAN's — the touch instant from its immutable
-- `occurred_at`. A model-accepted object with a refused human duplicate keeps
-- `accepted_by_kind = 'model'` and `human_touched_at = NULL`: it stays `~`.
UPDATE "accepted_objects" a
SET "accepted_by_kind" = e."actor_kind",
    "human_touched_at" = CASE WHEN e."actor_kind" = 'human' THEN e."occurred_at" ELSE NULL END
FROM (
  SELECT DISTINCT ON (ev."room_id", ev."payload" -> 'object' ->> 'id')
         ev."room_id",
         (ev."payload" -> 'object' ->> 'id') AS "object_id",
         ev."actor_kind",
         ev."occurred_at"
  FROM "core_events" ev
  WHERE ev."type" = 'object_accepted'
  ORDER BY ev."room_id", ev."payload" -> 'object' ->> 'id', ev."occurred_at", ev."id"
) e
WHERE e."room_id" = a."room_id"
  AND e."object_id" = a."id"::text;--> statement-breakpoint

COMMENT ON COLUMN "accepted_objects"."accepted_by_kind" IS
  'The kind of the actor that accepted this object, projected from the fold''s ObjectRecord.acceptedBy.kind. The read model''s half of @atrium/core''s one certification predicate epistemicStateOf = isHuman(acceptedBy) || humanTouchedAt !== null: accepted_by alone cannot answer isHuman because an agent (0017) also carries a users id, so the KIND is projected. NOT NULL — every accepted row has an accepter kind, and a null would let a forgotten projection render a machine''s reading as a fact. Pinned to Actor[''kind''] by _ActorKindParity. Read by replay-view.ts via epistemicStateFromAcceptance so the rendered ✓ and the reducer''s gate are one function (#98/H5/H6). Backfilled from the single APPLIED object_accepted event (the earliest per object; the reducer refuses later duplicates), so a refused human re-acceptance never certifies a machine''s reading (#98 r4).';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. human_touched_at — nullable, backfilled from acceptances and corrections
-- ─────────────────────────────────────────────────────────────────────────────
-- The column was added at the top and the ACCEPTANCE half of its backfill already
-- ran above, from the same single applied event that set `accepted_by_kind`, so
-- the two halves of the predicate can never disagree about who accepted. What
-- remains here is the CORRECTION-promotion half.

-- A human correction of a machine-accepted object promoted it — but ONLY a
-- correction that ACTUALLY APPLIED. The reducer appends an `object_corrected`
-- event even when it refuses or no-ops the correction (an empty `patch:{}`
-- changes nothing), so keying the promotion on the raw event would mint a `✓`
-- from a touch a person only *attempted*. The runtime projection writes a
-- `corrections` row only when the fold moved the object, so that table — not the
-- ledger event — is the apply signal, and this backfill JOINs it to count applied
-- corrections only. Actor kind and the touch instant still come from the immutable
-- ledger (`core_events.actor_kind`, `occurred_at`), never `corrections.by_user_id`,
-- which a later account deletion nulls. The touch is the earliest applied human
-- correction.
UPDATE "accepted_objects" a
SET "human_touched_at" = c."first_touch"
FROM (
  SELECT cor."room_id", cor."object_id",
         min(e."occurred_at") AS "first_touch"
  FROM "corrections" cor
  JOIN "core_events" e ON e."id" = cor."event_id"
  WHERE e."type" = 'object_corrected' AND e."actor_kind" = 'human'
  GROUP BY cor."room_id", cor."object_id"
) c
WHERE a."room_id" = c."room_id"
  AND a."id" = c."object_id"
  AND a."human_touched_at" IS NULL;--> statement-breakpoint

COMMENT ON COLUMN "accepted_objects"."human_touched_at" IS
  'When a human first touched this object — accepted it, or corrected it afterwards — or NULL while it is still only a machine''s reading (that IS the ~ state, so the column is nullable, as ObjectRecord.humanTouchedAt is Timestamp | null). The second half of epistemicStateOf, projected from the fold on object_accepted AND object_corrected: a person''s correction promotes ~→✓, so the correction projection moves this too. Backfilled from acceptance instants and the earliest human correction that ACTUALLY APPLIED per object — joined through the corrections table (written only on apply), because the reducer appends an object_corrected event even for a refused or no-op (patch:{}) correction, and a refused touch must not promote a ~ (#98/H5, #98 r2/H1).';
