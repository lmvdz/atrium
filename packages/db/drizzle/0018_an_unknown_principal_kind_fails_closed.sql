-- ═════════════════════════════════════════════════════════════════════════════
-- AN UNKNOWN PRINCIPAL KIND FAILS CLOSED, AND A UUID CANNOT CHANGE SPECIES BY
-- BEING DELETED FIRST.
--
-- Two latent fail-opens in 0017, both found by #96's gauntlet and both agreed on
-- by two foreign lineages independently. Neither is exploitable today. Both are
-- the shape that stops being latent the moment somebody adds an enum value or
-- writes a cleanup script, and both are the *same* shape: a rule that names the
-- cases it knows about and says nothing about the rest.
--
-- ## 1. The identified set was a denylist wearing an allowlist's clothes
--
-- 0017 §3(a) opens with:
--
--   > IF NEW."actor_kind"::text IN ('human', 'agent') THEN … END IF;
--
-- Read it as the rule it implements — *an actor that carries an identity must
-- hold a membership, and its kind must agree with its identity's own kind* — and
-- the hole is visible: the rule is applied to a **hand-written list of the kinds
-- that carried an identity on the day it was written**. A sixth `actor_kind`
-- added later does not fail this check. It is not *reached* by this check. It
-- skips the uuid check, the identity resolution, the agreement clause and the
-- membership lock, and appends durable history into any room, and nothing
-- anywhere raises. AGENTS.md states the rule this breaks in one line:
-- **allowlist the compliant form; never denylist violations**, and derive the
-- assertion from the same computation that authorizes it so no list exists.
--
-- So the list is gone. The identified set is now *derived from
-- `principal_kind` itself* — the enum that decides what a `users` row may be.
-- An `actor_kind` label that is also a `principal_kind` label is an identified
-- kind, by construction, and gets the full check. That is the same computation
-- that authorizes it: the agreement clause compares `actor_kind` to
-- `users.principal_kind`, so the set of kinds that clause can possibly be
-- satisfied by is exactly the set of `principal_kind` labels. Add a third
-- identified kind to `principal_kind` and it is checked the day it exists, with
-- nothing in this file edited.
--
-- The two anonymous kinds stay written out, and that is deliberate rather than
-- inconsistent: `model` and `system` are the two kinds that are **exempt**, and
-- an exemption is the thing that must be enumerated. Everything else — a kind
-- that is neither a principal kind nor one of those two — is **refused**, which
-- is the branch 0017 did not have. An `actor_kind` nobody has classified is not
-- a kind that may append.
--
-- The failure direction is the whole point. Before: an unclassified kind writes
-- history unchecked, silently. After: it cannot append at all, loudly, and the
-- error names what to do. Adding a value to `actor_kind` without saying what it
-- is now breaks at the first append instead of at the first audit.
--
-- ## 2. `BEFORE UPDATE` does not bind a DELETE followed by an INSERT
--
-- `users_principal_kind_immutable` (0017 §2) refuses an UPDATE that changes the
-- column. It is a BEFORE UPDATE trigger, so it has nothing to say about:
--
--   DELETE FROM users WHERE id = '…';
--   INSERT INTO users (id, …, principal_kind) VALUES ('…the same uuid…', 'agent');
--
-- and after those two statements every `core_events` row that uuid ever appended
-- as a `human` reads back as an agent's — or, in the direction that actually
-- matters, an agent's whole history reads back as a person's. That is precisely
-- the re-attribution the immutability trigger exists to prevent, reached by
-- going around it rather than through it. 0017's own COMMENT says the column is
-- "set once, at provisioning, and never afterwards"; that sentence was true of
-- UPDATE and not of the row.
--
-- **In scope, and closed here**, because the argument for closing it is the
-- argument 0017 already made for the trigger: `atrium_core_events_invariants`
-- reads `principal_kind` without a row lock, and the reason that is free of a
-- time-of-check/time-of-use gap is that the value cannot change. A value that
-- can change by delete-then-reinsert can change. The guard is therefore stated
-- as the property the append boundary actually depends on, which is not about
-- UPDATE at all:
--
--   > No `users` row may exist whose `principal_kind` disagrees with the
--   > `actor_kind` of any `core_events` row that identity has already appended.
--
-- Enforced on INSERT, against the log. A uuid with no history is free to be
-- provisioned as anything (which is what makes this cost an ordinary signup one
-- indexed lookup and nothing else); a uuid whose history says `human` may only
-- come back as a human. What it does *not* do is prevent the DELETE — an
-- identity can still be removed, with its history left pointing at nobody, and
-- that is a separate property (referential integrity of the ledger against
-- `users`) which no trigger here claims to hold.
--
-- The limit both triggers share is 0003's and is stated rather than papered
-- over: an operator who disables triggers, or who rewrites `core_events`
-- directly, is not bound by either.
--
-- ## What is deliberately NOT changed
--
--  * **`atrium_receipt_window`** — untouched, for 0017's reasons. 0011 remains
--    its newest definition and four assertions in `schema.test.ts` read it there.
--  * **`atrium_append_core_event`** — untouched; it has held no rules since 0008.
--  * **The `DEFAULT 'human'` on `users.principal_kind`** — deliberately still
--    there, and it is the one finding of #96's gauntlet routed elsewhere (#106)
--    rather than closed here. An unscoped INSERT that forgets the column mints a
--    person. Removing the default is not the fix — a `NOT NULL` with no default
--    turns every forgotten insert into an error at a call site nobody has
--    audited, and the sanctioned route (`provisionAgentPrincipal`) always states
--    it. The durable mitigation is single-path provisioning plus #106's gate, and
--    it is a decision about the application rather than about this table. Note
--    what §2 above *does* buy against it: a row minted 'human' by a forgotten
--    insert can no longer be repaired into an agent by deleting and re-adding it
--    once it has appended anything, so the failure stays visible instead of being
--    quietly tidied away.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. The lookup index the history guard rides on
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `core_events_actor_idx` is `(actor_kind, actor_id)`, which answers "everything
-- this actor of this kind did" and cannot answer "anything at all under this
-- uuid" without scanning — and "under this uuid, of ANY kind" is exactly the
-- question §3 asks on every signup. A leading-column index on `actor_id` makes
-- that one lookup rather than one sequential scan of the whole ledger.
CREATE INDEX IF NOT EXISTS "core_events_actor_id_idx" ON "core_events" USING btree ("actor_id");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. The append boundary, with the identified set derived instead of listed
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `CREATE OR REPLACE`, for 0017's reason: a trigger function has exactly one
-- possible signature, so there is no overload to create, and replacing in place
-- keeps the existing `core_events_invariants` trigger bound throughout — there is
-- no window in which the table has no rules.
--
-- Sections (b) through (e) are carried forward from 0017 **verbatim**, comments
-- included, so a reader who diffs the two files sees exactly one section
-- changed. This file is now the newest definition of the whole function, and
-- `mutants/mutants.json` restores it from here.
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
  v_identified boolean;
BEGIN
  -- (a) Membership, for the writer that carries an identity — and a refusal for
  --     the writer whose kind nobody has classified.
  --
  -- The set of identified kinds is READ FROM `principal_kind`, not written out.
  -- 0017 wrote the two labels out as a literal membership test, which was correct
  -- on the day and silently exempts every kind added after it — see this file's
  -- header, which quotes the line. (Quoted there and not here on purpose: this
  -- comment travels with the function into `pg_get_functiondef`, and an
  -- integration test asserts the deployed definition does not contain that
  -- literal. A comment reproducing it would satisfy the search it exists to
  -- fail.) The derivation is not a convenience: the clause this gate exists for
  -- compares `actor_kind` to `users.principal_kind`, so the kinds it can apply to
  -- ARE the labels of that enum. Deriving the set from the enum and checking the
  -- agreement against the column are the same computation asked twice.
  SELECT EXISTS (
    SELECT 1
    FROM pg_enum en
    JOIN pg_type t ON t.oid = en.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'principal_kind'
      AND en.enumlabel = NEW."actor_kind"::text
  ) INTO v_identified;

  IF v_identified THEN
    -- Everything from 0017, unchanged: the uuid shape, the identity, the
    -- agreement between the row's claimed kind and the identity's own, and the
    -- membership row under a share lock.
    IF NEW."actor_id" !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION
        '% actor "%" is not a user id; core_events may not be appended to on behalf of an identity that cannot be a member of a room', NEW."actor_kind", NEW."actor_id"
        USING ERRCODE = '42501', CONSTRAINT = 'core_events_append_actor_authorized';
    END IF;
    -- No `FOR SHARE` on this read, and that is deliberate: `principal_kind` is
    -- immutable (`users_principal_kind_immutable`, and §3 below closes the route
    -- around it), so there is no update for the check to race against and a row
    -- lock would buy nothing while serialising every append by one identity
    -- behind every unrelated write to its user row.
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

  ELSIF NEW."actor_kind"::text IN ('model', 'system') THEN
    -- The two ANONYMOUS kinds, and the only two exemptions this boundary grants.
    -- A model is named by a model string and a system actor by nothing, so
    -- neither has an id a `memberships` row could point at and none is asked
    -- for. Reaching the append function at all requires EXECUTE, which only the
    -- application role holds; the room check for these two is still the grant.
    --
    -- Written out rather than derived, on purpose and in the other direction
    -- from the branch above: this is the list of kinds that are EXCUSED, and an
    -- excuse is the thing that has to be enumerated. Deriving it as "everything
    -- that is not a principal kind" would hand the excuse to every future kind
    -- automatically, which is the hole this migration exists to close.
    NULL;

  ELSE
    -- Neither identified nor anonymous: a kind nobody has classified.
    --
    -- This branch is unreachable today and is the entire point of the file. Add
    -- a value to `actor_kind` and this is what happens instead of nothing: the
    -- append is refused, at the first attempt, with a message naming both
    -- choices. Fails CLOSED — the direction #90 says this boundary must fail in,
    -- and the direction 0017's `IN ('human','agent')` did not.
    RAISE EXCEPTION
      'actor_kind "%" is neither an identity (a principal_kind label, which is checked for membership and kind agreement) nor one of the anonymous kinds (model, system, which are excused because they have no id to be a member with); a kind nobody has classified may not append. Add it to principal_kind if it names a users row, or to the anonymous list in atrium_core_events_invariants if it does not', NEW."actor_kind"
      USING ERRCODE = '42501', CONSTRAINT = 'core_events_append_actor_authorized';
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
  'Every append rule that is about more than one row, enforced on the table rather than in the function that is supposed to be the only door: an IDENTIFIED actor''s membership and the agreement between its actor_kind and its own users.principal_kind, the room a room-less kind resolves to from the row that minted its subject, the canonical (at, id) order, and the two derived columns — room_seq and trusted_messages — which are overwritten here rather than taken from the caller. The identified set is DERIVED from the principal_kind enum rather than listed (0018): a kind that names a users row is checked the day it exists, the two anonymous kinds (model, system) are the enumerated exemptions, and an actor_kind that is neither is REFUSED rather than silently excused — 0017 spelled the set as IN (''human'',''agent''), which exempted every kind added after it. That is what keeps @atrium/core''s isHuman gates meaningful once a non-human can hold an account (#90). Binds every writer, including one whose call stack lies about which function it is (#22 gauntlet r6, major 3). Does not bind an operator who disables triggers; that is the same limit 0003 states.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 3. Immutability, stated as the property rather than as "no UPDATE"
-- ─────────────────────────────────────────────────────────────────────────────
--
-- See the header, §2. `users_principal_kind_immutable` stays exactly as 0017
-- wrote it and still refuses the UPDATE; this closes the route around it, which
-- is a DELETE and an INSERT of the same uuid under the other kind.
--
-- The check is against the LOG, which is the thing that would be re-attributed,
-- and it is scoped to the identified kinds by the same `principal_kind`
-- derivation §2 uses — so a model whose model string happened to spell a uuid
-- cannot make a signup fail, and a future identified kind is covered the day it
-- exists with nothing here edited.
CREATE OR REPLACE FUNCTION "atrium_users_principal_kind_matches_history"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $history$
DECLARE
  v_kind text;
BEGIN
  SELECT e."actor_kind"::text INTO v_kind
  FROM public."core_events" e
  WHERE e."actor_id" = NEW."id"::text
    AND e."actor_kind"::text <> NEW."principal_kind"::text
    AND EXISTS (
      SELECT 1
      FROM pg_enum en
      JOIN pg_type t ON t.oid = en.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND t.typname = 'principal_kind'
        AND en.enumlabel = e."actor_kind"::text
    )
  LIMIT 1;

  IF v_kind IS NOT NULL THEN
    RAISE EXCEPTION
      'user % has already appended history as a % actor and may not be provisioned as a % principal; an identity''s kind is what every core_events row it appended was checked against, and re-creating the uuid under the other kind would re-attribute all of it. Provision a new identity instead',
      NEW."id", v_kind, NEW."principal_kind"
      USING ERRCODE = '23514', CONSTRAINT = 'users_principal_kind_immutable';
  END IF;
  RETURN NEW;
END;
$history$;--> statement-breakpoint

CREATE TRIGGER "users_principal_kind_matches_history"
  BEFORE INSERT ON "users"
  FOR EACH ROW EXECUTE FUNCTION "atrium_users_principal_kind_matches_history"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_users_principal_kind_matches_history"() IS
  'Refuses an INSERT into users whose principal_kind disagrees with the actor_kind of any core_events row that uuid has already appended. The companion to users_principal_kind_immutable and the reason that trigger''s guarantee is about the ROW rather than about the UPDATE statement: BEFORE UPDATE does not bind delete-then-reinsert of the same uuid under the other kind, which would silently re-read every event that identity ever wrote as the other sort of participant (#96 r2). Costs an ordinary signup one indexed lookup on core_events_actor_id_idx and refuses nothing for a uuid with no history. Scoped to the identified kinds by the same principal_kind derivation atrium_core_events_invariants uses. Does not prevent the DELETE itself; ledger rows pointing at a removed identity are a separate property no trigger here claims.';--> statement-breakpoint

COMMENT ON TRIGGER "users_principal_kind_matches_history" ON "users" IS
  'BEFORE INSERT. See atrium_users_principal_kind_matches_history. Pairs with users_principal_kind_immutable (BEFORE UPDATE, 0017): between them, a users row''s principal_kind cannot change by any route that leaves its history behind.';
