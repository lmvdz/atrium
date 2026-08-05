-- ─────────────────────────────────────────────────────────────────────────────
-- issue #22, gauntlet round 4 — the receipt's inputs become immutable, and the
-- canonical-ordering subset becomes a constraint rather than a habit.
--
-- ## 1. WHAT THIS MIGRATION IS ABOUT
--
-- **Blocking 2 of the round-3 delta.** Round 3 derived a model acceptance's
-- receipt window on both the live-append and the replay path, from one function
-- (`trustFor`/`provenanceMessageIds`) against one table, and called that
-- sameness the guarantee that live ≡ replay. The gauntlet found the guarantee is
-- not in the function:
--
--   > the bodies come from `messages` whose `authorId` is `onDelete: 'set null'`
--   > […] Delete a human author and a model `object_accepted` that folded
--   > cleanly under a real `authorId` replays with `''`, fails the receipt, and
--   > is absent from replayed state. Same derivation code, different substrate.
--
-- Exactly right, and the general form is worth stating because it outlives this
-- column: **a deterministic function of mutable inputs is not deterministic.** An
-- event-sourced system needs immutable *inputs*, not merely pure functions —
-- anything a fold validates against has to be snapshotted into the event at
-- append time, or a later mutation of the source rewrites history.
--
-- So `core_events.trusted_messages` holds exactly what the receipt validates —
-- `{id, authorId, body}` per cited message — written by the transaction that
-- assigns `room_seq`, and never read from `messages` again. The append-only
-- trigger from 0003 is what makes "never updated" structural rather than
-- intended.
--
-- The alternative the gauntlet named and ranked lower is a tombstone instead of
-- `ON DELETE SET NULL`, and it is lower for a reason: it closes this one mutation
-- and leaves the class open. An author renamed, a body edited, a message moved
-- between rooms — each reopens it. Denormalising at append closes all of them at
-- once, because after the append the fold does not consult `messages` at all.
--
-- ## 2. THE FK AUDIT THIS FINDING DEMANDS
--
-- Every `ON DELETE SET NULL` / `CASCADE` in `packages/db/src/schema.ts`, against
-- the question "does this feed a validation or a fold path?". Written here rather
-- than in a review comment because the next person to add an FK needs the rule,
-- not the verdict.
--
-- **The one that was a defect** (fixed above):
--   · `messages.author_id → users.id  ON DELETE SET NULL`
--     Fed `messageWindow` → `TrustedContext.messages` → `validateProposalProvenance`
--     and `commitmentAttribution`, which compare `authorId` against the object's
--     named owner and match a quote against `body`. Deleting a user silently
--     changed the verdict of a fold that had already happened. Now snapshotted;
--     the FK keeps `SET NULL`, and it no longer reaches a fold.
--
-- **Reads a fold or validation path, and is safe** — because the referenced row
-- is itself an input the snapshot now carries, or because nothing folds it:
--   · `messages.room_id → rooms.id CASCADE`, and every other `*.room_id →
--     rooms.id CASCADE` (memberships, core_events, proposals, accepted_objects,
--     relations, attention_items, corrections, interpretations by inheritance).
--     Deleting a room deletes its ledger in the same statement, so there is no
--     surviving fold to disagree with: the room is gone, not misremembered. This
--     is the one CASCADE that reaches `core_events` and it removes the events
--     rather than mutating them.
--   · `interpretations.message_id → messages.id CASCADE`,
--     `object_sources.*` / `proposal_sources.*` composite CASCADEs. Provenance
--     *link* tables. The reducer never reads them — it reads
--     `payload.provenance.messageIds`, which is inside the immutable payload —
--     so they are projections, and a projection that loses a row loses a join, not
--     a verdict.
--
-- **Feeds no validation and no fold** — projection columns only, read by the UI
-- and by operators, never by `reduce`:
--   · `rooms.created_by → users.id SET NULL`
--   · `proposals.proposer_user_id`, `proposals.decided_by`,
--     `accepted_objects.accepted_by`, `corrections.by_user_id`,
--     `attention_items.created_by` → `users.id SET NULL`
--     Each is written *from* the ledger row's trusted actor columns and read back
--     for display. The authority they describe lives in `core_events.actor_kind`
--     / `actor_id`, which have no FK to `users` at all — deliberately, and that is
--     why deleting a user cannot rewrite who did something.
--   · `proposals.interpretation_id → interpretations.id SET NULL` — audit
--     provenance for the model run; nothing folds it.
--
-- **The conclusion, stated as a rule for the next FK:** a column may be
-- `SET NULL`/`CASCADE` if and only if nothing downstream of `reduce` reads it.
-- Everything the reducer or a receipt check reads must be inside the event
-- payload or inside a snapshot column on the event's own row.
--
-- ## 3. THE CANONICAL-ORDERING SUBSET (round-3 delta, major 1)
--
--   > the SQL canonical gate is not the reducer's gate for all legal shapes —
--   > SQL orders `timestamptz` then `id COLLATE "C"` while the reducer does JS
--   > string comparison on `payload.at` then `id`, so `…05.000Z` vs `…05Z` […]
--   > tie in SQL and diverge in JS, and astral-plane ids compare differently in
--   > UTF-16 than in `COLLATE "C"`; production minting stays in the safe subset,
--   > so **constrain the subset rather than trusting it**.
--
-- Both halves become CHECKs below: one spelling of `at`, and printable-ASCII ids.
-- Inside that subset the SQL gate and `orderEvents` are provably the same order,
-- and `integration/db/ledger-constraints.test.ts` fuzzes the two against each
-- other across both dimensions rather than asserting it.
--
-- **Operator territory, unchanged and still out of scope.** A superuser who sets
-- `session_replication_role = replica`, or restores with
-- `pg_restore --disable-triggers`, bypasses the append-only trigger and could
-- rewrite a snapshot. That is the same admitted boundary 0004 states in its own
-- header, and this migration claims nothing beyond it.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "core_events" DROP CONSTRAINT "core_events_payload_at_has_offset";--> statement-breakpoint
ALTER TABLE "core_events" DROP CONSTRAINT "core_events_actor_id_matches_kind";--> statement-breakpoint
ALTER TABLE "core_events" DROP CONSTRAINT "core_events_actor_id_not_blank";--> statement-breakpoint
ALTER TABLE "core_events" ADD COLUMN "trusted_messages" jsonb;--> statement-breakpoint

-- Backfill, for a database that already has history.
--
-- Reconstructive, not authoritative, and the difference is worth writing down:
-- these rows folded against a window nobody recorded, and the best available
-- answer is the window their payload cites *as it stands today*. If an author was
-- already deleted, this snapshot preserves that — it does not invent a name. What
-- it buys is that from here on the substrate stops moving: the row folds the same
-- way tomorrow as it does after this statement, which is the property the whole
-- migration is for. There are no rows in a fresh database; a migration that would
-- have lost data if there had been any is a migration nobody can trust next time.
--
-- Only the rows that need one: #21's reducer demands a window for a non-human
-- `object_accepted` that cites messages, and for nothing else. Giving every other
-- row an empty array would be inventing an absence the reducer reads as a
-- refusal.
--
-- The append-only trigger from 0003 raises on any UPDATE, including this one —
-- which is the trigger doing its job. Disabled for exactly this statement and
-- re-enabled in the same transaction, visibly, rather than carving a permanent
-- exception into the trigger for a case that happens once.
ALTER TABLE "core_events" DISABLE TRIGGER "core_events_no_update";--> statement-breakpoint
UPDATE "core_events" e SET "trusted_messages" = (
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object('id', m."id"::text, 'authorId', coalesce(m."author_id"::text, ''), 'body', m."body")
      ORDER BY m."seq"
    ),
    '[]'::jsonb
  )
  FROM "messages" m
  WHERE m."id"::text IN (
    SELECT jsonb_array_elements_text(e."payload"->'object'->'provenance'->'messageIds')
  )
)
WHERE e."actor_kind" <> 'human'
  AND e."type" = 'object_accepted'
  AND jsonb_array_length(coalesce(e."payload"->'object'->'provenance'->'messageIds', '[]'::jsonb)) > 0;--> statement-breakpoint
ALTER TABLE "core_events" ENABLE TRIGGER "core_events_no_update";--> statement-breakpoint

ALTER TABLE "core_events" ADD CONSTRAINT "core_events_payload_at_is_canonical_utc" CHECK ("core_events"."payload"->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$');--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_id_is_safe_to_order" CHECK ("core_events"."id" ~ '^[!-~]+$' AND length("core_events"."id") <= 256);--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_trusted_messages_shape" CHECK ("core_events"."trusted_messages" IS NULL OR (
        jsonb_typeof("core_events"."trusted_messages") = 'array'
        AND jsonb_array_length("core_events"."trusted_messages") = jsonb_array_length(jsonb_path_query_array("core_events"."trusted_messages", '$[*] ? (@.id.type() == "string" && @.authorId.type() == "string" && @.body.type() == "string")'))
      ));--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_actor_id_matches_kind" CHECK (("core_events"."actor_kind" = 'system') = ("core_events"."actor_id" IS NULL));--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_actor_id_not_blank" CHECK ("core_events"."actor_id" IS NULL OR length("core_events"."actor_id") > 0);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 4. The append function carries the snapshot
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `p_trusted_messages` is inserted verbatim: this function is still the only way
-- a row reaches `core_events`, so the snapshot arrives by the same door as the
-- payload and the actor and is checked by the same constraints.
--
-- Replaced by DROP + CREATE rather than CREATE OR REPLACE, and the DROP is not
-- optional housekeeping. Postgres cannot change a function's parameter list in
-- place; `CREATE OR REPLACE` with a ninth parameter creates an **overload**, and
-- a same-named overload of the append function is the r2 finding — a second door
-- that satisfies every name-based guard while doing none of the work. There is
-- one `atrium_append_core_event`, and after this file there is still one.
DROP FUNCTION IF EXISTS "atrium_append_core_event"(uuid, text, "event_type", "actor_kind", text, jsonb, timestamptz, text);--> statement-breakpoint

CREATE FUNCTION "atrium_append_core_event"(
  p_room_id uuid,
  p_event_id text,
  p_type "event_type",
  p_actor_kind "actor_kind",
  p_actor_id text,
  p_payload jsonb,
  p_occurred_at timestamptz,
  p_trusted_messages jsonb DEFAULT NULL,
  p_origin text DEFAULT NULL
) RETURNS TABLE ("seq" bigint, "room_seq" bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $append$
DECLARE
  v_room_seq bigint;
  v_seq bigint;
  v_max_at timestamptz;
  v_max_id text;
  v_member boolean;
BEGIN
  -- `0x41545232` = 1096045106 — "ATR2". Duplicated in apps/server/src/ledger.ts
  -- as LEDGER_ADVISORY_LOCK_KEY, and an integration test reads this function's
  -- deployed body and asserts the two agree: r1 shipped a hand-conversion typo
  -- where the migration took 1096041522 and the server took 1096045106, both
  -- took *a* lock, neither ever contended, and every single-process test stayed
  -- green while the mutual-exclusion guarantee was simply absent.
  PERFORM pg_advisory_xact_lock(1096045106::bigint);

  -- (b) Membership, inside the boundary.
  IF p_actor_kind = 'human' THEN
    IF p_actor_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION
        'human actor "%" is not a user id; core_events may not be appended to on behalf of an identity that cannot be a member of a room', p_actor_id
        USING ERRCODE = '42501', CONSTRAINT = 'core_events_append_actor_authorized';
    END IF;
    -- `PERFORM … FOR SHARE` rather than `SELECT EXISTS(… FOR SHARE)`: the row
    -- lock has to be taken on the membership row itself, and a lock inside a
    -- subquery is a lock on whatever the planner decided to materialise. FOUND
    -- is set by PERFORM, so this reads the row, locks it, and answers in one
    -- statement. A concurrent revoke now waits for this append to commit or
    -- abort instead of slipping between the check and the insert.
    PERFORM 1 FROM "memberships" m
    WHERE m."room_id" = p_room_id AND m."user_id" = p_actor_id::uuid
    FOR SHARE;
    v_member := FOUND;
    IF NOT v_member THEN
      RAISE EXCEPTION
        'actor "%" holds no membership in room % and may not append to its history', p_actor_id, p_room_id
        USING ERRCODE = '42501', CONSTRAINT = 'core_events_append_actor_authorized';
    END IF;
  END IF;
  -- A model or the system actor is not a room member and cannot be: those are
  -- server-side identities, and reaching this function at all now requires
  -- EXECUTE, which only the application role holds. The room check for them is
  -- the grant.

  -- (c) The reducer's ordering gate, in SQL. `COLLATE "C"` because the reducer
  -- compares ids with JavaScript's `<`, and the `core_events_id_is_safe_to_order`
  -- CHECK is what makes those two the same order rather than usually the same
  -- order. The `at` half is `core_events_payload_at_is_canonical_utc`: with one
  -- spelling per instant, string comparison and `timestamptz` comparison agree on
  -- equality as well as on order, so a tie here is a tie there.
  SELECT e."occurred_at", e."id" INTO v_max_at, v_max_id
  FROM "core_events" e
  ORDER BY e."occurred_at" DESC, e."id" COLLATE "C" DESC
  LIMIT 1;

  IF v_max_at IS NOT NULL AND NOT (
    p_occurred_at > v_max_at
    OR (p_occurred_at = v_max_at AND (p_event_id COLLATE "C") > (v_max_id COLLATE "C"))
  ) THEN
    RAISE EXCEPTION
      'event (%, %) does not sort strictly after the ledger cursor (%, %) in canonical (at, id) order; a replay would refuse it and the durable log would stop reproducing the live state',
      p_occurred_at, p_event_id, v_max_at, v_max_id
      USING ERRCODE = '55000', CONSTRAINT = 'core_events_append_canonical_order';
  END IF;

  -- Minted under the lock, in the same transaction as the INSERT: an append
  -- that aborts gives its number straight back, so `room_seq` stays contiguous
  -- while the global `seq` (a bigserial, which does not roll back) may gap.
  SELECT coalesce(max(e."room_seq"), 0) + 1 INTO v_room_seq
  FROM "core_events" e
  WHERE e."room_id" = p_room_id;

  INSERT INTO "core_events" ("room_id", "room_seq", "id", "type", "actor_kind", "actor_id", "payload", "occurred_at", "trusted_messages")
  VALUES (p_room_id, v_room_seq, p_event_id, p_type, p_actor_kind, p_actor_id, p_payload, p_occurred_at, p_trusted_messages)
  RETURNING "core_events"."seq" INTO v_seq;

  -- (d) The doorbell, inside the boundary. Postgres queues notifications and
  -- delivers them at commit, so it can neither precede nor outlive the row it is
  -- about. The payload is a position and an origin, never an event body: the
  -- receiver reads the row out of the ledger, because it has to fold it anyway
  -- and a relayed copy is a second history free to disagree with the first.
  PERFORM pg_notify('atrium_ledger', json_build_object(
    'origin', p_origin,
    'roomId', p_room_id,
    'seq', v_seq,
    'roomSeq', v_room_seq
  )::text);

  "seq" := v_seq;
  "room_seq" := v_room_seq;
  RETURN NEXT;
END;
$append$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_append_core_event"(uuid, text, "event_type", "actor_kind", text, jsonb, timestamptz, jsonb, text) IS
  'The only way a row reaches core_events, and the authorization boundary in front of it: takes the ledger advisory lock, authorizes the actor''s membership, refuses anything that does not sort strictly after the canonical cursor, mints room_seq, inserts the event together with the receipt window it folded under, and rings the cross-instance doorbell. EXECUTE is granted to the application role only. Privileged bypasses (session_replication_role, pg_restore --disable-triggers) are operator territory and out of scope.';--> statement-breakpoint

-- ── privileges: re-granted for the new signature ─────────────────────────────
--
-- A dropped function takes its grants with it, so these are not decoration:
-- without them the door this branch locked in 0004 would be reopened by the
-- default, which for a freshly created function is EXECUTE to PUBLIC.
REVOKE EXECUTE ON FUNCTION "atrium_append_core_event"(uuid, text, "event_type", "actor_kind", text, jsonb, timestamptz, jsonb, text) FROM PUBLIC;--> statement-breakpoint

DO $privileges$
DECLARE
  v_owner name;
  v_role name;
  v_signature text := 'public.atrium_append_core_event(uuid, text, event_type, actor_kind, text, jsonb, timestamptz, jsonb, text)';
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = 'core_events' AND n.nspname = 'public';

  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_signature, v_owner);

  -- Every non-superuser login role the r2 migration had already treated as an
  -- app role: it revoked their direct INSERT and granted them the function. They
  -- keep the function and nothing else.
  FOR v_role IN
    SELECT r.rolname FROM pg_roles r
    WHERE r.rolcanlogin
      AND NOT r.rolsuper
      AND r.rolname <> v_owner
      AND has_table_privilege(r.rolname, 'public.core_events', 'SELECT')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_signature, v_role);
  END LOOP;
END;
$privileges$;
