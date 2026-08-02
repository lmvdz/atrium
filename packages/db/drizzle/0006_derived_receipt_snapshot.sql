-- ─────────────────────────────────────────────────────────────────────────────
-- issue #22, gauntlet round 5 — the receipt snapshot is DERIVED at the append
-- boundary, and the append surface is audited for everything else that was
-- trusted because of where it landed.
--
-- ## 1. THE FINDING, AND WHY IT IS THE THIRD OF ITS SHAPE
--
--   > `0005…sql:152` validates only the *shape* of `trusted_messages` and `:261`
--   > inserts `p_trusted_messages` verbatim; nothing proves the snapshot matches
--   > the event's payload, room, or source messages. A direct caller of the
--   > granted append function supplies a fabricated but well-formed receipt
--   > window and every fold trusts it.
--
-- Every clause is true, and the finding's own generalisation is the one worth
-- carving into this file rather than into a review comment:
--
--   **Trust follows derivation, not location.**
--
-- Round 3 moved the actor out of the payload into a column, and it was still
-- forgeable until the command layer *derived* it from the authenticated session.
-- Round 4 moved the receipt window out of the mutable `messages` table into an
-- immutable column, and it was still forgeable because the boundary *accepted*
-- it. Both moves were correct and neither was sufficient, for the same reason: a
-- trusted location holding an untrusted value is a longer path to the same
-- defect.
--
-- The practical test, applied to every argument below: **could a direct caller of
-- this function supply a well-formed lie?** For `p_trusted_messages` the answer
-- was yes, so the argument is gone. It is not validated, not cross-checked, not
-- defaulted — **removed**, because an argument that exists can be passed, and the
-- next caller will pass it.
--
-- `atrium_receipt_window` below is the whole derivation, and it is the *only*
-- derivation: the server calls it to obtain the window it folds under, the append
-- function calls it again to obtain the window it stores, and the function
-- returns what it stored so the server can refuse the append if the two ever
-- disagree. One rule, in one language, checked at the seam.
--
-- ## 2. THE AUDIT OF THE REST OF THE APPEND SURFACE
--
-- Every argument this function still takes, against the same question. Written
-- here because the next person adding an argument needs the rule and the verdicts,
-- not just this round's fix.
--
--   · `p_room_id` — **was a lie a caller could tell, and now is not.** Nothing
--     compared it to the room the payload itself declares. A direct caller could
--     write an `object_accepted` whose `object.roomId` is room B into `room_id =
--     A`: the fan-out reads the column and delivers it to A's subscribers, the
--     fold reads the payload and puts the object in B, and `since(A, n)` serves a
--     row that folded into another room. `core_events_payload_room_matches` (added
--     below) makes the two the same value by constraint, for the four event kinds
--     that declare a room; the three that name a subject instead resolve their room
--     from state, which is `resolveRoomId` in `ledger.ts` and cannot be expressed
--     here. The membership check and every composite `(room_id, …)` FK already
--     used the column, so this closes the last way the two could disagree.
--
--   · `p_actor_kind` / `p_actor_id` — derived from the authenticated session by
--     the command layer (#21's contract) and, for a human, re-authorized here
--     against `memberships` under a `FOR SHARE` row lock. A caller that is not the
--     command layer cannot name a human it is not; it *can* name any `model` or
--     `system` identity, and that is deliberate and unchanged: those are
--     server-side identities with no membership to check against, so **the EXECUTE
--     grant is their authorization**, as 0004's header says. Stated again here
--     because "the grant is the check" is exactly the kind of claim that should
--     not have to be rediscovered.
--
--   · `p_event_id` — pinned to the payload by `core_events_payload_id_matches`,
--     unique by `core_events_id_key`, and gated by canonical order below. A caller
--     may choose it; it cannot choose one that replays differently, and choosing a
--     bad one only costs the caller its own append.
--
--   · `p_type` — pinned to the payload by `core_events_payload_type_matches`.
--
--   · `p_occurred_at` — pinned to the payload by `core_events_payload_at_matches`
--     and to one spelling by `core_events_payload_at_is_canonical_utc`. It is
--     redundant with `p_payload->>'at'` and it is kept rather than derived,
--     deliberately: a disagreeing row is *unrepresentable*, so this is not a value
--     a caller can lie about, and the constraint that says so is reachable through
--     this function — which is what makes it a tested guarantee rather than an
--     argued one. Deriving it would delete the test along with the argument.
--
--   · `p_payload` — the event itself, structurally checked (id, type, `at`
--     spelling, `at`/`occurred_at` equality, no actor, room). Full `CoreEvent`
--     schema validation stays in TypeScript on purpose; see 0004's header.
--
--   · `p_origin` — the doorbell's "who appended this", used only so an instance
--     can ignore the echo of its own commit. A caller naming somebody else's
--     instance id costs that instance one skipped notification and nothing else:
--     the reconciler's timer is the durable delivery path and the doorbell only
--     decides *when* it runs (r2 delta). NULL matches no instance, so an appender
--     that does not name itself wakes everyone — the safe direction.
--
--   · `room_seq` and `seq` — not arguments at all. Minted here, under the lock.
--
-- **The rule for the next argument:** an argument may be trusted only if the
-- boundary recomputes it, or a constraint makes a disagreeing row
-- unrepresentable. "It lands in a trusted column" is not a reason.
--
-- ## 3. THE ID CHARSET CHECK WAS COLLATION-DEPENDENT (r4 delta, major)
--
--   > Postgres bracket ranges are collation-dependent, so `[!-~]` without
--   > `COLLATE "C"` is not a durable ASCII guarantee, and the `prosrc`/`indexdef`
--   > structural pin covers the function and index but not this CHECK.
--
-- Correct on both halves. A regex range is resolved in the collation of its
-- input, so `[!-~]` means "printable ASCII" only where the collation is byte
-- order; under an ICU or a generated glibc locale it means "everything that sorts
-- between `!` and `~`", which includes accented letters and, depending on the
-- locale, a great deal else. The CHECK is re-created below with `COLLATE "C"` on
-- the subject, which is the same collation the append gate and the canonical
-- index already use — the point of the whole subset being that one order is
-- evaluated by two engines.
--
-- The pin is extended in `integration/db/ledger-constraints.test.ts` to read this
-- constraint's deployed `pg_get_constraintdef` alongside the function's `prosrc`
-- and the index's `indexdef`, for the reason r4 gave about the other two: the
-- compose image's `en_US.utf8` behaves as byte order, so **no behavioural test in
-- this suite can see the difference**, and a guarantee that is absent while all
-- the evidence says it is present is the r1 advisory-lock bug exactly.
--
-- ## 4. THE FK AUDIT FROM 0005, CORRECTED
--
-- 0005's audit listed `attention_items.created_by`. There is no such column —
-- the field is `attention_items.user_id`, and it is `ON DELETE CASCADE`, not
-- `SET NULL`. So the row was wrong twice, which is the point of the finding: an
-- audit with a stale row is evidence of nothing, and there is no way to tell from
-- reading it which of the other rows are also wrong.
--
-- The whole table was therefore re-derived rather than patched, and it is no
-- longer a prose list anybody has to keep in step:
-- `integration/db/ledger-constraints.test.ts` reads `pg_constraint` on the
-- deployed database, enumerates every foreign key whose delete action is not
-- `NO ACTION`, and compares that set against a literal list. A schema change that
-- adds or retypes one fails that test, which is what makes the audit below true
-- for longer than the day it was written.
--
-- The corrected audit, derived from the catalog:
--
-- **`ON DELETE SET NULL` — eight, and every one is a projection column:**
--   · `messages.author_id → users.id` — the r3-delta defect. Fed the receipt
--     window; now derived into the snapshot at append and never read by a fold.
--   · `rooms.created_by → users.id`
--   · `proposals.proposer_user_id → users.id`
--   · `proposals.decided_by → users.id`
--   · `proposals.interpretation_id → interpretations.id`
--   · `accepted_objects.accepted_by → users.id`
--   · `relations.created_by → users.id`      ← absent from 0005's audit entirely
--   · `corrections.by_user_id → users.id`
--   Each is written *from* the ledger row's trusted actor columns and read back
--   for display. The authority lives in `core_events.actor_kind` / `actor_id`,
--   which have no FK to `users` at all — deliberately, and that is why deleting a
--   user cannot rewrite who did something.
--
-- **`ON DELETE CASCADE` — three groups, none of which reaches a fold:**
--   · `*.room_id → rooms.id` (`memberships`, `messages`, `core_events`,
--     `proposals`, `proposal_sources`, `accepted_objects`, `object_sources`,
--     `relations`, `attention_items`, `corrections`). Deleting a room deletes its
--     ledger in the same statement: the room is gone, not misremembered. This is
--     the one cascade that reaches `core_events`, and it removes the rows rather
--     than mutating them.
--   · `*.user_id → users.id` on `memberships` and `attention_items` — per-person
--     rows, not history. A deleted user's membership and their attention queue go
--     with them; nothing folds either.
--   · the provenance *link* tables and their composite edges:
--     `interpretations.message_id`, `object_sources.*`, `proposal_sources.*`,
--     `relations.*`, `attention_items.*`, `corrections.*`. The reducer reads
--     `payload.provenance.messageIds`, inside the immutable payload, so these are
--     projections: a lost row is a lost join, not a lost verdict.
--
-- **No delete action at all (`NO ACTION`):** every remaining composite
--   `(room_id, …)` key, `messages.reply_to_id` among them. `schema.ts` gives the
--   reason: `SET NULL` would null *every* referencing column including the NOT
--   NULL `room_id`, so it could only ever fail.
--
-- **The rule, unchanged and now with one more instance behind it:** a column may
-- be `SET NULL`/`CASCADE` if and only if nothing downstream of `reduce` reads it.
-- Everything a fold or a receipt check reads must be inside the event payload or
-- inside a snapshot column on the event's own row — and that snapshot must be
-- *derived* here, not accepted.
--
-- **Operator territory, unchanged and still out of scope.** A superuser who sets
-- `session_replication_role = replica`, or restores with
-- `pg_restore --disable-triggers`, bypasses the append-only trigger and could
-- write a snapshot this function never derived. That is the same admitted
-- boundary 0004 and 0005 state in their own headers, and this migration claims
-- nothing beyond it. The shape CHECK on `trusted_messages` is kept for exactly
-- that reader: it is the last thing standing between a bypassing writer and a
-- window no replay can parse.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── the `at` spelling: one pattern, not two rules that agree (r4 delta, major) ─
--
--   > `at` type/CHECK parity is false — `z.iso.datetime({ offset: true })`
--   > accepts non-`Z` offsets and other spellings while the CHECK accepts only
--   > `…SS.mmmZ`, so "one ISO spelling on both sides" does not hold.
--
-- @atrium/core's `Timestamp` is now the pattern below, and `schema.ts`
-- interpolates `CANONICAL_TIMESTAMP.source` rather than restating it — one
-- pattern, evaluated by two engines that read `\d`, `{n}` and `(?:…)` the same
-- way. It is calendar-aware where r4's was shape-only: `2026-13-45T25:00:00.000Z`
-- satisfied `[0-9]{2}` on both counts and then failed at the `::timestamptz` cast
-- in `core_events_payload_at_matches`, as a cast error rather than as a named
-- constraint. That is a parity failure too, and a quieter one.
ALTER TABLE "core_events" DROP CONSTRAINT "core_events_payload_at_is_canonical_utc";--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_payload_at_is_canonical_utc" CHECK ("core_events"."payload"->>'at' ~ '^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|02-(?:0[1-9]|1\d|2[0-8])))T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$');--> statement-breakpoint

-- ── the charset check, in the collation it always meant ──────────────────────
ALTER TABLE "core_events" DROP CONSTRAINT "core_events_id_is_safe_to_order";--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_id_is_safe_to_order" CHECK (("core_events"."id" COLLATE "C") ~ '^[!-~]+$' AND length("core_events"."id") <= 256);--> statement-breakpoint

-- ── the lifted room may not disagree with the declared one ───────────────────
--
-- Four of the eight ledger event kinds declare their room inside the payload
-- (`proposal.roomId`, `object.roomId`, `relation.roomId`, and the bare `roomId`
-- that `message_posted` and `attention_resolved` carry). The other three name a
-- proposal or an object instead and take their room from state, which is a
-- question only the reducer can answer — so the check is written to be *total*:
-- when no path yields a room, `coalesce` falls through to the column itself and
-- the comparison holds trivially.
--
-- This will refuse to install over a row that already lies, and that is the
-- correct way to find out that one exists.
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_payload_room_matches" CHECK ("core_events"."room_id"::text = coalesce("core_events"."payload"->'proposal'->>'roomId', "core_events"."payload"->'object'->>'roomId', "core_events"."payload"->'relation'->>'roomId', "core_events"."payload"->>'roomId', "core_events"."room_id"::text));--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 5. The derivation, as a function both callers share
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The window a receipt is checked against, as a pure function of the row: the
-- room it lands in, the actor kind it was appended under, and the payload's own
-- `object.provenance.messageIds`. Nothing a caller says beyond the row itself.
--
-- Three properties are load-bearing and each was a decision:
--
--  1. **Room-scoped.** `WHERE m.room_id = p_room_id`. The TypeScript version this
--     replaces looked messages up by id alone, so a model acceptance in room A
--     could be handed the text of a message from room B — the `TrustedContext`
--     doc in @atrium/core says "the room's own message table" and the derivation
--     did not say it. `object_sources` already refuses the cross-room citation at
--     projection time through a composite FK; this makes the *window* refuse it
--     too, which matters because the window is what the receipt is checked
--     against and the projection runs afterwards.
--  2. **`ORDER BY m.seq`.** The window is durable, so its order may not depend on
--     which plan the planner chose. It matters to the reducer as well: a quote
--     carried by several cited messages is reported against the first match, and
--     "first" must be the room's order.
--  3. **NULL and `[]` are different answers.** NULL means no window was called
--     for (a human actor, a non-acceptance, an acceptance citing nothing) and #21's
--     reducer reports that differently from an empty window. Collapsing them would
--     make a replay report a different reason than the live append did.
--
-- Total by construction: a payload whose `messageIds` is missing, null, or not an
-- array yields NULL rather than raising, because this function runs inside the
-- append and a raise here would be a failure mode reachable from a payload.
-- `STABLE` rather than `IMMUTABLE`: it reads a table.
CREATE FUNCTION "atrium_receipt_window"(
  p_room_id uuid,
  p_actor_kind "actor_kind",
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $window$
DECLARE
  v_ids jsonb;
  v_window jsonb;
BEGIN
  -- A person reading the room is the receipt; #21's reducer asks for no window.
  IF p_actor_kind = 'human' THEN
    RETURN NULL;
  END IF;
  -- `object_accepted` is the only kind with a receipt to check.
  IF p_payload->>'type' IS DISTINCT FROM 'object_accepted' THEN
    RETURN NULL;
  END IF;
  v_ids := p_payload->'object'->'provenance'->'messageIds';
  IF v_ids IS NULL OR jsonb_typeof(v_ids) <> 'array' OR jsonb_array_length(v_ids) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', m."id"::text,
        -- A message whose author was deleted keeps its text and loses its name.
        -- Empty rather than the id of nobody: attribution to '' matches no actor,
        -- which is the conservative reading the receipt checks want. Snapshotted
        -- here, so it is a fact about the moment of the append and not about today.
        'authorId', coalesce(m."author_id"::text, ''),
        'body', m."body"
      )
      ORDER BY m."seq"
    ),
    '[]'::jsonb
  )
  INTO v_window
  FROM "messages" m
  WHERE m."room_id" = p_room_id
    AND m."id"::text IN (SELECT jsonb_array_elements_text(v_ids));

  RETURN v_window;
END;
$window$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_receipt_window"(uuid, "actor_kind", jsonb) IS
  'The receipt window a ledger row folds under, derived from the row itself: room-scoped, ordered by the room''s own message order, NULL when no window is called for. The only derivation — atrium_append_core_event calls it to write the snapshot and apps/server/src/ledger.ts calls it to fold under the same value, and the append returns what it stored so the two can be compared rather than assumed.';--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION "atrium_receipt_window"(uuid, "actor_kind", jsonb) FROM PUBLIC;--> statement-breakpoint

-- ── heal whatever the forgeable boundary let through ─────────────────────────
--
-- Every existing snapshot is re-derived from its own row. On a fresh database
-- this touches nothing; on one that ran 0005's boundary it replaces any window a
-- caller supplied with the one the row's payload actually implies, which is the
-- only way the guarantee applies to the whole table rather than to rows appended
-- from here on.
--
-- The append-only trigger from 0003 raises on any UPDATE, including this one —
-- the trigger doing its job. Disabled for exactly this statement and re-enabled
-- in the same transaction, visibly, as 0004 and 0005 both do.
ALTER TABLE "core_events" DISABLE TRIGGER "core_events_no_update";--> statement-breakpoint
UPDATE "core_events" e
SET "trusted_messages" = "atrium_receipt_window"(e."room_id", e."actor_kind", e."payload")
WHERE e."trusted_messages" IS DISTINCT FROM "atrium_receipt_window"(e."room_id", e."actor_kind", e."payload");--> statement-breakpoint
ALTER TABLE "core_events" ENABLE TRIGGER "core_events_no_update";--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 6. The append function, with one fewer thing to lie about
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Replaced by DROP + CREATE rather than CREATE OR REPLACE, for the reason 0005
-- gives: Postgres cannot change a parameter list in place, and `CREATE OR
-- REPLACE` with a different one creates an **overload** — a second door that
-- satisfies every name-based guard while doing none of the work, which is the r2
-- finding. There is one `atrium_append_core_event`, and after this file there is
-- still one.
DROP FUNCTION IF EXISTS "atrium_append_core_event"(uuid, text, "event_type", "actor_kind", text, jsonb, timestamptz, jsonb, text);--> statement-breakpoint

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
  -- CHECK — itself now `COLLATE "C"`, so its charset range means ASCII on every
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

  INSERT INTO "core_events" ("room_id", "room_seq", "id", "type", "actor_kind", "actor_id", "payload", "occurred_at", "trusted_messages")
  VALUES (p_room_id, v_room_seq, p_event_id, p_type, p_actor_kind, p_actor_id, p_payload, p_occurred_at, v_window)
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
  -- Returned so the caller can compare it with the window it folded under. The
  -- server derives its own from the same function in the same transaction, and
  -- refuses the append if the two differ — which turns "both callers get the same
  -- answer" from an argument about the code into a checked invariant.
  "trusted_messages" := v_window;
  RETURN NEXT;
END;
$append$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_append_core_event"(uuid, text, "event_type", "actor_kind", text, jsonb, timestamptz, text) IS
  'The only way a row reaches core_events, and the authorization boundary in front of it: takes the ledger advisory lock, authorizes the actor''s membership, refuses anything that does not sort strictly after the canonical cursor, DERIVES the receipt window from the row''s own payload and room, mints room_seq, inserts, rings the cross-instance doorbell, and returns the window it stored. The window is not a parameter — a caller cannot supply one. EXECUTE is granted to the application role only. Privileged bypasses (session_replication_role, pg_restore --disable-triggers) are operator territory and out of scope.';--> statement-breakpoint

-- ── privileges: re-granted for the new signature ─────────────────────────────
--
-- A dropped function takes its grants with it, so these are not decoration:
-- without them the door this branch locked in 0004 would be reopened by the
-- default, which for a freshly created function is EXECUTE to PUBLIC. The
-- derivation function is granted to the same roles for the same reason — the
-- server calls it directly to fold under the value the boundary will store.
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
