-- ═════════════════════════════════════════════════════════════════════════════
-- A SESSION THAT HAS EXITED IS NOT DRAFTING ANYTHING.
--
-- 0043 made the lineage question a table fact: a proposal naming a session must
-- name one whose plan belongs to the identified agent proposer. It asked WHOSE
-- session this is and never asked WHETHER it is still running.
--
-- `record_proposal` (apps/server/src/commands.ts) has always asked both — its
-- lookup carries `sessions.status = 'open'` beside `plans.agent_user_id`. So the
-- command path was whole and the table's half of it was not: a direct writer, a
-- future projection, a repair script, or a `db.insert(proposals)` could bind a
-- reading to a settled or failed session, and every read model would then render
-- a receipt pointing at a process that had already published its exit summary.
-- That is a worse lie than a cross-agent one, because it is self-consistent: the
-- agent is right, the room is right, only the claim that this came out of a live
-- process is false, and nothing downstream can tell.
--
-- This replaces 0043's function rather than adding a second trigger, so the two
-- conditions are evaluated in one place against one lookup and the fall-through
-- below cannot drift between them. 0043 is left exactly as it shipped: the
-- migration history is append-only, and re-running it after this one would
-- silently drop the status condition.
--
-- ## The fall-through, unchanged
--
-- A missing or cross-room session still RETURNs NEW and lands on
-- `proposals_session_same_room_fk`. There is one authority for "that session is
-- not in this room", and it is the FK — this function refuses only the shapes
-- the FK admits but cannot judge: a real same-room session paired with another
-- agent (0043), and now a real same-room session that has already exited.
--
-- The trigger fires BEFORE INSERT OR UPDATE OF the same four columns 0043 named.
-- Deliberately NOT re-fired by a later `sessions.status` change: a session that
-- settles AFTER its proposal was staged is the normal course of events, and the
-- edge records where the reading came from, not where it still is. The rule is
-- about what may be WRITTEN onto a proposal, not a liveness invariant the row
-- has to keep. (0025 already froze the terminal status itself, so the settled
-- session named here cannot be quietly reopened to make a stale write legal.)
--
-- `public.` qualification and `::text` comparison for the same reasons 0043 gave:
-- the hardened `search_path` excludes public, and the house style has compared
-- enum labels through text since 0017.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "atrium_proposals_session_matches_agent"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_agent_user_id uuid;
  v_session_status text;
BEGIN
  IF NEW."session_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p."agent_user_id", s."status"::text
    INTO v_agent_user_id, v_session_status
    FROM public."sessions" s
    JOIN public."plans" p
      ON p."room_id" = s."room_id"
     AND p."id" = s."plan_id"
   WHERE s."room_id" = NEW."room_id"
     AND s."id" = NEW."session_id";

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW."proposer_kind"::text <> 'agent'
     OR NEW."proposer_user_id" IS DISTINCT FROM v_agent_user_id THEN
    RAISE EXCEPTION
      'proposal session % belongs to agent %, not proposer %',
      NEW."session_id", v_agent_user_id, NEW."proposer_user_id"
      USING ERRCODE = '23514',
            CONSTRAINT = 'proposals_session_matches_agent';
  END IF;

  IF v_session_status <> 'open' THEN
    RAISE EXCEPTION
      'proposal session % is %, so it is not drafting anything',
      NEW."session_id", v_session_status
      USING ERRCODE = '23514',
            CONSTRAINT = 'proposals_session_is_open';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

COMMENT ON FUNCTION "atrium_proposals_session_matches_agent"() IS
  'For a proposal carrying session_id, verifies that the same-room session''s parent plan belongs to the identified agent proposer AND that the session is still open — the two halves of record_proposal''s guard, made table facts so a direct writer cannot bind a reading to another agent''s process or to one that has already exited. Missing/cross-room sessions fall through to proposals_session_same_room_fk. Reads public.sessions/public.plans explicitly because the hardened search_path excludes public.';
