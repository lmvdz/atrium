CREATE TYPE "public"."accepted_object_type" AS ENUM('decision', 'commitment', 'open_question', 'claim', 'objective');--> statement-breakpoint
CREATE TYPE "public"."attention_class" AS ENUM('needs_decision', 'owned_commitment', 'mention', 'blocking_question');--> statement-breakpoint
CREATE TYPE "public"."attention_status" AS ENUM('pending', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."correction_action" AS ENUM('amend', 'retract', 'restore');--> statement-breakpoint
CREATE TYPE "public"."interpretation_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('proposed', 'accepted', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."proposer_kind" AS ENUM('model', 'human');--> statement-breakpoint
CREATE TYPE "public"."relation_kind" AS ENUM('supersedes', 'depends_on', 'blocks', 'answers', 'evidence');--> statement-breakpoint
CREATE TABLE "accepted_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"type" "accepted_object_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"objective_id" uuid,
	"proposal_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"retracted_at" timestamp with time zone,
	"superseded_by_id" uuid,
	"accepted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attention_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"class" "attention_class" NOT NULL,
	"rationale" text NOT NULL,
	"status" "attention_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "attention_items_rationale_present" CHECK (length(btrim("attention_items"."rationale")) > 0)
);
--> statement-breakpoint
CREATE TABLE "corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_id" uuid NOT NULL,
	"action" "correction_action" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"by_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interpretations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"interpretation_version" integer DEFAULT 1 NOT NULL,
	"model" text,
	"status" "interpretation_status" DEFAULT 'pending' NOT NULL,
	"raw" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_seq" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"room_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"reply_to_id" uuid,
	"client_message_id" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"kind" "relation_kind" NOT NULL,
	"from_object_id" uuid NOT NULL,
	"to_object_id" uuid,
	"to_message_id" uuid,
	"to_url" text,
	"to_file_key" text,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relations_single_target" CHECK ((CASE WHEN "relations"."to_object_id" IS NULL THEN 0 ELSE 1 END
         + CASE WHEN "relations"."to_message_id" IS NULL THEN 0 ELSE 1 END
         + CASE WHEN "relations"."to_url" IS NULL THEN 0 ELSE 1 END
         + CASE WHEN "relations"."to_file_key" IS NULL THEN 0 ELSE 1 END) = 1),
	CONSTRAINT "relations_structural_targets_object" CHECK ("relations"."kind" = 'evidence' OR "relations"."to_object_id" IS NOT NULL),
	CONSTRAINT "relations_evidence_targets_source" CHECK ("relations"."kind" <> 'evidence' OR "relations"."to_object_id" IS NULL),
	CONSTRAINT "relations_no_self_edge" CHECK ("relations"."from_object_id" <> "relations"."to_object_id" OR "relations"."to_object_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "object_sources" (
	"object_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	CONSTRAINT "object_sources_object_id_message_id_pk" PRIMARY KEY("object_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "proposal_sources" (
	"proposal_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	CONSTRAINT "proposal_sources_proposal_id_message_id_pk" PRIMARY KEY("proposal_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"interpretation_id" uuid,
	"type" "accepted_object_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"confidence" real NOT NULL,
	"proposer_kind" "proposer_kind" NOT NULL,
	"proposer_model" text,
	"proposer_user_id" uuid,
	"status" "proposal_status" DEFAULT 'proposed' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_confidence_range" CHECK ("proposals"."confidence" >= 0 AND "proposals"."confidence" <= 1),
	CONSTRAINT "proposals_proposer_identified" CHECK (("proposals"."proposer_kind" = 'model' AND "proposals"."proposer_model" IS NOT NULL)
          OR ("proposals"."proposer_kind" = 'human' AND "proposals"."proposer_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"active_organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inviter_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invitations_status_known" CHECK ("workspace_invitations"."status" IN ('pending', 'accepted', 'rejected', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accepted_objects" ADD CONSTRAINT "accepted_objects_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_objects" ADD CONSTRAINT "accepted_objects_objective_id_accepted_objects_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."accepted_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_objects" ADD CONSTRAINT "accepted_objects_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_objects" ADD CONSTRAINT "accepted_objects_superseded_by_id_accepted_objects_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."accepted_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_objects" ADD CONSTRAINT "accepted_objects_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_object_id_accepted_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."accepted_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_object_id_accepted_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."accepted_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_from_object_id_accepted_objects_id_fk" FOREIGN KEY ("from_object_id") REFERENCES "public"."accepted_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_object_id_accepted_objects_id_fk" FOREIGN KEY ("to_object_id") REFERENCES "public"."accepted_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_message_id_messages_id_fk" FOREIGN KEY ("to_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_sources" ADD CONSTRAINT "object_sources_object_id_accepted_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."accepted_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_sources" ADD CONSTRAINT "object_sources_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_sources" ADD CONSTRAINT "proposal_sources_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_sources" ADD CONSTRAINT "proposal_sources_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_interpretation_id_interpretations_id_fk" FOREIGN KEY ("interpretation_id") REFERENCES "public"."interpretations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_proposer_user_id_users_id_fk" FOREIGN KEY ("proposer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_active_organization_id_workspaces_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_organization_id_workspaces_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_organization_id_workspaces_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accepted_objects_room_type_idx" ON "accepted_objects" USING btree ("room_id","type");--> statement-breakpoint
CREATE INDEX "accepted_objects_objective_idx" ON "accepted_objects" USING btree ("objective_id");--> statement-breakpoint
CREATE INDEX "accepted_objects_live_idx" ON "accepted_objects" USING btree ("room_id","type") WHERE "accepted_objects"."retracted_at" IS NULL AND "accepted_objects"."superseded_by_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "attention_items_user_object_class_key" ON "attention_items" USING btree ("user_id","object_id","class");--> statement-breakpoint
CREATE INDEX "attention_items_user_status_idx" ON "attention_items" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "corrections_object_idx" ON "corrections" USING btree ("object_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "interpretations_message_version_key" ON "interpretations" USING btree ("message_id","interpretation_version");--> statement-breakpoint
CREATE INDEX "interpretations_status_idx" ON "interpretations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_room_user_key" ON "memberships" USING btree ("room_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_seq_key" ON "messages" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "messages_room_seq_idx" ON "messages" USING btree ("room_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_room_client_id_key" ON "messages" USING btree ("room_id","client_message_id");--> statement-breakpoint
CREATE INDEX "relations_from_idx" ON "relations" USING btree ("from_object_id","kind");--> statement-breakpoint
CREATE INDEX "relations_to_object_idx" ON "relations" USING btree ("to_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relations_edge_key" ON "relations" USING btree ("from_object_id","kind","to_object_id") WHERE "relations"."to_object_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "proposals_room_status_idx" ON "proposals" USING btree ("room_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_workspace_slug_key" ON "rooms" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "rooms_workspace_idx" ON "rooms" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_account_key" ON "auth_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "auth_accounts_user_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_key" ON "auth_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "auth_verifications_expires_idx" ON "auth_verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "workspace_invitations_org_idx" ON "workspace_invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "workspace_invitations_email_idx" ON "workspace_invitations" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_org_user_key" ON "workspace_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");