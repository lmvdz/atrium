-- ═════════════════════════════════════════════════════════════════════════════
-- AN AGENT IS A USERS ROW PLUS A CONFIG SIDECAR, AND ITS CHAIN ENDS AT A HUMAN.
--
-- #116, from #114's resolution. An agent already exists as an identity — a
-- `users` row with `principal_kind = 'agent'` (#96, drizzle/0017). What it did
-- not have was config: an owner, a channel, a host/harness/model, a budget
-- root. This adds the 1:1 sidecar that carries it, keyed by the agent's own
-- `user_id` so the two are one identity, and off `users` because Better Auth
-- shares that table.
--
-- ## The init anchor, as two triggers rather than a convention (#114)
--
-- The load-bearing claim is that the ownership chain terminates at a human BY
-- SCHEMA. Two triggers make it so, both modelled on 0017's read of an immutable
-- `principal_kind`:
--
--   * `agents_owner_is_human` — `owner_user_id` must name a `users` row whose
--     `principal_kind` is `human`. An agent owned by another agent, or by a
--     model, is refused. This is the whole of "the chain ends at a person".
--   * `agents_user_is_agent` — `user_id` must name a `users` row whose kind is
--     `agent`. A person's uuid cannot be dressed as an agent's config.
--
-- Neither read takes a row lock: `principal_kind` is immutable
-- (`users_principal_kind_immutable`, 0017 §2), so there is no UPDATE for the
-- check to race against. Both triggers fire BEFORE INSERT OR UPDATE, so the
-- guarantee is a property of the row for its whole life, not just of the moment
-- it was created — the same shape 0018 gave the append boundary.
--
-- Written through `::text` on the enum comparison for the same reason 0017 was:
-- it resolves no enum label, so nothing here depends on a label added in a
-- transaction that has not committed.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. The channel back-reference on rooms
-- ─────────────────────────────────────────────────────────────────────────────
--
-- An agent's channel is a room it OWNS (#114 T1), distinct from the rooms it is
-- merely a member of. Nullable because almost every room is a group channel;
-- unique because a room is at most one agent's channel. `SET NULL` on the
-- agent's deletion: the channel's history outlives the identity.
ALTER TABLE "rooms" ADD COLUMN "agent_user_id" uuid;--> statement-breakpoint

ALTER TABLE "rooms" ADD CONSTRAINT "rooms_agent_user_id_fk"
  FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE set null;--> statement-breakpoint

CREATE UNIQUE INDEX "rooms_agent_user_id_key" ON "rooms" ("agent_user_id");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. The agents sidecar
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "agents" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "channel_room_id" uuid NOT NULL,
  "host" text NOT NULL,
  "harness" text NOT NULL,
  "model" text NOT NULL,
  "budget_limit_micros" bigint,
  "created_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

COMMENT ON TABLE "agents" IS
  'Config sidecar for an agent principal (#116). 1:1 with the users row named by user_id (principal_kind=agent). owner_user_id names the human the agent belongs to and is held to principal_kind=human by agents_owner_is_human — the init anchor, so the ownership chain terminates at a person by schema rather than by convention. channel_room_id is the room the agent owns as its channel; the pstree room trigger on plans keys on it. host/harness/model/budget_limit_micros are placeholders for #115.';--> statement-breakpoint

ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;--> statement-breakpoint

ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_user_id_fk"
  FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "agents" ADD CONSTRAINT "agents_channel_room_id_fk"
  FOREIGN KEY ("channel_room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade;--> statement-breakpoint

CREATE INDEX "agents_owner_idx" ON "agents" ("owner_user_id");--> statement-breakpoint

CREATE UNIQUE INDEX "agents_channel_room_key" ON "agents" ("channel_room_id");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 3. The two kind triggers — the chain terminates at a human
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "atrium_agents_owner_is_human"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $owner_is_human$
DECLARE
  v_kind text;
BEGIN
  SELECT u."principal_kind"::text INTO v_kind
  FROM public."users" u WHERE u."id" = NEW."owner_user_id";
  IF v_kind IS NULL THEN
    RAISE EXCEPTION
      'agent %: owner "%" is not an identity in this database', NEW."user_id", NEW."owner_user_id"
      USING ERRCODE = '23514', CONSTRAINT = 'agents_owner_is_human';
  END IF;
  IF v_kind <> 'human' THEN
    RAISE EXCEPTION
      'agent %: owner "%" is a % principal, but an agent''s owner must be a human — the ownership chain terminates at a person (init), and that is enforced here rather than assumed', NEW."user_id", NEW."owner_user_id", v_kind
      USING ERRCODE = '23514', CONSTRAINT = 'agents_owner_is_human';
  END IF;
  RETURN NEW;
END;
$owner_is_human$;--> statement-breakpoint

CREATE TRIGGER "agents_owner_is_human"
  BEFORE INSERT OR UPDATE ON "agents"
  FOR EACH ROW EXECUTE FUNCTION "atrium_agents_owner_is_human"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_agents_owner_is_human"() IS
  'Refuses any agents row whose owner_user_id names a users row that is not principal_kind=human. This is #114''s init anchor: the ownership chain terminates at a human by schema. No row lock — principal_kind is immutable (0017), so there is no update to race. Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint

CREATE OR REPLACE FUNCTION "atrium_agents_user_is_agent"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $user_is_agent$
DECLARE
  v_kind text;
BEGIN
  SELECT u."principal_kind"::text INTO v_kind
  FROM public."users" u WHERE u."id" = NEW."user_id";
  IF v_kind IS NULL THEN
    RAISE EXCEPTION
      'agent config for "%" names no identity in this database', NEW."user_id"
      USING ERRCODE = '23514', CONSTRAINT = 'agents_user_is_agent';
  END IF;
  IF v_kind <> 'agent' THEN
    RAISE EXCEPTION
      'user "%" is a % principal and cannot hold agent config — agent config belongs only to an agent principal', NEW."user_id", v_kind
      USING ERRCODE = '23514', CONSTRAINT = 'agents_user_is_agent';
  END IF;
  RETURN NEW;
END;
$user_is_agent$;--> statement-breakpoint

CREATE TRIGGER "agents_user_is_agent"
  BEFORE INSERT OR UPDATE ON "agents"
  FOR EACH ROW EXECUTE FUNCTION "atrium_agents_user_is_agent"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_agents_user_is_agent"() IS
  'Refuses any agents row whose user_id names a users row that is not principal_kind=agent. Keeps agent config off person identities. No row lock — principal_kind is immutable (0017). Does not bind an operator who disables triggers.';
