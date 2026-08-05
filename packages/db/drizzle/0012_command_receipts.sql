-- Durable whole-command idempotency. The receipt is committed in the same
-- transaction as its ledger batch, so a lost acknowledgement or process crash
-- can recover the exact immutable rows rather than executing the meaning again.
--
-- The interval is room-scoped at both ends. Under the ledger's global append
-- lock a batch occupies consecutive room_seq positions; storing the endpoints
-- and their checked distance names the batch without copying its payload into a
-- second source of truth.
CREATE TABLE "command_receipts" (
	"room_id" uuid NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_id" text NOT NULL,
	"command_name" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_fingerprint" text NOT NULL,
	"first_room_seq" bigint NOT NULL,
	"last_room_seq" bigint NOT NULL,
	"event_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_receipts_key" PRIMARY KEY("room_id","actor_kind","actor_id","command_name","idempotency_key"),
	CONSTRAINT "command_receipts_actor_has_identity" CHECK ("command_receipts"."actor_kind" <> 'system'),
	CONSTRAINT "command_receipts_actor_id_not_blank" CHECK (length("command_receipts"."actor_id") > 0),
	CONSTRAINT "command_receipts_command_name_not_blank" CHECK (length("command_receipts"."command_name") > 0),
	CONSTRAINT "command_receipts_idempotency_key_bounded" CHECK (length("command_receipts"."idempotency_key") BETWEEN 1 AND 128),
	CONSTRAINT "command_receipts_fingerprint_is_sha256" CHECK ("command_receipts"."payload_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "command_receipts_event_count_positive" CHECK ("command_receipts"."event_count" > 0),
	CONSTRAINT "command_receipts_first_seq_positive" CHECK ("command_receipts"."first_room_seq" > 0),
	CONSTRAINT "command_receipts_interval_matches_count" CHECK ("command_receipts"."last_room_seq" = "command_receipts"."first_room_seq" + "command_receipts"."event_count" - 1)
);
--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_first_event_same_room_fk" FOREIGN KEY ("room_id","first_room_seq") REFERENCES "public"."core_events"("room_id","room_seq") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_last_event_same_room_fk" FOREIGN KEY ("room_id","last_room_seq") REFERENCES "public"."core_events"("room_id","room_seq") ON DELETE no action ON UPDATE no action;
