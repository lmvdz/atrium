CREATE TYPE "public"."message_reference_kind" AS ENUM('human', 'attachment', 'proposal', 'object');
--> statement-breakpoint
ALTER TABLE "attention_items" DROP CONSTRAINT "attention_items_object_same_room_fk";
--> statement-breakpoint
ALTER TABLE "attention_items" DROP CONSTRAINT "attention_items_proposal_same_room_fk";
--> statement-breakpoint
ALTER TABLE "attention_items" DROP COLUMN "subject_object_id";
--> statement-breakpoint
ALTER TABLE "attention_items" DROP COLUMN "subject_proposal_id";
--> statement-breakpoint
ALTER TABLE "attention_items" ALTER COLUMN "subject_kind" TYPE text USING "subject_kind"::text;
--> statement-breakpoint
DROP TYPE "public"."attention_subject_kind";
--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_subject_kind_allowlist"
  CHECK ("subject_kind" IN ('object', 'proposal', 'message'));
