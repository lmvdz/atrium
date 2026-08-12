-- ═════════════════════════════════════════════════════════════════════════════
-- AN AGENT'S CHANNEL IS A ROOM IT OWNS — RECIPROCITY, AND THE INVARIANT CLOSED
-- UNDER UPDATE.
--
-- #116 fix round 2, from the round-1 gauntlet (both foreign lineages converged).
-- The pstree/ownership invariant was enforced on INSERT and LEAKED on UPDATE and
-- the sidecar path. 0021–0023 built `agents.channel_room_id` and
-- `rooms.agent_user_id` as two INDEPENDENT foreign keys — nothing tied them
-- together, so:
--
--   * HIGH — `agents.channel_room_id` could point at a room whose
--     `rooms.agent_user_id` was NULL, a human, or a DIFFERENT agent. An agent's
--     "channel" was not a room it owned; it was any room at all.
--   * HIGH — `channel_room_id` was mutable, so `UPDATE agents SET channel_room_id
--     = R2` left that agent's plans stranded in R1. `plans_room_matches_agent_
--     channel` (0022) fires on a PLAN write, never on an agent channel change, so
--     the plan.room = agent.channel invariant was not closed under the agent-side
--     UPDATE.
--
-- Both close with ONE mechanism: a composite foreign key that makes an agent's
-- channel a room it owns, plus a trigger for the half a foreign key cannot state.
--
-- ## The composite FK, and why it closes BOTH findings
--
-- `agents (channel_room_id, user_id) → rooms (id, agent_user_id)` asserts, for
-- the whole life of the row, that the room named as the channel has THIS agent as
-- its `agent_user_id`. That is reciprocity: the channel is a room the agent owns,
-- refused at INSERT and — because a foreign key is symmetric — under UPDATE of
-- EITHER side. `UPDATE rooms SET agent_user_id = NULL` (or to someone else) while
-- an agent references the room is refused by the FK's ON UPDATE NO ACTION; the
-- channel cannot be un-owned out from under the agent.
--
-- And it makes `channel_room_id` IMMUTABLE as a theorem rather than by a second
-- trigger. `rooms_agent_user_id_key` (0021) is UNIQUE, so an agent owns AT MOST
-- ONE room. To move the channel from R1 to R2, R2 would have to carry
-- `agent_user_id = <agent>`; the unique index forbids that while R1 already does,
-- and clearing R1 first is refused by this FK. So there is no value
-- `channel_room_id` can be updated to other than the one it holds — the plan-
-- orphaning UPDATE of finding 1 has no legal spelling. This is deliberately NOT a
-- standalone immutability trigger: a trigger duplicating what the FK already
-- forbids would be a guard no mutation could kill (dropping it changes no
-- refusal), and "check relations, not predicates" says the honest closure is the
-- relation between the FK and the one-channel unique index, both individually
-- killable and tested. It also VALIDATES 0022's `plans_room_matches_agent_
-- channel` no-lock claim, which reads the agent's channel "through no lock (an
-- agent's channel_room_id does not change under a plan mid-insert)" — now true by
-- construction rather than by assumption.
--
-- ## The half a foreign key cannot state: the room's owner is an AGENT
--
-- Reciprocity binds from the agent side, so a room can still carry
-- `agent_user_id = <a human or model>` with no `agents` row referencing it. A
-- foreign key cannot look at the referenced user's `principal_kind`. So one
-- trigger, modelled exactly on 0021's `agents_user_is_agent`: if
-- `rooms.agent_user_id` is set, it must name an `agent`-kind user. Reads through
-- `::text`, takes no lock (`principal_kind` is immutable, 0017), fails closed.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. The composite-FK TARGET on rooms — (id, agent_user_id)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A foreign key must reference a UNIQUE key. `id` is the primary key, so
-- (id, agent_user_id) is trivially unique; Postgres still requires the index to
-- exist on exactly those columns to point a composite FK at it. `agent_user_id`
-- is nullable, which a unique index permits (NULLs distinct) and which does not
-- weaken the FK: the referencing columns are both NOT NULL, so the match is
-- always checked and never a NULL-skip.
CREATE UNIQUE INDEX "rooms_id_agent_user_id_key" ON "rooms" ("id", "agent_user_id");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. The reciprocity FK — an agent's channel is a room IT owns
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Separate ALTER so the mutation ledger can drop and re-add it by name. ON DELETE
-- cascade matches the existing single-column `agents_channel_room_id_fk` (0021):
-- deleting the channel room takes the config with it. ON UPDATE is the default
-- (NO ACTION), and that is the load-bearing half — it is what refuses un-owning
-- the channel and what freezes `channel_room_id`.
ALTER TABLE "agents" ADD CONSTRAINT "agents_channel_owned_fk"
  FOREIGN KEY ("channel_room_id", "user_id") REFERENCES "public"."rooms"("id", "agent_user_id") ON DELETE cascade;--> statement-breakpoint

COMMENT ON CONSTRAINT "agents_channel_owned_fk" ON "agents" IS
  'An agent''s channel is a room IT owns (#116 fix r2). (channel_room_id, user_id) → rooms(id, agent_user_id): the channel room''s agent_user_id must be this agent. Closes the reciprocity leak (a channel pointing at a room owned by NULL/a human/another agent) at INSERT and under UPDATE of either side, and — with the unique rooms_agent_user_id_key — makes channel_room_id immutable as a theorem, closing the plan-orphaning UPDATE (finding 1).';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 3. The room's owner, when set, is an agent — the trigger a FK cannot be
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "atrium_rooms_agent_user_is_agent"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $rooms_agent_is_agent$
DECLARE
  v_kind text;
BEGIN
  IF NEW."agent_user_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT u."principal_kind"::text INTO v_kind
  FROM public."users" u WHERE u."id" = NEW."agent_user_id";
  IF v_kind IS NULL THEN
    RAISE EXCEPTION
      'room %: agent_user_id "%" is not an identity in this database', NEW."id", NEW."agent_user_id"
      USING ERRCODE = '23514', CONSTRAINT = 'rooms_agent_user_is_agent';
  END IF;
  IF v_kind <> 'agent' THEN
    RAISE EXCEPTION
      'room %: agent_user_id "%" is a % principal, but a room''s owning agent must be an agent — the channel back-reference names an agent identity, not a person or a model', NEW."id", NEW."agent_user_id", v_kind
      USING ERRCODE = '23514', CONSTRAINT = 'rooms_agent_user_is_agent';
  END IF;
  RETURN NEW;
END;
$rooms_agent_is_agent$;--> statement-breakpoint

CREATE TRIGGER "rooms_agent_user_is_agent"
  BEFORE INSERT OR UPDATE ON "rooms"
  FOR EACH ROW EXECUTE FUNCTION "atrium_rooms_agent_user_is_agent"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_rooms_agent_user_is_agent"() IS
  'Refuses any rooms row whose agent_user_id names a users row that is not principal_kind=agent (#116 fix r2). The reciprocal-ownership half a foreign key cannot state: reciprocity (agents_channel_owned_fk) binds from the agent side, so without this a room could carry agent_user_id = a human/model with no agents row. Fires BEFORE INSERT OR UPDATE so it is a property of the row for its whole life. No row lock — principal_kind is immutable (0017). Does not bind an operator who disables triggers.';
