-- ═════════════════════════════════════════════════════════════════════════════
-- 0008 — the append invariants move onto the TABLE, and the guard stops being
-- fooled by a name
--
-- Round 6 of #22's gauntlet, major 3. The finding, executed against a real
-- Postgres 16:
--
--   > `0003_append_enforcement.sql:115` uses
--   > `position('function atrium_append_core_event(' in v_context)`. PL/pgSQL
--   > builds the signature from `format_procedure` **at compile time**, which
--   > omits the schema qualifier iff that schema is on `search_path` at that
--   > moment — and the compiled function is cached for the session, so the
--   > qualifier stays omitted.
--
--       CREATE SCHEMA evil2;
--       CREATE FUNCTION evil2.atrium_append_core_event(...) ...
--         INSERT INTO public.core_events (...);
--       SET search_path = evil2, public;   -- before the first compile
--       SELECT evil2.atrium_append_core_event('<room B>', 'x003', '{…}');
--       → seq 51, room_id = room B, room_seq 9999, occurred_at 2020,
--         for a proposal minted in room A
--
-- `0003`'s header concedes the class in prose ("a role with CREATE privilege
-- could define its own function with the same name and satisfy the stack
-- check"). `0007:138` then asserted the opposite — "in the only function that
-- can put a row in this table" — and the whole room-less-kind guarantee rested
-- on that sentence. **The sentence was the guarantee.** That is the defect this
-- file fixes, and it fixes it twice over, because either half alone would leave
-- the other one's sentence load-bearing.
--
-- ## Half 1 — the rules move to where every writer has to pass them
--
-- The critic's own summary of the mechanism is the design brief: *only table
-- CHECKs survive this*. A CHECK sees one row and several of these rules are
-- about other rows, so the nearest thing that does survive is a **row trigger on
-- the table**: it fires for every INSERT, from every caller, through every
-- function, whatever the call stack claims to be. `atrium_append_core_event`
-- keeps the door — it takes the lock, and the guard still refuses a stranger —
-- but it is no longer the *place the rules live*, so a caller who gets past the
-- guard is no longer past the rules.
--
-- Five duties move out of the function and into `core_events_invariants`, a
-- BEFORE INSERT trigger:
--
--  1. the human actor's membership in the room being written to,
--  2. the room a room-less kind lands in, resolved from the row that minted its
--     subject (0007 §3 — the guarantee that rested on the sentence),
--  3. the canonical `(at, id)` ordering gate,
--  4. `room_seq`, which is now **minted here and cannot be supplied**, and
--  5. `trusted_messages`, which is now **derived here and cannot be supplied**.
--
-- Run against the exploit above, the bypass now writes nothing: the rejection
-- names a proposal minted in room A and is being filed into room B, so (2)
-- refuses it — from the table, with `evil2` on the search path and the call
-- stack saying whatever it likes.
--
-- A sixth duty moves the other way, into `core_events_doorbell`, an AFTER INSERT
-- trigger: `pg_notify`. `apps/server/src/event-bus.ts` says "no writer can insert
-- a row silently — including a writer that is not this application", and until
-- this file that sentence was false for exactly the writer it named. The origin
-- travels in a transaction-local GUC that the doorbell **consumes**, so a writer
-- that names no instance announces `null` — which matches none of them, so
-- everybody folds it, and that is the direction to be wrong in.
--
-- What that is NOT is an identity. `p_origin` is a caller-supplied string and
-- Postgres accepts any two-part custom GUC, so a caller holding EXECUTE can pass
-- another instance's id and make that one instance ignore the doorbell. Stated
-- because the first draft of this paragraph said an unnamed writer "announces
-- itself as nobody" as if that were forced. The bound is the r2-delta guarantee
-- and it is unchanged: the reconciler folds and fans out on a timer regardless of
-- any notification, so a spoofed origin costs one instance some latency and
-- cannot cost it delivery. If the doorbell were ever the only delivery path, this
-- would be a hole; it is not, and `reconciler.ts` is why.
--
-- ## Half 2 — the guard stops matching a name it cannot pin
--
-- The bypass turns on `format_procedure` being *allowed* to omit `public.`. It is
-- allowed to when `public` is on the search path at compile time — and the
-- function's own `SET search_path` clause is applied before PL/pgSQL compiles its
-- body, so the function itself decides. `atrium_append_core_event` is therefore
-- created with `SET search_path = pg_catalog, pg_temp` and a fully schema-
-- qualified body: its compiled signature is now
--
--     public.atrium_append_core_event(uuid,text,public.event_type,public.actor_kind,text,jsonb,timestamptz,text)
--
-- and the guard requires *that*, schema qualifier included. A function in `evil2`
-- can be called `atrium_append_core_event` but `format_procedure` will never
-- print `public.` in front of it, so the collision is no longer available at any
-- search path or in any compilation order.
--
-- **THE NEXT SENTENCE USED TO SAY "what is left costs CREATE on schema `public`".
-- IT WAS FALSE, AND 0009 IS WHY.** What is left costs no CREATE anywhere: it
-- costs one SQL comment. `GET DIAGNOSTICS … PG_CONTEXT` includes the verbatim
-- statement text of every caller frame, and this guard is a substring search over
-- it, so a bare `DO` block that writes the expected frame label into a comment
-- inside its own INSERT satisfies the check. Executed, r7 gauntlet, defect 1. Do
-- not read the paragraph above as a bound on an adversary — read `0009`, which
-- states what this check is and proves what it cannot be.
--
-- The expected signature is **derived, not restated**: the guard asks
-- `to_regprocedure(…)::text` under its own identical search path, and
-- `regprocedureout` is `format_procedure` — literally the same C function
-- PL/pgSQL used to label the frame — so it renders that string rather than a
-- hand-kept copy that can drift. A missing function makes it NULL, and NULL is
-- treated as a refusal rather than as a pass: `position(x in y)` is NULL when
-- either side is, and `IF NULL = 0` is false, so the obvious spelling would have
-- been a guard that opens when the door it names is gone.
--
-- ## What this does not claim
--
-- Triggers are skipped by `session_replication_role = replica` and by
-- `ALTER TABLE … DISABLE TRIGGER`, both of which need the table's owner. So the
-- honest statement, and the one the comments now make, is: **these rules bind
-- every caller, including one that fakes the call stack; they do not bind an
-- operator who turns triggers off.** That is strictly stronger than "the only
-- function that can put a row in this table" was, and unlike it, it is true.
--
-- That sentence survived r7's gauntlet intact and is worth keeping separate from
-- the one above it that did not: the r7 critic tested all five invariants and the
-- doorbell **using defect 1 as the vehicle** — the strongest available faked
-- frame — and every one of them held. What defect 1 falsifies is the guard's
-- claim, not the invariants'. See `0009`.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. The invariants, as a BEFORE INSERT trigger on the table
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every rule here was inside `atrium_append_core_event` until this migration and
-- is byte-for-byte the same rule; what changed is who has to pass it. The
-- `CONSTRAINT` names on the exceptions are unchanged too, so every test that
-- named one still names the same refusal.
--
-- `SET search_path = pg_catalog, pg_temp` with a fully qualified body, for the
-- reason in the header and one more: a trigger function that resolved
-- `memberships` through the *inserting session's* search path could be pointed at
-- an attacker's table by the same caller it exists to constrain.
--
-- Trigger firing order is by name, so `core_events_append_guard` runs first and
-- this runs second: a direct INSERT is still refused by the guard's message
-- rather than by whichever invariant it happened to violate as well.
--
-- `CREATE OR REPLACE`, where the append function below is DROP + CREATE. The
-- reason for the difference is the reason 0005–0007 give for that rule: `CREATE
-- OR REPLACE` with a different parameter list creates an **overload**, a second
-- door satisfying every name-based guard while doing none of the work. A trigger
-- function has exactly one possible signature — `() RETURNS trigger` — so there
-- is no parameter list to change and no overload to create. It also makes this
-- function restorable in place, which is what lets the mutant ledger revert it
-- from this file rather than from a copy (`mutants/run.mjs`).
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
BEGIN
  -- (a) Membership, for the writer that claims to be a person.
  --
  -- A model or the system actor is not a room member and cannot be: those are
  -- server-side identities, and reaching the append function at all requires
  -- EXECUTE, which only the application role holds. The room check for them is
  -- the grant.
  IF NEW."actor_kind" = 'human' THEN
    IF NEW."actor_id" !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION
        'human actor "%" is not a user id; core_events may not be appended to on behalf of an identity that cannot be a member of a room', NEW."actor_id"
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
  NEW."trusted_messages" := public."atrium_receipt_window"(NEW."room_id", NEW."actor_kind", NEW."payload");

  RETURN NEW;
END;
$invariants$;--> statement-breakpoint

CREATE TRIGGER "core_events_invariants"
  BEFORE INSERT ON "core_events"
  FOR EACH ROW EXECUTE FUNCTION "atrium_core_events_invariants"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_core_events_invariants"() IS
  'Every append rule that is about more than one row, enforced on the table rather than in the function that is supposed to be the only door: the human actor''s membership, the room a room-less kind resolves to from the row that minted its subject, the canonical (at, id) order, and the two derived columns — room_seq and trusted_messages — which are overwritten here rather than taken from the caller. Binds every writer, including one whose call stack lies about which function it is (#22 gauntlet r6, major 3). Does not bind an operator who disables triggers; that is the same limit 0003 states.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. The doorbell, as an AFTER INSERT trigger
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Postgres queues notifications and delivers them at commit, so this can neither
-- precede nor outlive the row it is about. The payload is a position and an
-- origin, never an event body: the receiver reads the row out of the ledger,
-- because it has to fold it anyway and a relayed copy is a second history free to
-- disagree with the first.
--
-- `origin` is how an instance ignores the echo of its own commit, and it is not a
-- column, so it travels in a transaction-local GUC. The doorbell **consumes** it:
-- read, then cleared. Without that, a direct INSERT that followed an append in
-- the same transaction would inherit the append's origin and be ignored by the
-- one instance that most needs to fold it. Cleared, an unnamed writer announces
-- `null`, which matches no instance, so everybody folds it.
CREATE OR REPLACE FUNCTION "atrium_core_events_doorbell"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $doorbell$
DECLARE
  v_origin text;
BEGIN
  v_origin := nullif(current_setting('atrium.origin', true), '');
  PERFORM set_config('atrium.origin', '', true);
  PERFORM pg_notify('atrium_ledger', json_build_object(
    'origin', v_origin,
    'roomId', NEW."room_id",
    'seq', NEW."seq",
    'roomSeq', NEW."room_seq"
  )::text);
  RETURN NULL;
END;
$doorbell$;--> statement-breakpoint

CREATE TRIGGER "core_events_doorbell"
  AFTER INSERT ON "core_events"
  FOR EACH ROW EXECUTE FUNCTION "atrium_core_events_doorbell"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_core_events_doorbell"() IS
  'Rings atrium_ledger for every row that reaches core_events, from the table rather than from the append function, so a writer that is not this application cannot land a row silently. The origin comes from the transaction-local GUC atrium.origin and is consumed on read; a writer that did not set one announces null, which matches no instance and is therefore folded by all of them. The origin is not an identity — it is whatever the caller passed as p_origin — and a spoofed one costs one instance latency rather than delivery, because the reconciler folds on a timer regardless.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 3. The guard, matching a signature no other schema can render
-- ─────────────────────────────────────────────────────────────────────────────
--
-- See the header for the mechanism. Two changes:
--
--  * the expected signature is `to_regprocedure(…)::text`, evaluated under this
--    function's own `search_path = pg_catalog, pg_temp`, which is the same path
--    the append function compiles under. `regprocedureout` *is* `format_procedure`
--    — the same C function PL/pgSQL used to build the stack frame — so this
--    renders the identical string rather than a hand-kept copy of it that can
--    drift. (Note what that means in practice: the rendered text says `timestamp
--    with time zone` where the source says `timestamptz`, and neither side had to
--    know that.) If the two ever did disagree the guard would refuse every
--    append, which is the loud direction.
--  * a NULL on **either** side is a refusal. `position(x in y)` is NULL when
--    either argument is, and `IF NULL = 0` takes the false branch, so the obvious
--    spelling is a guard that opens when the door it names is missing — and, as a
--    second lineage pointed out about r7's own first draft, also one that opens if
--    the call stack ever comes back NULL. Refusing on the expectation alone was
--    half a fix for a fail-open, inside the migration that exists to close one.
CREATE OR REPLACE FUNCTION "atrium_core_events_append_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE
  v_context text;
  v_expected text;
  v_locked boolean;
BEGIN
  -- PG_CONTEXT is the live plpgsql call stack. It cannot be set, faked or
  -- passed in by the caller. What it *could* be, until this migration, was
  -- collided with: it names each frame by the signature PL/pgSQL compiled, and
  -- an unqualified name is one any schema can claim.
  GET DIAGNOSTICS v_context = PG_CONTEXT;
  v_expected := to_regprocedure(
    'public.atrium_append_core_event(uuid,text,public.event_type,public.actor_kind,text,jsonb,timestamptz,text)')::text;
  -- `coalesce(…, 0)` and the explicit NULL test on the context, not just on the
  -- expectation. `position(x in y)` is NULL when EITHER side is, and `IF NULL`
  -- takes the false branch — so the natural spelling refuses on a missing
  -- function and *passes* on a missing call stack. Both are refusals here
  -- (#22 gauntlet r7 self-review, second lineage).
  IF v_expected IS NULL
     OR v_context IS NULL
     OR coalesce(position('function ' || v_expected || ' line ' in v_context), 0) = 0 THEN
    RAISE EXCEPTION
      'core_events is append-only through atrium_append_core_event(); a direct INSERT bypasses canonical minting, the reducer and the append lock'
      USING ERRCODE = '42501', CONSTRAINT = 'core_events_append_through_procedure';
  END IF;

  -- classid/objid are how Postgres stores a bigint advisory key: the high 32
  -- bits in classid, the low 32 in objid. 1096045106 fits in 32 bits, so
  -- classid is 0. objsubid 1 marks the single-argument (bigint) form.
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks
    WHERE locktype = 'advisory'
      AND pid = pg_backend_pid()
      AND classid = 0
      AND objid = 1096045106
      AND objsubid = 1
      AND granted
  ) INTO v_locked;
  IF NOT v_locked THEN
    RAISE EXCEPTION
      'the ledger advisory lock is not held by this transaction; core_events may not be appended to without it'
      USING ERRCODE = '55000', CONSTRAINT = 'core_events_append_lock_held';
  END IF;

  RETURN NEW;
END;
$guard$;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 4. The append function, with the rules taken out of it
-- ─────────────────────────────────────────────────────────────────────────────
--
-- What is left is the door and nothing else: take the ledger lock, name the
-- instance for the doorbell, insert, and report the positions the table assigned.
-- `room_seq` and `trusted_messages` are not passed — the trigger mints and
-- derives them — and both come back out of the row by `RETURNING`, so "the append
-- returns what was stored" is a property of the statement rather than an argument
-- about the body.
--
-- `SET search_path = pg_catalog, pg_temp` is load-bearing twice: it is what makes
-- the compiled signature schema-qualified (see the header), and it is what stops
-- an attacker-controlled search path from resolving `core_events` to something
-- else inside a SECURITY DEFINER function that runs as the table's owner. Every
-- reference in the body is therefore qualified.
--
-- Replaced by DROP + CREATE rather than CREATE OR REPLACE, for the reason 0005,
-- 0006 and 0007 all give: Postgres cannot change a parameter list in place and
-- `CREATE OR REPLACE` with a different one creates an **overload** — a second door
-- that satisfies every name-based guard while doing none of the work. The
-- parameter list is unchanged here, and the rule is kept anyway, because "we
-- happened not to change the arguments this time" is not a property anybody can
-- check at the next edit.
DROP FUNCTION IF EXISTS "atrium_append_core_event"(uuid, text, "event_type", "actor_kind", text, jsonb, timestamptz, text);--> statement-breakpoint

CREATE FUNCTION "atrium_append_core_event"(
  p_room_id uuid,
  p_event_id text,
  p_type "event_type",
  p_actor_kind "actor_kind",
  p_actor_id text,
  p_payload jsonb,
  p_occurred_at timestamptz,
  p_origin text DEFAULT NULL
) RETURNS TABLE ("seq" bigint, "room_seq" bigint, "trusted_messages" jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $append$
DECLARE
  v_room_seq bigint;
  v_seq bigint;
  v_stored jsonb;
BEGIN
  -- `0x41545232` = 1096045106 — "ATR2". Duplicated in apps/server/src/ledger.ts
  -- as LEDGER_ADVISORY_LOCK_KEY, and an integration test reads this function's
  -- deployed body and asserts the two agree: r1 shipped a hand-conversion typo
  -- where the migration took 1096041522 and the server took 1096045106, both
  -- took *a* lock, neither ever contended, and every single-process test stayed
  -- green while the mutual-exclusion guarantee was simply absent.
  PERFORM pg_advisory_xact_lock(1096045106::bigint);

  -- Named for the doorbell, which consumes it. Transaction-local, so it cannot
  -- outlive the append it belongs to even if the transaction goes on.
  PERFORM set_config('atrium.origin', coalesce(p_origin, ''), true);

  -- `room_seq` and `trusted_messages` are absent from the column list on purpose:
  -- they are the two values a caller must not be able to choose, and the way to
  -- express that is not to give this function a way to express them either.
  INSERT INTO public."core_events" ("room_id", "id", "type", "actor_kind", "actor_id", "payload", "occurred_at")
  VALUES (p_room_id, p_event_id, p_type, p_actor_kind, p_actor_id, p_payload, p_occurred_at)
  RETURNING "core_events"."seq", "core_events"."room_seq", "core_events"."trusted_messages"
  INTO v_seq, v_room_seq, v_stored;

  "seq" := v_seq;
  "room_seq" := v_room_seq;
  -- The values that are IN the row, so the server's comparison is between what it
  -- folded under and what a replay will read — see the note on that comparison in
  -- apps/server/src/ledger.ts, which states precisely what it does and does not
  -- prove.
  "trusted_messages" := v_stored;
  RETURN NEXT;
END;
$append$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_append_core_event"(uuid, text, "event_type", "actor_kind", text, jsonb, timestamptz, text) IS
  'The door onto core_events, and the only one a REVOKE can control: takes the ledger advisory lock, names this instance for the doorbell, inserts, and returns the positions and the receipt window the TABLE assigned by RETURNING. It is no longer where the append rules live — membership, the room a room-less kind resolves to, the canonical order, room_seq and the receipt window are all enforced by the core_events_invariants trigger, so a caller that gets past core_events_append_guard is still not past the rules (#22 gauntlet r6, major 3). Neither room_seq nor the receipt window is a parameter; a caller cannot supply either. EXECUTE is revoked from PUBLIC and granted to the table owner plus every non-superuser LOGIN role that already holds SELECT on core_events — which is how 0004 identifies the application role without being told its name, and which means a read-only login role granted SELECT before this migration also gets the door. See the privileges block below. Privileged bypasses (session_replication_role, ALTER TABLE ... DISABLE TRIGGER, pg_restore --disable-triggers) are operator territory and out of scope.';--> statement-breakpoint

-- ── privileges: re-granted for the recreated function ────────────────────────
--
-- A dropped function takes its grants with it, so these are not decoration:
-- without them the door 0004 locked would be reopened by the default, which for
-- a freshly created function is EXECUTE to PUBLIC. `atrium_receipt_window` was
-- not dropped by this file and keeps the grants 0006 and 0007 gave it; it is
-- re-granted below anyway, because a privileges block that covers only what this
-- migration happened to touch is one that has to be re-read at every edit.
REVOKE EXECUTE ON FUNCTION "atrium_append_core_event"(uuid, text, "event_type", "actor_kind", text, jsonb, timestamptz, text) FROM PUBLIC;--> statement-breakpoint

DO $privileges$
DECLARE
  v_owner name;
  v_role name;
  v_append text := 'public.atrium_append_core_event(uuid, text, event_type, actor_kind, text, jsonb, timestamptz, text)';
  v_window text := 'public.atrium_receipt_window(uuid, actor_kind, jsonb)';
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = 'core_events' AND n.nspname = 'public';

  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_append, v_owner);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_window, v_owner);

  -- Every non-superuser login role the r2 migration had already treated as an
  -- app role: it revoked their direct INSERT and granted them the function. They
  -- keep the two functions and nothing else.
  --
  -- **This heuristic is "holds SELECT on core_events", and it is wider than "the
  -- application role"** (#22 gauntlet r6 self-review, found by a foreign-lineage
  -- reviewer). A read-only login role created before this migration — an auditor,
  -- a metrics scraper — matches it and comes out the other side able to call the
  -- append function and write a `system`-actor event into any room it can name.
  -- The COMMENT above said "granted to the application role only" until r7, which
  -- was the same false-sentence class this round exists to close.
  --
  -- Kept as it is rather than narrowed, deliberately: this loop is how 0004
  -- identified the app role in the first place, a migration cannot be told that
  -- role's name, and narrowing it here would silently lock out any deployment
  -- whose app role this heuristic is currently what grants. Routed instead, and
  -- pinned meanwhile by `grants the door to exactly the roles its own heuristic
  -- names` in `integration/db/ledger-constraints.test.ts`, which runs this rule
  -- against a real role rather than restating it.
  FOR v_role IN
    SELECT r.rolname FROM pg_roles r
    WHERE r.rolcanlogin
      AND NOT r.rolsuper
      AND r.rolname <> v_owner
      AND has_table_privilege(r.rolname, 'public.core_events', 'SELECT')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_append, v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_window, v_role);
  END LOOP;
END;
$privileges$;
