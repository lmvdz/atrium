-- ═════════════════════════════════════════════════════════════════════════════
-- A ROUTING APPEND NAMES ITS CAUSE — AND ONE MESSAGE FUNDS AT MOST ONE ARM.
--
-- #128, building #124's resolution points 3 and 4. #127/0045 built the steer
-- arm's receipt (`session_signals.cause_message_id`, composite-FK'd same-room);
-- this file extends the SAME pattern to the other three routed appends and adds
-- the two things #124 made build obligations that no table yet carried:
--
--   1. **`cause_message_id` on `plan_opened`, `session_opened`, `message_posted`.**
--      Glance §9.3's trichotomy is steer / new work / answer, and until now only
--      the steer arm could say what it came from. Each new column is nullable (a
--      human opening a plan by hand cites nothing) and lands on the composite
--      `(room_id, message_id)` FK, so a cause from ANOTHER room is impossible in
--      every write path rather than merely refused by the command.
--
--   2. **THE LEDGER-SIDE ROOM-MATCH BACKSTOP.** #124 resolution 3 is explicit
--      that "the composite FKs bind plans/sessions, not JSON on the ledger", and
--      the agent is legitimately a member of many rooms (`memberships`). A
--      `core_events` row carries the routing append's whole payload as jsonb, and
--      NOTHING in the ledger asked whether `payload->>'causeMessageId'` named a
--      message in `core_events.room_id` — the projection's FK did, one layer
--      later, which binds the projection's writer and not the ledger's. A direct
--      `atrium_append_core_event` call, or any writer reaching the table, could
--      file a cross-room routing receipt. `atrium_core_events_routing_cause_same_room`
--      asks the question on the ledger row itself, for all four routed kinds.
--
--   3. **THE AT-MOST-ONE-FUNDED-ARM BACKSTOP** (#124 resolution 4). A new
--      `funded_arms` table whose PRIMARY KEY is `(room_id, cause_message_id)`.
--      Both draw-taking appends — `session_opened` (spawn) and
--      `session_signaled {kind:'resume'}` (continue) — claim a row when they
--      name a cause, so a daemon retry of one channel message cannot fund two
--      sessions from it. `plan_opened` is EXEMPT: a plan never draws (#124
--      resolution 2), so two free boards from one message spend nothing.
--
-- Append-only: 0045 and 0046 are untouched; every change here is an ADD or a
-- CREATE. `public.` qualification and `::text` enum comparison throughout, for
-- the reasons 0043–0046 gave — the hardened `search_path` excludes public, and
-- the house style has compared enum labels through text since 0017.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 1. The three new provenance columns, each on a same-room composite FK
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Nullable and NOT backfilled, for the reason 0046 gave for `raised_by_user_id`:
-- the ledger is append-only and every row that predates the column was written
-- before the rule existed. A NULL cause is not a violation, it is the ordinary
-- case — a person typing in a channel routes nothing.
--
-- NO `ON DELETE` action on any of the three (i.e. NO ACTION), matching
-- `messages_reply_to_same_room_fk` and for the reason `schema.ts` states there:
-- `SET NULL` would null every referencing column including `room_id`, which is
-- NOT NULL, so the action could only ever fail. Dropping a whole room still
-- works — the cascade from `rooms` removes every referencing row in the same
-- statement, and NO ACTION is checked at end of statement.

ALTER TABLE "messages" ADD COLUMN "cause_message_id" uuid;--> statement-breakpoint

ALTER TABLE "messages" ADD CONSTRAINT "messages_cause_same_room_fk"
  FOREIGN KEY ("room_id","cause_message_id") REFERENCES "public"."messages"("room_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

COMMENT ON COLUMN "messages"."cause_message_id" IS
  'THE ANSWER ARM''s routing receipt (#128, #124 resolution 3) — the channel message a daemon consumed and answered with this one. NOT reply_to_id beside it: that is a THREADING edge a client renders, this is a claim that a routed loop turn produced this append. Independently nullable; an answer may carry either, both, or neither. Same-room by messages_cause_same_room_fk, and by atrium_core_events_routing_cause_same_room one layer up on the ledger row itself.';--> statement-breakpoint

ALTER TABLE "plans" ADD COLUMN "cause_message_id" uuid;--> statement-breakpoint

ALTER TABLE "plans" ADD CONSTRAINT "plans_cause_same_room_fk"
  FOREIGN KEY ("room_id","cause_message_id") REFERENCES "public"."messages"("room_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

COMMENT ON COLUMN "plans"."cause_message_id" IS
  'THE NEW-WORK ARM''s board provenance (#128, #124 resolution 3). Nullable — the resolution names the hand-opened plan outright. A PLAN NEVER DRAWS (#124 resolution 2, grok r3): only session spawns and continues pass #118''s slice boundary, so this column is deliberately EXEMPT from the funded_arms uniqueness. Two plans from one message are two free boards; two FUNDED sessions from one message is a daemon retry that spent the slice twice, and that is the thing refused.';--> statement-breakpoint

ALTER TABLE "sessions" ADD COLUMN "cause_message_id" uuid;--> statement-breakpoint

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_cause_same_room_fk"
  FOREIGN KEY ("room_id","cause_message_id") REFERENCES "public"."messages"("room_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

COMMENT ON COLUMN "sessions"."cause_message_id" IS
  'THE NEW-WORK ARM''s process provenance (#128, #124 resolution 3). Nullable. Unlike plans.cause_message_id, a non-null value here is ALSO claimed in funded_arms by projectSessionOpened, because a spawn IS a draw — the column is the provenance, the claim row is the enforcement.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 2. AT MOST ONE FUNDED ARM PER CAUSE MESSAGE (#124 resolution 4)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The primary key IS the rule. Why a TABLE and not an index: the draw-taking
-- appends are two — `session_opened` and `session_signaled {kind:'resume'}` —
-- and they project into two different tables. No unique index spans two tables,
-- so a shared claim table is the only spelling of "across draw-taking appends"
-- that Postgres can actually enforce. A partial unique index on `sessions` would
-- have looked like the constraint and silently missed every resume, which is the
-- ornament shape this campaign keeps finding.
--
-- `cause_message_id` is NOT NULL: a draw naming no cause claims nothing and
-- collides with nothing, and the projections write no row for it. A NULLable
-- column here would have been the classic silent fail-open — Postgres treats
-- NULLs as distinct in a unique constraint, so "one arm per cause" would have
-- been unenforced precisely for every uncaused draw, and worse, would have READ
-- as enforced.
CREATE TABLE "funded_arms" (
  "room_id" uuid NOT NULL,
  "cause_message_id" uuid NOT NULL,
  "arm" text NOT NULL,
  "session_id" uuid NOT NULL,
  "drawn_by_event_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "funded_arms_room_cause_pk" PRIMARY KEY("room_id","cause_message_id"),
  CONSTRAINT "funded_arms_arm_is_a_draw" CHECK ("funded_arms"."arm" IN ('spawn', 'continue'))
);--> statement-breakpoint

ALTER TABLE "funded_arms" ADD CONSTRAINT "funded_arms_room_id_rooms_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "funded_arms" ADD CONSTRAINT "funded_arms_cause_same_room_fk"
  FOREIGN KEY ("room_id","cause_message_id") REFERENCES "public"."messages"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "funded_arms" ADD CONSTRAINT "funded_arms_session_same_room_fk"
  FOREIGN KEY ("room_id","session_id") REFERENCES "public"."sessions"("room_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

COMMENT ON TABLE "funded_arms" IS
  'One row per draw-taking routing append that named a cause message (#128, #124 resolution 4). The primary key (room_id, cause_message_id) is the whole rule: a daemon that processes one channel message twice — a retry after a lost ack, a crash between the draw and its own bookkeeping, two loop instances racing — cannot fund two sessions from it. The second claim collides, its append transaction aborts, and the second draw did not merely go uncounted: it never happened. NOT in here, deliberately: plan_opened (a plan never draws), message_posted (speech is not spend), steer/interrupt (not draws), a draw naming no cause (claims nothing), and a refused draw (draw_refused grants nothing, so it leaves the cause unclaimed for a later funded retry).';--> statement-breakpoint

COMMENT ON CONSTRAINT "funded_arms_room_cause_pk" ON "funded_arms" IS
  'THE AT-MOST-ONE-FUNDED-ARM BACKSTOP. commands.ts asks the same question first and gives the legible refusal; this is the authority, and it binds a writer that never passed the command.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ## 3. THE LEDGER-SIDE ROOM-MATCH BACKSTOP (#124 resolution 3)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The gap this closes, exactly. `core_events_payload_room_matches` (0007/0023)
-- pins the payload's OWN `roomId` to the row's `room_id`, so a routing append
-- cannot claim to be in a room it was not filed into. It says nothing about the
-- payload's `causeMessageId`, and the agent is legitimately a member of many
-- rooms — so a routing append filed correctly into room A, naming a cause
-- message from room B, satisfied every ledger constraint. The projections' new
-- composite FKs refuse it, but a projection binds the projection's writer;
-- #124's resolution asked for the backstop on the ledger, and this is it.
--
-- A SEPARATE trigger function rather than another arm inside
-- `atrium_core_events_invariants`: that function is replaced wholesale by any
-- migration that touches it, and a 200-line CREATE OR REPLACE to add nine lines
-- is how an unrelated clause gets dropped by a transcription slip. This one
-- fires BEFORE INSERT on the same table and owes the other nothing.
--
-- The four routed kinds are an ALLOWLIST, not a denylist of the rest: a future
-- event kind that grows a `causeMessageId` is UNCHECKED here until it is named,
-- and that is the honest failure direction — a new kind arrives with its own
-- migration and its own review, whereas a denylist would have silently claimed
-- to cover it. (The repo's own standing lesson: allowlist the compliant form.)
CREATE OR REPLACE FUNCTION "atrium_core_events_routing_cause_same_room"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_cause text;
BEGIN
  IF NEW."payload"->>'type' NOT IN
       ('message_posted', 'plan_opened', 'session_opened', 'session_signaled') THEN
    RETURN NEW;
  END IF;

  v_cause := NEW."payload"->>'causeMessageId';

  -- A routing append that cites nothing is the ordinary case, not a violation.
  IF v_cause IS NULL THEN
    RETURN NEW;
  END IF;

  -- The read takes no row lock: `messages` is append-only substrate and a
  -- message's room never changes (there is no UPDATE path that moves one), so
  -- there is nothing for this check to race against. Contrast 0046's session
  -- reads, which lock precisely because `sessions.status` moves.
  PERFORM 1
    FROM public."messages" m
   WHERE m."room_id" = NEW."room_id"
     AND m."id" = v_cause::uuid;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'routing append % cites cause message %, which is not a message in room %; a routing receipt is same-room by construction and the agent is a member of many rooms',
      NEW."payload"->>'type', v_cause, NEW."room_id"
      USING ERRCODE = '23514',
            CONSTRAINT = 'core_events_routing_cause_same_room';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "core_events_routing_cause_same_room"
  BEFORE INSERT ON "core_events"
  FOR EACH ROW EXECUTE FUNCTION "atrium_core_events_routing_cause_same_room"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_core_events_routing_cause_same_room"() IS
  'THE LEDGER-SIDE ROOM-MATCH BACKSTOP for routing receipts (#128, #124 resolution 3). core_events_payload_room_matches pins the payload''s own roomId to the row''s room_id; nothing pinned the payload''s causeMessageId, and the agent is legitimately a member of many rooms — so an append filed correctly into room A, naming a cause from room B, satisfied every ledger constraint and was refused only by the projection''s composite FK, one layer later, which binds the projection''s writer and not the ledger''s. Composite FKs do not bind JSON. This asks the question on the ledger row itself, for the four routed kinds, as an ALLOWLIST: a future kind that grows a causeMessageId is unchecked here until it is named, which is the honest direction — it arrives with its own migration and its own review. No row lock: messages is append-only and a message''s room never moves.';--> statement-breakpoint

COMMENT ON TRIGGER "core_events_routing_cause_same_room" ON "core_events" IS
  'BEFORE INSERT. See atrium_core_events_routing_cause_same_room. Its own trigger rather than an arm inside atrium_core_events_invariants, because that function is replaced wholesale by any migration touching it and a 200-line CREATE OR REPLACE to add nine lines is how an unrelated clause gets dropped by a transcription slip.';
