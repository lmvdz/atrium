-- ═════════════════════════════════════════════════════════════════════════════
-- 0011 — the receipt window reaches PAST the citations, and stops one message
--        later than the checker reads
--
-- Issue #86, and it is the first defect on this campaign that no branch could
-- have found, because it is not on any branch. Two lanes shipped rules that were
-- each internally consistent, each verified in isolation, and each correct:
--
--   · `fix/realtime-r11` — `atrium_receipt_window` in `0006` defines the window
--     as **exactly the cited messages**, snapshotted at append. Its own header
--     calls that derivation "the whole derivation, and it is the *only*".
--   · `fix/core-engine-r12` — `laterRevision` in `packages/core/src/escalation.ts`
--     refuses any window that **ends at the citations**: "the window carries
--     nothing after the newest message this proposal cites, so the correction
--     scan read no evidence about what came after the quoted sentence — whether
--     a later message takes it back was never established."
--
-- Merged, the SQL cannot produce a window the TypeScript will certify. Every
-- non-human acceptance was refused and the model path was dead. **Git produced
-- no conflict marker**, because the two rules live in different files and
-- different languages, so the tool that would normally flag a contradiction had
-- nothing to flag.
--
-- ## Which side moves, and why it is this one
--
-- The TypeScript stays. `window_ends_at_the_citations` is a real refusal with a
-- real argument — a window that stops at the citations cannot answer whether a
-- later message takes the sentence back — and it is the check that makes a
-- later correction findable at all. Narrowing it to accept a citations-only
-- window would trade a dead path for a wrong one: readings would auto-accept
-- with the correction sitting one row past the edge of the evidence, which is
-- the exact defect r5 built the scan for.
--
-- So the window widens. It stays a snapshot, still taken at the append, still
-- derived from the row and from nothing a caller says — every property `0006`
-- argued for survives, because the only thing that changes is which rows the
-- derivation selects.
--
-- ## The number below, and why it is 201 rather than 200
--
-- `RECEIPT_POLICY.maxLaterMessagesScanned` is 200: the checker reads at most 200
-- messages after the citations and refuses (`too_many_messages`) above that,
-- because an unread window is not a clean one. A snapshot has to stop somewhere
-- too — the alternative is a window that grows without bound and an append whose
-- cost is the room's whole history.
--
-- The moment both sides stop, **two windows become the same bytes**: one where
-- the room ran out, and one where this function did. `laterRevision` has no
-- message table and no clock; from in there a tail of 200 is a tail of 200. If
-- this function stopped at 200 and the room had 5,000, the checker would read
-- every message it was handed, find no correction, and certify — against 4,800
-- messages that the policy says must be read and that nobody ever looked at.
-- That is the **under**-supply direction, and it is the only direction of this
-- whole ticket that is dangerous. Over-supply is not: a window carrying more
-- than the checker reads is already `too_many_messages`, which *refers* rather
-- than accepts.
--
-- One more than the read bound is what makes the two distinguishable, with no
-- extra channel between the two languages and nothing for the checker to trust:
--
--   · fewer than 201 after the newest citation ⇒ this function had nothing left
--     to give, so the window holds the room's entire remainder and the scan
--     reads all of it;
--   · 201 ⇒ this function truncated, the tail is over 200 by construction, and
--     `too_many_messages` refers it.
--
-- The ambiguous window does not exist. `laterRevision` refuses by name
-- (`window_carries_fewer_than_this_check_reads`) if the two numbers are ever set
-- so that it could, and `packages/db/test/schema.test.ts` reads the literal out
-- of this file and the constants out of `policy.ts` and fails the build when
-- they diverge — the same shape `apps/web/test/token-contrast.test.ts` uses to
-- keep `design/tokens.css` and its consumers in step.
--
-- ## Why the number is written here rather than generated from the constant
--
-- Considered and rejected on #86. Generating this migration from `policy.ts`
-- gives one source of truth and puts a codegen step in the migration path.
-- Migrations are the one artifact in this repo that must be readable and
-- immutable after the fact; a generated migration is a migration whose meaning
-- lives somewhere else, and reading it a year from now would mean finding the
-- generator and the version of the constant it ran against. The literal is
-- written out, and the assertion is how the two stay in step.
--
-- The other rejected option was moving the bound into the database as a settings
-- row read at startup — which would let a deployment change what "certified"
-- means without a code change, and that is the opposite of what this product is
-- for.
--
-- ## What is NOT here: no backfill, and that is the point
--
-- `0006` re-derived every existing snapshot, because the old ones were
-- *forgeable* — a caller had supplied them. Nothing about them was a fact.
--
-- These are not that. Every window in the table was derived by this same
-- function from its own row, and each is a fact about **the moment of its
-- append**. The cited half of a window is time-invariant: `messages` is
-- append-only and the citation list is inside an immutable payload, so
-- re-deriving it tomorrow returns what it returned yesterday. **The tail is
-- not.** It is "the room's next messages", and the room keeps growing.
--
-- So a heal here would not repair old rows, it would rewrite them — folding
-- messages into a receipt that did not exist when the receipt was taken, and
-- making every earlier acceptance replay against evidence its own append never
-- saw. That is precisely the mutability the snapshot column exists to prevent
-- (`schema.ts`, `trustedMessages`: "after the append the fold does not read
-- `messages` at all"). Replay reads the stored column, so old rows keep
-- replaying exactly as they applied. Rows appended from here on get the wider
-- window. Both are consistent with themselves, which is the only consistency a
-- snapshot promises.
--
-- ## `CREATE OR REPLACE`, deliberately, and the one time that is safe
--
-- Every other function in this chain is replaced by `DROP` + `CREATE`, for the
-- r2 reason `0005` states: Postgres cannot change a parameter list in place, so
-- `CREATE OR REPLACE` with a different one creates an **overload** — a second
-- door that satisfies every name-based guard while doing none of the work.
--
-- The signature here is byte-identical to `0006`'s, so there is no second door
-- to create: `CREATE OR REPLACE` rebinds the one function that exists. It is the
-- correct choice rather than merely a safe one, because `DROP` takes the grants
-- with it — `0006` and `0008` both revoke `PUBLIC` and grant this function to
-- the owner and to every app role, and a `DROP` here would silently reset that
-- ACL to the default (EXECUTE to PUBLIC) unless every grant were restated. The
-- privilege audit at the end of `0008` stays true across this migration without
-- being re-run, which is checkable and is checked.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "atrium_receipt_window"(
  p_room_id uuid,
  p_actor_kind "actor_kind",
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $window$
DECLARE
  -- ── THE BOUND, AND THE ONE NUMBER THIS FILE OWNS ────────────────────────────
  --
  -- Messages after the newest citation this window carries before it stops.
  --
  -- **201 = `RECEIPT_POLICY.maxLaterMessagesScanned` (200) + 1**, and the `+ 1`
  -- is the whole mechanism, not a margin. The header above says why: at 200 a
  -- truncated window and a room that ended are indistinguishable to the checker,
  -- and at anything below 200 the checker certifies against messages it was
  -- never handed. At 201 a truncated window always lands over the checker's read
  -- bound and is referred as `too_many_messages`.
  --
  -- Kept in step with `packages/core/src/policy.ts` by an assertion, not by a
  -- convention: `packages/db/test/schema.test.ts` reads this literal and
  -- `RECEIPT_POLICY.maxLaterMessagesCarried` / `.maxLaterMessagesScanned` and
  -- fails when the three stop agreeing. Named rather than inlined at the `LIMIT`
  -- so that assertion can also check the declared number is the one actually
  -- used — a constant nothing reads is a comment with a type.
  c_later_messages_carried constant integer := 201;

  v_ids jsonb;
  v_last_cited_seq bigint;
  v_window jsonb;
BEGIN
  -- Unchanged from 0006, and each is still a decision:
  --
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

  -- ── Where "after" starts, in the room's own order ───────────────────────────
  --
  -- The newest cited message's position. Room-scoped for the reason 0006 gives:
  -- looking messages up by id alone let a model acceptance in room A be handed
  -- the text of a message from room B, and the window is what the receipt is
  -- checked against.
  --
  -- NULL when no cited id is a message in this room. `bigint > NULL` is NULL, so
  -- the tail selects nothing and the result is the empty window `0006` already
  -- returned for that input — which `laterRevision` reports as
  -- `no_citation_in_the_window` and `validateProposalProvenance` as
  -- `unknown_message`, both of which refer. Written as a total function for the
  -- same reason the rest of it is: this runs inside the append, and a raise here
  -- would be a failure mode reachable from a payload.
  SELECT max(m."seq") INTO v_last_cited_seq
  FROM "messages" m
  WHERE m."room_id" = p_room_id
    AND m."id"::text IN (SELECT jsonb_array_elements_text(v_ids));

  SELECT coalesce(jsonb_agg(w."row" ORDER BY w."seq"), '[]'::jsonb)
  INTO v_window
  FROM (
    -- ── the cited messages: 0006's window, unchanged ──────────────────────────
    SELECT
      m."seq" AS "seq",
      jsonb_build_object(
        'id', m."id"::text,
        -- A message whose author was deleted keeps its text and loses its name.
        -- Empty rather than the id of nobody: attribution to '' matches no actor,
        -- which is the conservative reading the receipt checks want. Snapshotted
        -- here, so it is a fact about the moment of the append and not about today.
        'authorId', coalesce(m."author_id"::text, ''),
        'body', m."body"
      ) AS "row"
    FROM "messages" m
    WHERE m."room_id" = p_room_id
      AND m."id"::text IN (SELECT jsonb_array_elements_text(v_ids))

    UNION ALL

    -- ── …and what the room said after them, which is the whole of #86 ─────────
    --
    -- `UNION ALL` and not `UNION`: the two arms are provably disjoint, because
    -- `v_last_cited_seq` is the *maximum* seq among the cited rows and this arm
    -- takes only rows strictly above it. `UNION` would spend a dedup pass to
    -- discover that, and — worse — would silently absorb a duplicate if a later
    -- change made one possible, turning a bug into a shorter window. Disjoint by
    -- construction is the claim; `ALL` is what makes the claim visible.
    --
    -- `ORDER BY` + `LIMIT` inside the arm: the bound has to select the room's
    -- **earliest** messages after the citation, not an arbitrary 201 of them.
    -- Without the ORDER BY the planner is free to return any 201 rows, and the
    -- correction this scan exists to find is usually the very next message.
    (
      SELECT
        m."seq" AS "seq",
        jsonb_build_object(
          'id', m."id"::text,
          'authorId', coalesce(m."author_id"::text, ''),
          'body', m."body"
        ) AS "row"
      FROM "messages" m
      WHERE m."room_id" = p_room_id
        AND m."seq" > v_last_cited_seq
      ORDER BY m."seq"
      LIMIT c_later_messages_carried
    )
  ) w;

  -- `ORDER BY w."seq"` on the aggregate above, not on a subquery the planner may
  -- reorder: the window is durable, so its order may not depend on which plan was
  -- chosen. It matters to the reducer as well — a quote carried by several cited
  -- messages is reported against the first match, and "first" must be the room's
  -- order — and it matters to `laterRevision`, whose whole notion of "later" is
  -- positional in this array.
  RETURN v_window;
END;
$window$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_receipt_window"(uuid, "actor_kind", jsonb) IS
  'The receipt window a ledger row folds under, derived from the row itself: room-scoped, ordered by the room''s own message order, NULL when no window is called for. Carries the cited messages AND the room''s next 201 messages after the newest citation — one more than RECEIPT_POLICY.maxLaterMessagesScanned, so a window the room outgrew is visibly over the checker''s read bound instead of quietly truncated, and the checker never certifies against evidence it was not handed (#86). The only derivation — the core_events_invariants trigger calls it to write the snapshot and apps/server/src/ledger.ts calls it to fold under the same value, and the append returns what it stored so the two can be compared rather than assumed.';
