-- ═════════════════════════════════════════════════════════════════════════════
-- 0009 — the append guard stops claiming an author it cannot bind
--
-- Round 7 of #22's gauntlet, defect 1, executed against a real Postgres 16. Two
-- statements that differ by one SQL comment:
--
--     DO $$ BEGIN
--       PERFORM pg_catalog.pg_advisory_xact_lock(1096045106::bigint);
--       INSERT INTO public.core_events (...)
--       /* function public.atrium_append_core_event(uuid,text,public.event_type,
--          public.actor_kind,text,jsonb,timestamp with time zone,text) line 1 */
--       VALUES (...);
--     END $$;
--
-- Without the comment: `ERROR: core_events is append-only through
-- atrium_append_core_event()`. With it: `DO`, and a row lands.
--
-- `GET DIAGNOSTICS … PG_CONTEXT` is the live PL/pgSQL call stack, and each frame
-- in it carries **the verbatim SQL text of the statement executing in that
-- frame**. `0008`'s guard is `position('function ' || v_expected || ' line ' in
-- v_context)` — a substring search over that text. So the evidence the guard
-- reads is a document the caller wrote. The comment is not a trick played on the
-- parser; it is the guard being handed exactly what it asked for.
--
-- ## Why a better pattern is not the fix
--
-- Line-anchoring is the obvious next move and it does not work: `PG_CONTEXT`
-- echoes embedded newlines, so a caller can inject a whole byte-identical line
-- rather than a fragment of one. Demonstrated in r7's receipt. Any refinement of
-- the pattern is a refinement of a search over attacker-authored text, and the
-- attacker gets to see the pattern — the migration is in the repository, and
-- `pg_get_functiondef` will print it to anyone with SELECT on `pg_proc`. **The
-- instrument is wrong, not the pattern.**
--
-- ## Why there is no unforgeable replacement either — the part worth proving
--
-- The tempting alternatives are all session state minted inside the function and
-- read back by the trigger. Each was executed by a bare caller, in a bare `DO`
-- block, with no CREATE privilege anywhere (`d1-theorem`, and the same probes are
-- in `integration/db/ledger-constraints.test.ts`):
--
--   * a transaction-local GUC (`set_config('atrium.appending','yes',true)`) —
--     the caller sets it;
--   * an advisory-lock token minted inside the function — the caller takes it,
--     exactly as the exploit above already takes 1096045106;
--   * a temp table or temp sequence as a witness — the caller creates it
--     (`TEMPORARY` is granted to PUBLIC on every database by default);
--   * an unpredictable nonce — the caller mints its own and publishes it, because
--     nothing checks *which* nonce, only that one is there. Making the trigger
--     check *which* requires a store the caller cannot write, and there is none:
--     the caller and the function are the same session, the same backend, and —
--     see below — necessarily the same role.
--
-- `pg_trigger_depth()`-style structural evidence does not help either: it
-- distinguishes nesting, and this INSERT is not nested. There is no fact
-- available to a `BEFORE INSERT` trigger that separates "the append function did
-- this" from "the caller did this", because **everything either of them can do,
-- the other can do too.**
--
-- ## What actually separates them, and it is not a trigger
--
-- Privilege, and the argument closes:
--
--   * `0003` revoked INSERT/UPDATE/DELETE/TRUNCATE on `core_events` from PUBLIC
--     and from every non-superuser LOGIN role holding SELECT, deliberately
--     skipping the owner — because `atrium_append_core_event` is SECURITY
--     DEFINER and runs *as* the owner.
--   * So the set of principals that can reach this table with an INSERT at all is
--     {owner, superuser}.
--   * A role outside that set never reaches the trigger. Executed against a fresh
--     role holding SELECT on every table and EXECUTE on the append function: the
--     comment exploit returns `ERROR: permission denied for table core_events`,
--     while the legitimate call through the function succeeds. The guard is not
--     what stopped it; the `REVOKE` is, one layer earlier.
--   * A role inside that set is not bound by any trigger. `ALTER TABLE …
--     DISABLE TRIGGER` and `session_replication_role = replica` are both theirs,
--     which `0003` and `0008` already said and which the suite already tests.
--
-- **Therefore the frame check's discrimination against an author is exactly zero,
-- and no rewrite of it can be greater than zero.** It is not that this guard is
-- weak; it is that a trigger is the wrong place to look for an answer that only
-- a privilege boundary can give. That is the sentence `0008:89-91` and
-- `ledger-constraints.test.ts` got wrong, and both are corrected in this round.
--
-- ## So why is the check still here?
--
-- Because it is not useless — it is *differently* useful, and the honest claim is
-- small and true: **it catches an accident that the lock check cannot see.**
--
-- The advisory-lock half already refuses every direct INSERT written by someone
-- who did not know to take the ledger lock, which is what an accidental direct
-- write looks like — a migration, a `psql` session, a stray ORM call. The one
-- accident it *cannot* see is a stray direct INSERT in a transaction that has
-- already made a legitimate append: the lock is transaction-scoped and still
-- held, so the lock half passes. The frame check refuses that one, because the
-- append function has returned and its frame is gone from the stack. Executed;
-- there is a test for it.
--
-- Two lines for one real accident class, fail-closed, and now labelled as what it
-- is rather than as a boundary. What is NOT claimed, anywhere, from this round
-- on: that this guard stops an author, that direct INSERT is impossible, or that
-- bypassing it costs a privilege. It costs a comment.
--
-- ## What is untouched, and it is the part that matters
--
-- The five invariants in `core_events_invariants` and the doorbell are unaffected
-- and were verified by r7's critic **using this very exploit as the vehicle** —
-- the strongest faked frame available. Membership refused, non-uuid actor
-- refused, canonical order refused, a caller-supplied `room_seq 9999` overwritten
-- to the real 3, a caller-supplied `trusted_messages` overwritten to NULL, and
-- cross-room, unresolvable and two-room subjects all refused. That is the durable
-- trust boundary, it lives on the table, and getting past `core_events_append_guard`
-- buys nothing against it. `0008`'s central design decision — move the rules to
-- where every writer has to pass them — is exactly what makes this defect a
-- falsified sentence instead of a falsified ledger.
--
-- ## Scope of the defect, stated because a receipt should bound its own findings
--
-- Not reachable from a websocket client: the only two `sql.raw` uses in the
-- server take compile-time constants, and no client input reaches a raw
-- statement. Not a privilege escalation: it needs INSERT on `core_events`, which
-- only the owner holds. What it falsifies is a sentence — in the file whose whole
-- subject is sentences that were the guarantee.
--
-- This migration changes no schema. It changes what the database *says about
-- itself*, which is the thing that was wrong.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. The guard, saying what it is
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The body is byte-for-byte `0008`'s except for the refusal message and the
-- comments. Deliberately: a "hardened" pattern here would be theatre, and would
-- make the next reader believe a bound that the argument above disproves.
CREATE OR REPLACE FUNCTION "atrium_core_events_append_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE
  v_context text;
  v_expected text;
  v_locked boolean;
BEGIN
  -- READ THIS BEFORE TRUSTING THE CHECK BELOW.
  --
  -- PG_CONTEXT is the live PL/pgSQL call stack, and it carries the verbatim SQL
  -- text of each frame's current statement. This is a substring search over text
  -- the caller wrote, so **any caller who can execute a plpgsql block can satisfy
  -- it with one SQL comment** (#22 gauntlet r7, defect 1 — executed). It is not
  -- a boundary and this round stopped calling it one; see 0009's header for the
  -- proof that no replacement token is unforgeable either, and for the privilege
  -- argument that is the actual boundary.
  --
  -- What it does buy, exactly: it refuses a stray direct INSERT inside a
  -- transaction that has already made a legitimate append. That transaction still
  -- holds the ledger advisory lock, so the lock check below passes it; the append
  -- function has returned, so its frame is gone and this check does not. One real
  -- accident class the other half cannot see, for two lines, fail-closed.
  GET DIAGNOSTICS v_context = PG_CONTEXT;
  -- Derived, not restated: `regprocedureout` IS `format_procedure`, the same C
  -- function PL/pgSQL used to label the frame, evaluated under the same
  -- search_path the append function compiles under. A hand-kept copy would drift.
  -- (In practice the rendered text says `timestamp with time zone` where the
  -- source says `timestamptz`, and neither side had to know that.)
  v_expected := to_regprocedure(
    'public.atrium_append_core_event(uuid,text,public.event_type,public.actor_kind,text,jsonb,timestamptz,text)')::text;
  -- NULL on EITHER side is a refusal. `position(x in y)` is NULL when either
  -- argument is and `IF NULL` takes the false branch, so the natural spelling
  -- refuses on a missing function and *passes* on a missing call stack. The
  -- context is never NULL inside a trigger — r7's critic confirmed the branch is
  -- unreachable — and it stays, because fail-closed on an unreachable branch
  -- costs nothing and the alternative is a fail-open waiting for a refactor.
  IF v_expected IS NULL
     OR v_context IS NULL
     OR coalesce(position('function ' || v_expected || ' line ' in v_context), 0) = 0 THEN
    -- The message says what was observed, not what is guaranteed. r7 said
    -- "core_events is append-only through atrium_append_core_event()", which is
    -- the false sentence in the place a reader is most likely to meet it — in a
    -- log, at 3am, with no migration header in front of them.
    RAISE EXCEPTION
      'this INSERT into core_events did not come through atrium_append_core_event(); the append function takes the ledger lock and mints the canonical positions, and a write that skips it skips those. This check reads the caller''s own statement text and is an accident check, not a boundary — INSERT privilege on core_events is the boundary (see migration 0009)'
      USING ERRCODE = '42501', CONSTRAINT = 'core_events_append_through_procedure';
  END IF;

  -- classid/objid are how Postgres stores a bigint advisory key: the high 32
  -- bits in classid, the low 32 in objid. 1096045106 fits in 32 bits, so
  -- classid is 0. objsubid 1 marks the single-argument (bigint) form.
  --
  -- Structural rather than textual — `pg_locks` is the lock manager's own state,
  -- not something the caller composed — but note that structural does not mean
  -- unforgeable: the caller takes this lock in one line, and the exploit above
  -- does. It refuses the accident, and it is honest about being an accident
  -- check for the same reason the one above it now is.
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

COMMENT ON FUNCTION "atrium_core_events_append_guard"() IS
  'An ACCIDENT CHECK on INSERTs into core_events, and deliberately not called a boundary (#22 gauntlet r7, defect 1). It refuses a write that did not take the ledger advisory lock, and a write whose PL/pgSQL call stack does not show atrium_append_core_event — which catches the one accident the lock check cannot see, a stray direct INSERT in a transaction that already made a legitimate append. It does NOT bind an adversary and no rewrite of it could: GET DIAGNOSTICS PG_CONTEXT carries the verbatim statement text of every caller frame, so a substring search over it is satisfied by one SQL comment, at the cost of no privilege anywhere; line-anchoring does not help because PG_CONTEXT echoes newlines; and every session-scoped token the function could mint instead (a GUC, an advisory-lock token, a temp witness, a nonce) is mintable by the caller too, because caller and function are the same session and the same role. The boundary is privilege: after 0003 only the owner and a superuser can INSERT into this table at all, a role outside that set is refused by the REVOKE before this trigger runs, and a role inside it can disable this trigger. The append RULES are elsewhere and are not affected — core_events_invariants enforces membership, subject-room resolution, canonical order, room_seq and trusted_messages from the table, and holds against a caller that fakes this call stack.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. The door, with the same correction
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 0008's comment on the append function called it "the door onto core_events,
-- and the only one a REVOKE can control". The first half implied an exclusivity
-- the guard cannot deliver; the second half is the true one and is the whole
-- point, so it is what the sentence leads with now.
COMMENT ON FUNCTION "atrium_append_core_event"(uuid, text, "event_type", "actor_kind", text, jsonb, timestamptz, text) IS
  'The door onto core_events that a REVOKE can control, and the only appending path any role short of the table owner has: it takes the ledger advisory lock, names this instance for the doorbell, inserts, and returns the positions and the receipt window the TABLE assigned by RETURNING. It is not the only statement that CAN reach the table — the owner can INSERT directly, and core_events_append_guard is an accident check rather than a boundary (see migration 0009) — which is why it is not where the append rules live. Membership, the room a room-less kind resolves to, the canonical order, room_seq and the receipt window are all enforced by the core_events_invariants trigger, from the table, so a caller that gets past core_events_append_guard is still not past the rules (#22 gauntlet r6 major 3; re-verified r7 using the guard bypass itself as the vehicle). Neither room_seq nor the receipt window is a parameter; a caller cannot supply either. EXECUTE is revoked from PUBLIC and granted to the table owner plus every non-superuser LOGIN role that already holds SELECT on core_events — which is how 0004 identifies the application role without being told its name, and which means a read-only login role granted SELECT before that migration also gets the door. Privileged bypasses (session_replication_role, ALTER TABLE ... DISABLE TRIGGER, pg_restore --disable-triggers) are operator territory and out of scope.';--> statement-breakpoint

COMMENT ON TRIGGER "core_events_append_guard" ON "core_events" IS
  'Accident check, not a boundary — see the comment on atrium_core_events_append_guard() and migration 0009. Runs before core_events_invariants (triggers fire in name order), which is where the rules that DO bind every caller live.';
