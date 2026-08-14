-- A proposal that names an execution session must name one belonging to the
-- same agent the reading identifies. The composite FK added in 0022 remains the
-- authority for session existence and same-room consistency; this trigger asks
-- the other lineage question the FK cannot express: does that session's plan
-- belong to proposer_user_id?
--
-- A missing or cross-room session deliberately falls through to
-- proposals_session_same_room_fk, so there is still one authority for that
-- condition. This function refuses only the shape the FK admits but cannot
-- authenticate: a real session in this room paired with another proposer.
CREATE OR REPLACE FUNCTION "atrium_proposals_session_matches_agent"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_agent_user_id uuid;
BEGIN
  IF NEW."session_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p."agent_user_id"
    INTO v_agent_user_id
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

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "proposals_session_matches_agent"
  BEFORE INSERT OR UPDATE OF "room_id", "session_id", "proposer_kind", "proposer_user_id"
  ON "proposals"
  FOR EACH ROW EXECUTE FUNCTION "atrium_proposals_session_matches_agent"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_proposals_session_matches_agent"() IS
  'For a proposal carrying session_id, verifies that the same-room session''s parent plan belongs to the identified agent proposer. Missing/cross-room sessions fall through to proposals_session_same_room_fk. Reads public.sessions/public.plans explicitly because the hardened search_path excludes public.';
