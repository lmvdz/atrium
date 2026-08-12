-- ═════════════════════════════════════════════════════════════════════════════
-- AN IDENTIFIED AGENT MAY BE A MEMBER. AN ANONYMOUS ONE STILL MAY NOT.
--
-- ## The sentence this migration retires, and why it is being retired
--
-- Since 0004 the append boundary has carried a comment, restated in 0005, 0006,
-- 0007 and finally 0008 where the rule now lives:
--
--   > A model or the system actor is not a room member and cannot be: those are
--   > server-side identities, and reaching the append function at all requires
--   > EXECUTE, which only the application role holds. The room check for them is
--   > the grant.
--
-- It was true, and the reasoning under it is still true — for the two kinds it
-- names. What it got wrong was the scope of the word it used for them. It said
-- "not a person, therefore not a member", and the load-bearing half was never
-- humanity: it was **anonymity**. A `model` actor is named by a model string and
-- a `system` actor is named by nothing, so neither has an id a `memberships` row
-- could point at. The rule "a non-human cannot be a member" was a true statement
-- about a world in which every non-human was also anonymous.
--
-- That world ends here. `agent` is a non-human actor that **is** an identity: a
-- `users` row, a `workspace_members` row, a `memberships` row, its own session.
-- So the invariant is restated on the axis that was actually doing the work:
--
--   > An actor that carries an identity — `human` or `agent` — must hold a
--   > membership in the room it appends to, and its `actor_kind` must agree with
--   > that identity's own `principal_kind`. An actor that carries no identity —
--   > `model` or `system` — is not a room member and cannot be, because it has
--   > nothing to be a member with; the room check for those two is still the
--   > EXECUTE grant.
--
-- The membership rule is therefore **widened in one direction and narrowed in
-- another**, and the narrowing is the point of the file. Widened: `agent` rows
-- now go through the same uuid check, the same `FOR SHARE` membership read and
-- the same refusal `human` rows have gone through since 0004. Narrowed: neither
-- kind may any longer claim to be the other. Before this migration `actor_kind`
-- was whatever the application handed the append function, checked against
-- nothing; that was harmless while only one kind carried a user id, and it is
-- the whole attack the moment two do.
--
-- ## The narrowing, stated as the thing it defends
--
-- `kind: 'human'` has always meant, in practice, "authenticated account". Once
-- an agent holds an account, every `isHuman` gate in `packages/core` goes blind
-- unless something keeps the two distinguishable all the way down — session →
-- `actorOf` → ledger → reducer. Four layers, and the first three are application
-- code that a bug, a refactor or a second call site can get wrong.
--
-- This trigger is the fourth, and it is the only one an application mistake
-- cannot talk past. It does not take the application's word for `actor_kind`; it
-- reads `users.principal_kind` for the id in `actor_id` and refuses the row if
-- the two disagree. An agent's session that somehow derived `{kind:'human'}`
-- does not write a person's history — it writes nothing, and the append fails
-- loudly. Derive the assertion from the same row that authorizes it and there is
-- no list to keep in step.
--
-- `principal_kind` is immutable (§2), so this check needs no row lock on `users`
-- to be free of a time-of-check/time-of-use gap: there is no update it could
-- race against. That is stronger than a `FOR SHARE` would have been and costs
-- the append nothing.
--
-- ## What is deliberately NOT changed
--
--  * **`atrium_receipt_window` is untouched.** It returns NULL for `human` —
--    "a person reading the room is the receipt" — and computes a window for
--    everything else, so an `agent` acceptance gets a receipt window exactly as
--    a `model` acceptance does. That is the correct side of the line and it
--    falls out of the existing predicate; redefining the function to say so
--    would move the newest definition of it out of 0011 and stale the four
--    assertions in `packages/db/test/schema.test.ts` that read it by name.
--  * **`atrium_append_core_event` is untouched.** Since 0008 it holds no rules —
--    it takes the lock, names the instance, inserts, and reports what the table
--    assigned. There is nothing in it for this change to reach.
--  * **No `proposer_kind` value is added.** A proposal's proposer decides whether
--    the acceptance engine demands a receipt window and whether θ applies, and
--    those are acceptance-semantics questions this migration does not answer.
--    `apps/server` refuses to stage a proposal from an agent session rather than
--    recording it as a human's; when somebody answers them, `proposer_kind`
--    grows a value and that is a different migration.
--
-- ## `ALTER TYPE … ADD VALUE` inside the migration transaction
--
-- drizzle's migrator runs every pending migration in one transaction. Postgres
-- 12+ permits `ALTER TYPE … ADD VALUE` there but refuses to *use* the new label
-- in the same transaction. Nothing below uses it: every comparison against
-- `actor_kind` in the trigger body is written through `::text`, which resolves no
-- enum label at all, and plpgsql bodies are not analysed until they run. Written
-- that way on purpose rather than by luck — the `::text` spelling is what makes
-- this file safe to apply in the same transaction as the migrations before it.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. The two enums
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Two, not one, and they are not the same question. `actor_kind` describes an
-- **event**: who appended this row. `principal_kind` describes an **identity**:
-- what sort of participant this `users` row stands for. `model` and `system` are
-- not identities and must not be spellable as one, which is exactly what reusing
-- `actor_kind` on `users` would have permitted.
CREATE TYPE "public"."principal_kind" AS ENUM('human', 'agent');--> statement-breakpoint

ALTER TYPE "public"."actor_kind" ADD VALUE IF NOT EXISTS 'agent' AFTER 'human';--> statement-breakpoint

COMMENT ON TYPE "public"."principal_kind" IS
  'What a users row IS. "human" is a person; "agent" is a non-human participant that nevertheless holds an account, a workspace membership, a room membership and a session, and whose writes are attributed to its own users row. The kind decides nothing about what a participant may read or write EXCEPT certification: every human-only gate in @atrium/core refuses an agent exactly as it refuses a model. Distinct from actor_kind, which describes an event rather than an identity and additionally carries the two anonymous kinds (model, system) that are not identities at all.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. The column, and its immutability
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ON `users`, NOT IN A SIBLING TABLE, and the reason is the failure direction.
--
-- Every membership, attention and attribution foreign key in this schema already
-- lands on `users.id`. A sibling `principals(user_id, kind)` would answer "what
-- is this participant?" with a join, and a join has a *missing row* — a third
-- state whose only sane reading is "human", because every row that predates this
-- migration would have no principal row and every one of them is a person. That
-- is a default that fails open, sitting in the one place in the system that has
-- to fail closed: the day an agent's principal row is missing for any reason, it
-- is a person.
--
-- `NOT NULL DEFAULT 'human'` on the row itself has no missing state to read. The
-- backfill is the default, and it is correct rather than convenient: every
-- identity that existed before this migration reached the database through
-- interactive signup, which is a person by construction.
ALTER TABLE "users" ADD COLUMN "principal_kind" "principal_kind" DEFAULT 'human' NOT NULL;--> statement-breakpoint

COMMENT ON COLUMN "users"."principal_kind" IS
  'Person or agent. Set once, at provisioning, and never afterwards — users_principal_kind_immutable refuses any UPDATE that changes it, because changing it would silently re-read every core_events row this identity ever appended as having been written by the other sort of participant, and would break the actor_kind agreement check in atrium_core_events_invariants for rows already committed. Exposed to Better Auth as a user additionalField with input:false, so no request body anywhere can set it; provisioning an agent principal is a programmatic write (@atrium/auth provisionAgentPrincipal) precisely because there is no interactive route to it.';--> statement-breakpoint

-- Immutable, on the table.
--
-- This is what lets the append boundary read `principal_kind` without locking the
-- row: a value that cannot change has no time-of-check/time-of-use gap. It is
-- also the honest constraint on its own terms — an identity's kind is not a
-- setting, it is what the identity has always been, and every `core_events` row
-- it ever appended was checked against it.
--
-- A separate identity is the remedy for "this agent should have been a person",
-- and that is the right remedy: the history stays attributed to whoever actually
-- wrote it.
CREATE OR REPLACE FUNCTION "atrium_users_principal_kind_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $immutable$
BEGIN
  IF NEW."principal_kind" IS DISTINCT FROM OLD."principal_kind" THEN
    RAISE EXCEPTION
      'user % is a % principal and may not become a %; an identity''s kind is what every core_events row it appended was checked against, so changing it would re-attribute history that has already been written. Provision a separate identity instead',
      OLD."id", OLD."principal_kind", NEW."principal_kind"
      USING ERRCODE = '23514', CONSTRAINT = 'users_principal_kind_immutable';
  END IF;
  RETURN NEW;
END;
$immutable$;--> statement-breakpoint

CREATE TRIGGER "users_principal_kind_immutable"
  BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION "atrium_users_principal_kind_immutable"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_users_principal_kind_immutable"() IS
  'Refuses any UPDATE that changes users.principal_kind. Two things rest on it: atrium_core_events_invariants reads the column without a row lock and is free of a time-of-check/time-of-use gap only because there is no update to race, and every core_events row already committed was checked against the value the row held then. Does not bind an operator who disables triggers; that is the same limit 0003 states.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 3. The append boundary, stating the new invariant
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `CREATE OR REPLACE`, and here that is the only correct spelling rather than
-- merely a safe one. A trigger function has exactly one possible signature —
-- `() RETURNS trigger` — so there is no parameter list to change and no overload
-- to create, which is the r2 hazard every other function in this chain is
-- replaced by DROP + CREATE to avoid. Replacing in place also keeps the existing
-- `core_events_invariants` trigger bound to it, so there is no window in which
-- the table has no rules.
--
-- Sections (b) through (e) are carried forward from 0008 **verbatim**, comments
-- included. They are reproduced rather than referenced because this file is now
-- the newest definition of the whole function, and a reader who diffs it against
-- 0008 should see exactly one section changed. `mutants/mutants.json` restores
-- the invariants function from this file for the same reason.
CREATE OR REPLACE FUNCTION "atrium_core_events_invariants"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $invariants$
DECLARE
  v_max_at timestamptz;
  v_max_id text;
  v_subject text;
  v_subject_rooms uuid[];
  v_room_seq bigint;
  v_principal text;
BEGIN
  -- (a) Membership, for the writer that carries an identity.
  --
  -- 0004 through 0008 read: "A model or the system actor is not a room member
  -- and cannot be." That sentence is retired here and replaced by the one it was
  -- always standing in for — see this file's header. The axis is ANONYMITY, not
  -- humanity:
  --
  --   * `human` and `agent` carry a user id. Both must resolve to a `users` row
  --     whose `principal_kind` says the same thing this row's `actor_kind` says,
  --     and both must hold a membership in the room they are appending to.
  --   * `model` and `system` carry no identity — a model is named by a model
  --     string, a system actor by nothing — so there is no `memberships` row
  --     they could hold and none is asked for. Reaching the append function at
  --     all requires EXECUTE, which only the application role holds; the room
  --     check for those two is still the grant.
  --
  -- The agreement check is the half that is new, and it is the half that matters
  -- once two kinds carry a user id. `actor_kind` arrives from the application,
  -- derived from a session four layers up; until now nothing checked it, which
  -- was harmless while only one kind had an id and is the whole attack the
  -- moment two do. An agent's append that claimed `human` would otherwise be
  -- durable history that every `isHuman` gate in the reducer reads as a person's.
  -- It is refused here instead, against the identity's own row.
  --
  -- Written through `::text` on both sides rather than as an enum comparison:
  -- `agent` is added to `actor_kind` by this same migration, and Postgres refuses
  -- to resolve a label added in the running transaction. `::text` resolves no
  -- label. See the header.
  IF NEW."actor_kind"::text IN ('human', 'agent') THEN
    IF NEW."actor_id" !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION
        '% actor "%" is not a user id; core_events may not be appended to on behalf of an identity that cannot be a member of a room', NEW."actor_kind", NEW."actor_id"
        USING ERRCODE = '42501', CONSTRAINT = 'core_events_append_actor_authorized';
    END IF;
    -- No `FOR SHARE` on this read, and that is deliberate: `principal_kind` is
    -- immutable (`users_principal_kind_immutable`), so there is no update for the
    -- check to race against and a row lock would buy nothing while serialising
    -- every append by one identity behind every unrelated write to its user row.
    SELECT u."principal_kind"::text INTO v_principal
    FROM public."users" u WHERE u."id" = NEW."actor_id"::uuid;
    IF v_principal IS NULL THEN
      RAISE EXCEPTION
        'actor "%" is not an identity in this database and may not append to room %', NEW."actor_id", NEW."room_id"
        USING ERRCODE = '42501', CONSTRAINT = 'core_events_append_actor_authorized';
    END IF;
    IF v_principal <> NEW."actor_kind"::text THEN
      RAISE EXCEPTION
        'actor "%" is a % principal but this event claims actor_kind %; an append may not attribute itself to a kind its own identity is not, because that is the one thing every human-only gate downstream reads', NEW."actor_id", v_principal, NEW."actor_kind"
        USING ERRCODE = '42501', CONSTRAINT = 'core_events_append_actor_authorized';
    END IF;
    -- `PERFORM … FOR SHARE` rather than `SELECT EXISTS(… FOR SHARE)`: the row
    -- lock has to be taken on the membership row itself, and a lock inside a
    -- subquery is a lock on whatever the planner decided to materialise. FOUND
    -- is set by PERFORM, so this reads the row, locks it, and answers in one
    -- statement. A concurrent revoke now waits for this append to commit or
    -- abort instead of slipping between the check and the insert.
    PERFORM 1 FROM public."memberships" m
    WHERE m."room_id" = NEW."room_id" AND m."user_id" = NEW."actor_id"::uuid
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'actor "%" holds no membership in room % and may not append to its history', NEW."actor_id", NEW."room_id"
        USING ERRCODE = '42501', CONSTRAINT = 'core_events_append_actor_authorized';
    END IF;
  END IF;

  -- (b) The room a ROOM-LESS kind lands in — 0007 §3, moved onto the table.
  --
  -- `core_events_payload_room_matches` refuses these three kinds any room key at
  -- all, so `room_id` is the only thing that says where the row goes and nothing
  -- in a single row can contradict it. The contradiction lives in another row:
  -- the one that minted the proposal or the object this event names. That is
  -- what `resolveRoomId` reads out of the folded state on the command path, and
  -- it is read here out of the log itself, so a caller that never goes through
  -- the server gets the same answer.
  --
  -- `array_agg(DISTINCT …)` rather than a `LIMIT 1`: a subject minted twice in
  -- two rooms is a log no replay can fold, and picking one of the two would make
  -- this the place that decided which. It is refused instead.
  IF NEW."payload"->>'type' IN ('proposal_rejected', 'proposal_superseded') THEN
    v_subject := NEW."payload"->>'proposalId';
    SELECT array_agg(DISTINCT e."room_id") INTO v_subject_rooms
    FROM public."core_events" e
    WHERE e."type" = 'proposal_recorded'
      AND e."payload"->'proposal'->>'id' = v_subject;
    IF v_subject_rooms IS NULL THEN
      RAISE EXCEPTION
        'proposal "%" is not in the ledger, so this event names no room and has no position', v_subject
        USING ERRCODE = '23514', CONSTRAINT = 'core_events_subject_room_matches';
    END IF;
    IF array_length(v_subject_rooms, 1) > 1 THEN
      RAISE EXCEPTION
        'proposal "%" was recorded in more than one room; the ledger cannot say which room this event belongs to', v_subject
        USING ERRCODE = '23514', CONSTRAINT = 'core_events_subject_room_matches';
    END IF;
    IF v_subject_rooms[1] <> NEW."room_id" THEN
      RAISE EXCEPTION
        'proposal "%" belongs to room % but this event was filed into room %; the fan-out and the fold would disagree about where it happened', v_subject, v_subject_rooms[1], NEW."room_id"
        USING ERRCODE = '23514', CONSTRAINT = 'core_events_subject_room_matches';
    END IF;
  ELSIF NEW."payload"->>'type' = 'object_corrected' THEN
    v_subject := NEW."payload"->>'objectId';
    SELECT array_agg(DISTINCT e."room_id") INTO v_subject_rooms
    FROM public."core_events" e
    WHERE e."type" = 'object_accepted'
      AND e."payload"->'object'->>'id' = v_subject;
    IF v_subject_rooms IS NULL THEN
      RAISE EXCEPTION
        'object "%" is not in the ledger, so this event names no room and has no position', v_subject
        USING ERRCODE = '23514', CONSTRAINT = 'core_events_subject_room_matches';
    END IF;
    IF array_length(v_subject_rooms, 1) > 1 THEN
      RAISE EXCEPTION
        'object "%" was accepted in more than one room; the ledger cannot say which room this event belongs to', v_subject
        USING ERRCODE = '23514', CONSTRAINT = 'core_events_subject_room_matches';
    END IF;
    IF v_subject_rooms[1] <> NEW."room_id" THEN
      RAISE EXCEPTION
        'object "%" belongs to room % but this event was filed into room %; the fan-out and the fold would disagree about where it happened', v_subject, v_subject_rooms[1], NEW."room_id"
        USING ERRCODE = '23514', CONSTRAINT = 'core_events_subject_room_matches';
    END IF;
  END IF;

  -- (c) The reducer's ordering gate, in SQL. `COLLATE "C"` because the reducer
  -- compares ids with JavaScript's `<`, and the `core_events_id_is_safe_to_order`
  -- CHECK — itself `COLLATE "C"`, so its charset range means ASCII on every
  -- deployment — is what makes those two the same order rather than usually the
  -- same order. The `at` half is `core_events_payload_at_is_canonical_utc`: with
  -- one spelling per instant, string comparison and `timestamptz` comparison
  -- agree on equality as well as on order, so a tie here is a tie there.
  SELECT e."occurred_at", e."id" INTO v_max_at, v_max_id
  FROM public."core_events" e
  ORDER BY e."occurred_at" DESC, e."id" COLLATE "C" DESC
  LIMIT 1;

  IF v_max_at IS NOT NULL AND NOT (
    NEW."occurred_at" > v_max_at
    OR (NEW."occurred_at" = v_max_at AND (NEW."id" COLLATE "C") > (v_max_id COLLATE "C"))
  ) THEN
    RAISE EXCEPTION
      'event (%, %) does not sort strictly after the ledger cursor (%, %) in canonical (at, id) order; a replay would refuse it and the durable log would stop reproducing the live state',
      NEW."occurred_at", NEW."id", v_max_at, v_max_id
      USING ERRCODE = '55000', CONSTRAINT = 'core_events_append_canonical_order';
  END IF;

  -- (d) `room_seq` is minted here and OVERWRITTEN, so it is not a value any
  -- caller supplies. The exploit's `room_seq = 9999` is not refused, it is
  -- replaced — the row lands contiguous or it does not land.
  --
  -- Minted under the ledger advisory lock, which `core_events_append_guard` has
  -- already asserted this transaction holds, and in the same transaction as the
  -- INSERT: an append that aborts gives its number straight back, so `room_seq`
  -- stays contiguous while the global `seq` (a bigserial, which does not roll
  -- back) may gap.
  SELECT coalesce(max(e."room_seq"), 0) + 1 INTO v_room_seq
  FROM public."core_events" e
  WHERE e."room_id" = NEW."room_id";
  NEW."room_seq" := v_room_seq;

  -- (e) The receipt window, DERIVED — round 5's blocking finding, now derived
  -- one layer further down. It is a function of the room and the payload of the
  -- row being inserted, so there is nothing for a caller to fabricate and no
  -- door through which a fabrication could arrive.
  --
  -- `atrium_receipt_window` is deliberately not redefined by this migration: it
  -- returns NULL for `human` and computes a window for every other kind, so an
  -- `agent` acceptance is handed the messages it cites exactly as a `model`
  -- acceptance is. That is the correct side of the line and it needs no edit to
  -- be true. (0011 remains the newest definition of it, which four assertions in
  -- `packages/db/test/schema.test.ts` read by name.)
  NEW."trusted_messages" := public."atrium_receipt_window"(NEW."room_id", NEW."actor_kind", NEW."payload");

  RETURN NEW;
END;
$invariants$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_core_events_invariants"() IS
  'Every append rule that is about more than one row, enforced on the table rather than in the function that is supposed to be the only door: an IDENTIFIED actor''s membership and the agreement between its actor_kind and its own users.principal_kind, the room a room-less kind resolves to from the row that minted its subject, the canonical (at, id) order, and the two derived columns — room_seq and trusted_messages — which are overwritten here rather than taken from the caller. The membership rule is scoped to the kinds that carry a user id (human, agent) rather than to human alone: 0004''s "a model or the system actor is not a room member and cannot be" was a statement about ANONYMITY, and an agent is a non-human that is not anonymous. Both identified kinds are checked the same way and neither may claim to be the other, which is what keeps @atrium/core''s isHuman gates meaningful once a non-human can hold an account (#90). Binds every writer, including one whose call stack lies about which function it is (#22 gauntlet r6, major 3). Does not bind an operator who disables triggers; that is the same limit 0003 states.';--> statement-breakpoint

COMMENT ON TRIGGER "core_events_invariants" ON "core_events" IS
  'BEFORE INSERT. See atrium_core_events_invariants. Rebound in 0017 by CREATE OR REPLACE of the function, so there was never a moment in which the table had no rules.';
