CREATE TABLE "attachments" (
  "id" uuid PRIMARY KEY NOT NULL,
  "room_id" uuid NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "content_type" text NOT NULL,
  "size" integer NOT NULL,
  "claimed_by_message_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "attachments_name_not_blank" CHECK (length("attachments"."name") > 0),
  CONSTRAINT "attachments_content_type_not_blank" CHECK (length("attachments"."content_type") > 0),
  CONSTRAINT "attachments_size_positive" CHECK ("attachments"."size" > 0),
  CONSTRAINT "attachments_size_bounded" CHECK ("attachments"."size" <= 26214400)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_room_id_key" ON "attachments" ("room_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_room_key_key" ON "attachments" ("room_id", "key");
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_room_id_rooms_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_claim_message_same_room_fk"
  FOREIGN KEY ("room_id", "claimed_by_message_id") REFERENCES "public"."messages"("room_id", "id");
--> statement-breakpoint
CREATE TABLE "message_references" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "room_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "kind" "message_reference_kind" NOT NULL,
  "target_id" uuid NOT NULL,
  "start" integer NOT NULL,
  "end" integer NOT NULL,
  "surface" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "message_references_ordinal_nonnegative" CHECK ("ordinal" >= 0),
  CONSTRAINT "message_references_span_nonempty" CHECK ("start" >= 0 AND "end" > "start"),
  CONSTRAINT "message_references_surface_not_blank" CHECK (length("surface") > 0),
  CONSTRAINT "message_references_surface_is_address" CHECK (left("surface", 1) = '@')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "message_references_message_ordinal_key" ON "message_references" ("message_id", "ordinal");
--> statement-breakpoint
CREATE UNIQUE INDEX "message_references_room_id_key" ON "message_references" ("room_id", "id");
--> statement-breakpoint
CREATE INDEX "message_references_target_idx" ON "message_references" ("room_id", "kind", "target_id");
--> statement-breakpoint
ALTER TABLE "message_references" ADD CONSTRAINT "message_references_message_same_room_fk"
  FOREIGN KEY ("room_id", "message_id") REFERENCES "public"."messages"("room_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "attention_items" ADD COLUMN "subject_object_id" uuid
  GENERATED ALWAYS AS (CASE WHEN subject_kind = 'object' THEN subject_id END) STORED;
--> statement-breakpoint
ALTER TABLE "attention_items" ADD COLUMN "subject_proposal_id" uuid
  GENERATED ALWAYS AS (CASE WHEN subject_kind = 'proposal' THEN subject_id END) STORED;
--> statement-breakpoint
ALTER TABLE "attention_items" ADD COLUMN "subject_message_id" uuid
  GENERATED ALWAYS AS (CASE WHEN subject_kind = 'message' THEN subject_id END) STORED;
--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_object_same_room_fk"
  FOREIGN KEY ("room_id", "subject_object_id") REFERENCES "public"."accepted_objects"("room_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_proposal_same_room_fk"
  FOREIGN KEY ("room_id", "subject_proposal_id") REFERENCES "public"."proposals"("room_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_message_same_room_fk"
  FOREIGN KEY ("room_id", "subject_message_id") REFERENCES "public"."messages"("room_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "atrium_utf16_slice"(input text, start_offset integer, end_offset integer)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  cursor_units integer := 0;
  character text;
  width integer;
  output text := '';
  taking boolean := false;
BEGIN
  IF start_offset < 0 OR end_offset <= start_offset THEN RETURN NULL; END IF;
  FOR character IN SELECT regexp_split_to_table(input, '') LOOP
    width := CASE WHEN ascii(character) > 65535 THEN 2 ELSE 1 END;
    IF cursor_units = start_offset THEN taking := true; END IF;
    IF cursor_units < start_offset AND cursor_units + width > start_offset THEN RETURN NULL; END IF;
    IF taking AND cursor_units < end_offset THEN output := output || character; END IF;
    cursor_units := cursor_units + width;
    IF cursor_units = end_offset THEN RETURN output; END IF;
    IF cursor_units > end_offset THEN RETURN NULL; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_message_reference_target"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_exists boolean := false;
  authored_body text;
BEGIN
  SELECT m.body INTO authored_body
  FROM messages m WHERE m.room_id = NEW.room_id AND m.id = NEW.message_id;
  IF authored_body IS NULL OR atrium_utf16_slice(authored_body, NEW.start, NEW."end") IS DISTINCT FROM NEW.surface THEN
    RAISE EXCEPTION 'message reference surface does not match authored body' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.ordinal <> (
    SELECT count(*)::integer FROM message_references r WHERE r.message_id = NEW.message_id
  ) THEN
    RAISE EXCEPTION 'message reference ordinal is not contiguous' USING ERRCODE = '23514';
  END IF;

  CASE NEW.kind
    WHEN 'human' THEN
      SELECT EXISTS (SELECT 1 FROM memberships m WHERE m.room_id = NEW.room_id AND m.user_id = NEW.target_id) INTO target_exists;
    WHEN 'attachment' THEN
      SELECT EXISTS (SELECT 1 FROM attachments a WHERE a.room_id = NEW.room_id AND a.id = NEW.target_id AND a.claimed_by_message_id = NEW.message_id) INTO target_exists;
    WHEN 'proposal' THEN
      SELECT EXISTS (SELECT 1 FROM proposals p WHERE p.room_id = NEW.room_id AND p.id = NEW.target_id) INTO target_exists;
    WHEN 'object' THEN
      SELECT EXISTS (SELECT 1 FROM accepted_objects o WHERE o.room_id = NEW.room_id AND o.id = NEW.target_id) INTO target_exists;
    ELSE
      RAISE EXCEPTION 'unsupported message reference kind' USING ERRCODE = '23514';
  END CASE;
  IF NOT target_exists THEN RAISE EXCEPTION 'message reference target unavailable' USING ERRCODE = '23514'; END IF;

  IF EXISTS (
    SELECT 1 FROM message_references r
    WHERE r.message_id = NEW.message_id AND r.id <> NEW.id
      AND int4range(r.start, r."end", '[)') && int4range(NEW.start, NEW."end", '[)')
  ) THEN
    RAISE EXCEPTION 'message reference spans overlap' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "message_references_validate_target"
BEFORE INSERT OR UPDATE ON "message_references"
FOR EACH ROW EXECUTE FUNCTION "validate_message_reference_target"();
