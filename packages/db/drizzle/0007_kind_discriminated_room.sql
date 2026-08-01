-- ═════════════════════════════════════════════════════════════════════════════
-- 0007 — the room a row lands in is discriminated by the event's KIND
--
-- Round 5 of #22's gauntlet, blocking. Round 5 closed "the lifted `room_id` may
-- not disagree with the payload" with a `coalesce` over every nested room key any
-- member of the union might carry. That is a check that *some* member's shape is
-- satisfied; it is not a check that **this** member's is.
--
--   > `coalesce(payload->'proposal'->>'roomId', payload->'object'->>'roomId', …)`
--   > takes whichever key appears first in its list, JSONB accepts extra keys,
--   > and Zod strips them only after the row exists.
--
-- The exploit is one key. Append an `object_accepted` into `room_id = B` whose
-- `object.roomId` really is room A, and hang an extra `proposal: {"roomId": B}`
-- off the payload. The coalesce reaches `proposal.roomId` first, reads B, and the
-- row installs. Fan-out then uses the column (B), the fold uses `object.roomId`
-- (A), and `since(B, n)` serves a row that folded into another room — the exact
-- divergence 0006 claimed to have closed, reopened by the *shape* of the fix.
-- The smuggled key never has to be meaningful: `reduce` never looks at it, and
-- Zod strips it on the way back out, so nothing downstream ever reports it.
--
-- ## The class, because this is the fourth round to meet it in a new costume
--
-- #21 put the actor in a trusted argument and derived nothing. r3 put the receipt
-- window in a trusted table. r4 put it in an immutable column. r5 fixed all of
-- those by *deriving* the value — and then wrote this one guard by asking "is
-- there a room key that matches?" instead of "does this kind's room key match?".
--
--   **Validate a union by its tag, not by key presence.**
--
-- A `coalesce`/`OR` across the members of a discriminated union answers a
-- question nobody asked. The tag is the only thing that says which member's rule
-- applies, so the tag has to be read first, and every *other* member's shape has
-- to become a refusal rather than an alternative.
--
-- ## What this file does
--
--  1. Replaces `core_events_payload_room_matches` with a kind-discriminated
--     check: the set of room-bearing keys present must be exactly the set this
--     kind's shape declares, and that key's value must be the row's room.
--  2. Closes the three room-less kinds, which the coalesce satisfied
--     *unconditionally* (the fall-through reached the column, so `room_id = room_id`
--     held for anything). They may now carry no room key at all — and the room
--     they claim is resolved from the ledger inside the append boundary, against
--     the row that minted the subject they name.
--  3. Returns the receipt window by `RETURNING` of the stored column rather than
--     the value the function intended to store, so "the append returns what it
--     stored" is a property of the statement instead of an argument about it.
--
-- Nothing here is new machinery: the constraint is the same CHECK in the same
-- place, and the subject resolution is the same answer `resolveRoomId` gives on
-- the command path (`apps/server/src/ledger.ts`), asked of the durable log
-- instead of the in-memory fold.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. The subject lookups the boundary now runs
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `proposal_rejected` and `proposal_superseded` name a proposal;
-- `object_corrected` names an object. Resolving one back to its room means
-- finding the ledger row that minted it, which without an index is a sequential
-- scan of the whole ledger on every such append. Partial, because only one kind
-- of row can ever be the answer, and expression-indexed on the id the payload
-- carries.
CREATE INDEX "core_events_proposal_subject_idx" ON "core_events" USING btree (("payload"->'proposal'->>'id')) WHERE "core_events"."type" = 'proposal_recorded';--> statement-breakpoint
CREATE INDEX "core_events_object_subject_idx" ON "core_events" USING btree (("payload"->'object'->>'id')) WHERE "core_events"."type" = 'object_accepted';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. The check, discriminated on the kind
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Two clauses, and the first is the one that closes the class.
--
--  1. **Exactly this kind's room keys, and no other kind's.** The array on the
--     left is the set of room-bearing keys actually present in the payload; the
--     `CASE` on the right is the set this kind's shape declares — one element for
--     the five kinds that carry a room, empty for the three that name a subject.
--     A smuggled key from another member's shape makes the sets differ, so it is
--     a refusal rather than an alternative source of truth. There is nothing left
--     to smuggle.
--  2. **That key's value is the row's room.** `IS NOT DISTINCT FROM`, not `=`: a
--     CHECK passes when its expression evaluates to NULL, so `=` against an
--     absent key would admit precisely the rows this exists to refuse.
--
-- `coalesce(…, false)` wraps the pair so an event type this `CASE` does not
-- enumerate **fails closed**. Unreachable today — `type` is an enum and
-- `core_events_payload_type_matches` pins the payload to it — and deliberately
-- kept, so a ninth kind added without a room policy is refused rather than waved
-- through by a NULL.
--
-- A smuggled key whose value is JSON `null` (`"proposal": {"roomId": null}`) is
-- accepted, and that is not a gap: `->>'roomId'` yields SQL NULL either way, so
-- the key carries no room and neither the fan-out nor the fold can read one out
-- of it.
--
-- Like 0006's, this refuses to install over a row that already lies, which is the
-- correct way to find out that one exists. On a fresh database it touches
-- nothing; on one that ran 0006's coalesce it will refuse exactly the rows that
-- exploited it.
ALTER TABLE "core_events" DROP CONSTRAINT "core_events_payload_room_matches";--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_payload_room_matches" CHECK (coalesce(array_remove(ARRAY[
        CASE WHEN "core_events"."payload"->'proposal'->>'roomId' IS NOT NULL THEN 'proposal.roomId' END,
        CASE WHEN "core_events"."payload"->'object'->>'roomId' IS NOT NULL THEN 'object.roomId' END,
        CASE WHEN "core_events"."payload"->'relation'->>'roomId' IS NOT NULL THEN 'relation.roomId' END,
        CASE WHEN "core_events"."payload"->>'roomId' IS NOT NULL THEN 'roomId' END
      ], NULL) = CASE "core_events"."payload"->>'type'
        WHEN 'proposal_recorded' THEN ARRAY['proposal.roomId']
        WHEN 'object_accepted' THEN ARRAY['object.roomId']
        WHEN 'relation_added' THEN ARRAY['relation.roomId']
        WHEN 'message_posted' THEN ARRAY['roomId']
        WHEN 'attention_resolved' THEN ARRAY['roomId']
        WHEN 'proposal_rejected' THEN ARRAY[]::text[]
        WHEN 'proposal_superseded' THEN ARRAY[]::text[]
        WHEN 'object_corrected' THEN ARRAY[]::text[]
      END AND "core_events"."room_id"::text IS NOT DISTINCT FROM CASE "core_events"."payload"->>'type'
        WHEN 'proposal_recorded' THEN "core_events"."payload"->'proposal'->>'roomId'
        WHEN 'object_accepted' THEN "core_events"."payload"->'object'->>'roomId'
        WHEN 'relation_added' THEN "core_events"."payload"->'relation'->>'roomId'
        WHEN 'message_posted' THEN "core_events"."payload"->>'roomId'
        WHEN 'attention_resolved' THEN "core_events"."payload"->>'roomId'
        ELSE "core_events"."room_id"::text
      END, false));--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 3. The append boundary: a room-less kind's room comes from its subject
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The other half of the same finding:
--
--   > Room-less kinds still admit a `room_id` lie via direct SQL:
--   > `proposal_rejected`, `proposal_superseded` and `object_corrected` always
--   > satisfy the CHECK because the coalesce falls through to the column.
--   > `resolveRoomId` covers the command path only.
--
-- A CHECK cannot answer this: "which room is proposal P in" is a fact about
-- *another row*, and a CHECK sees one row. So it is answered here, one layer up,
-- in the only function that can put a row in this table.
--
-- The answer is read from the **ledger**, not from a projection: `proposals` and
-- `accepted_objects` are derived tables written by the server after the append,
-- and a boundary that trusted them would be trusting the thing it exists to
-- authorize. The ledger row that minted the subject is the same fact
-- `resolveRoomId` reads out of the folded `CoreState`, which is that ledger.
--
-- Three outcomes, all refusals, all matching what the command path already does:
-- an unknown subject (`resolveRoomId` throws `unknown proposal`/`unknown object`),
-- a subject that lives in another room (it throws "target belongs to room …"),
-- and — new here, because only a direct caller can create it — a subject minted
-- twice in two different rooms, which is a log no replay can fold and which the
-- boundary refuses rather than arbitrating with a `LIMIT 1`.
--
-- Replaced by DROP + CREATE rather than CREATE OR REPLACE, for the reason 0005
-- and 0006 both give: Postgres cannot change a parameter list in place and
-- `CREATE OR REPLACE` with a different one creates an **overload** — a second
-- door that satisfies every name-based guard while doing none of the work. The
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
SET search_path = public, pg_temp
AS $append$
DECLARE
  v_room_seq bigint;
  v_seq bigint;
  v_max_at timestamptz;
  v_max_id text;
  v_member boolean;
  v_window jsonb;
  v_stored jsonb;
  v_subject text;
  v_subject_rooms uuid[];
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

  -- (b2) The room a ROOM-LESS kind lands in — the r5-delta finding, major 2.
  --
  -- `core_events_payload_room_matches` now refuses these three kinds any room key
  -- at all, so `room_id` is the only thing that says where the row goes and
  -- nothing in a single row can contradict it. The contradiction lives in another
  -- row: the one that minted the proposal or the object this event names. That is
  -- what `resolveRoomId` reads out of the folded state on the command path, and it
  -- is read here out of the log itself, so a caller that never goes through the
  -- server gets the same answer.
  --
  -- `array_agg(DISTINCT …)` rather than a `LIMIT 1`: a subject minted twice in two
  -- rooms is a log no replay can fold, and picking one of the two would make the
  -- boundary the place that decided which. It is refused instead.
  IF p_payload->>'type' IN ('proposal_rejected', 'proposal_superseded') THEN
    v_subject := p_payload->>'proposalId';
    SELECT array_agg(DISTINCT e."room_id") INTO v_subject_rooms
    FROM "core_events" e
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
    IF v_subject_rooms[1] <> p_room_id THEN
      RAISE EXCEPTION
        'proposal "%" belongs to room % but this event was filed into room %; the fan-out and the fold would disagree about where it happened', v_subject, v_subject_rooms[1], p_room_id
        USING ERRCODE = '23514', CONSTRAINT = 'core_events_subject_room_matches';
    END IF;
  ELSIF p_payload->>'type' = 'object_corrected' THEN
    v_subject := p_payload->>'objectId';
    SELECT array_agg(DISTINCT e."room_id") INTO v_subject_rooms
    FROM "core_events" e
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
    IF v_subject_rooms[1] <> p_room_id THEN
      RAISE EXCEPTION
        'object "%" belongs to room % but this event was filed into room %; the fan-out and the fold would disagree about where it happened', v_subject, v_subject_rooms[1], p_room_id
        USING ERRCODE = '23514', CONSTRAINT = 'core_events_subject_room_matches';
    END IF;
  END IF;

  -- (c) The reducer's ordering gate, in SQL. `COLLATE "C"` because the reducer
  -- compares ids with JavaScript's `<`, and the `core_events_id_is_safe_to_order`
  -- CHECK — itself `COLLATE "C"`, so its charset range means ASCII on every
  -- deployment — is what makes those two the same order rather than usually the
  -- same order. The `at` half is `core_events_payload_at_is_canonical_utc`: with
  -- one spelling per instant, string comparison and `timestamptz` comparison agree
  -- on equality as well as on order, so a tie here is a tie there.
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

  -- (e) The receipt window, DERIVED — the round-5 blocking finding. Not an
  -- argument, so there is nothing for a caller to fabricate: it is a function of
  -- the room and the payload this same statement is about to insert.
  v_window := "atrium_receipt_window"(p_room_id, p_actor_kind, p_payload);

  -- Minted under the lock, in the same transaction as the INSERT: an append
  -- that aborts gives its number straight back, so `room_seq` stays contiguous
  -- while the global `seq` (a bigserial, which does not roll back) may gap.
  SELECT coalesce(max(e."room_seq"), 0) + 1 INTO v_room_seq
  FROM "core_events" e
  WHERE e."room_id" = p_room_id;

  -- `RETURNING … "trusted_messages"` rather than reusing `v_window` (r5 delta,
  -- polish). The two are the same value today and there is no behavioural test
  -- that can tell them apart, because nothing sits between the intent and the
  -- row: no BEFORE trigger rewrites this column and no DEFAULT applies to it.
  -- What changes is that "the append returns what it stored" stops being an
  -- argument about the body and becomes a property of the statement — the value
  -- travels out of the row rather than alongside it. An integration test pins the
  -- `RETURNING` structurally, in `prosrc`, and says out loud that it is a
  -- structural pin.
  INSERT INTO "core_events" ("room_id", "room_seq", "id", "type", "actor_kind", "actor_id", "payload", "occurred_at", "trusted_messages")
  VALUES (p_room_id, v_room_seq, p_event_id, p_type, p_actor_kind, p_actor_id, p_payload, p_occurred_at, v_window)
  RETURNING "core_events"."seq", "core_events"."trusted_messages" INTO v_seq, v_stored;

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
  -- The value that is IN the row, so the server's comparison is between what it
  -- folded under and what a replay will read — see the note on that comparison in
  -- apps/server/src/ledger.ts, which states precisely what it does and does not
  -- prove.
  "trusted_messages" := v_stored;
  RETURN NEXT;
END;
$append$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_append_core_event"(uuid, text, "event_type", "actor_kind", text, jsonb, timestamptz, text) IS
  'The only way a row reaches core_events, and the authorization boundary in front of it: takes the ledger advisory lock, authorizes the actor''s membership, resolves a room-less kind''s room from the ledger row that minted the proposal or object it names, refuses anything that does not sort strictly after the canonical cursor, DERIVES the receipt window from the row''s own payload and room, mints room_seq, inserts, rings the cross-instance doorbell, and returns the stored window by RETURNING. The window is not a parameter — a caller cannot supply one. EXECUTE is granted to the application role only. Privileged bypasses (session_replication_role, pg_restore --disable-triggers) are operator territory and out of scope.';--> statement-breakpoint

-- ── privileges: re-granted for the recreated function ────────────────────────
--
-- A dropped function takes its grants with it, so these are not decoration:
-- without them the door 0004 locked would be reopened by the default, which for
-- a freshly created function is EXECUTE to PUBLIC. `atrium_receipt_window` was
-- not dropped by this file and keeps the grants 0006 gave it; it is re-granted
-- below anyway, because a privileges block that covers only what this migration
-- happened to touch is one that has to be re-read at every edit.
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
