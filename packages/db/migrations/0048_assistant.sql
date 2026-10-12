CREATE TABLE "assistant_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"context" jsonb,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assistant_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text,
	"error" text,
	"usage" jsonb,
	"context" jsonb,
	CONSTRAINT "assistant_message_role_check" CHECK ("assistant_message"."role" in ('user', 'assistant', 'system_note')),
	CONSTRAINT "assistant_message_status_check" CHECK ("assistant_message"."status" is null or "assistant_message"."status" in ('queued', 'running', 'done', 'failed', 'cancelled')),
	CONSTRAINT "assistant_message_status_role_check" CHECK (("assistant_message"."role" = 'assistant') = ("assistant_message"."status" is not null))
);
--> statement-breakpoint
CREATE TABLE "memory_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"visibility" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"source_conversation_id" uuid,
	"source_message_id" uuid,
	"pinned" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"supersedes_id" uuid,
	CONSTRAINT "memory_item_scope_type_check" CHECK ("memory_item"."scope_type" in ('institution', 'framework', 'version', 'engagement')),
	CONSTRAINT "memory_item_visibility_check" CHECK ("memory_item"."visibility" in ('private', 'workspace')),
	CONSTRAINT "memory_item_kind_check" CHECK ("memory_item"."kind" in ('preference', 'convention', 'fact', 'decision')),
	CONSTRAINT "memory_item_scope_id_check" CHECK (("memory_item"."scope_type" = 'institution') = ("memory_item"."scope_id" is null)),
	CONSTRAINT "memory_item_text_length_check" CHECK (char_length("memory_item"."text") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_type_check";--> statement-breakpoint
ALTER TABLE "ai_setting" ADD COLUMN "assistant_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD COLUMN "assistant_account_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD COLUMN "assistant_model" text;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD COLUMN "assistant_max_tokens" integer;--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD CONSTRAINT "assistant_conversation_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD CONSTRAINT "assistant_conversation_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD CONSTRAINT "assistant_conversation_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD CONSTRAINT "assistant_conversation_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_message" ADD CONSTRAINT "assistant_message_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_message" ADD CONSTRAINT "assistant_message_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_message" ADD CONSTRAINT "assistant_message_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_message" ADD CONSTRAINT "assistant_message_conversation_id_assistant_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_item" ADD CONSTRAINT "memory_item_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_item" ADD CONSTRAINT "memory_item_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_item" ADD CONSTRAINT "memory_item_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_item" ADD CONSTRAINT "memory_item_source_conversation_id_assistant_conversation_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."assistant_conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_item" ADD CONSTRAINT "memory_item_source_message_id_assistant_message_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."assistant_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_item" ADD CONSTRAINT "memory_item_supersedes_id_memory_item_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."memory_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_conversation_user_idx" ON "assistant_conversation" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "assistant_message_conversation_idx" ON "assistant_message" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_item_scope_idx" ON "memory_item" USING btree ("institution_id","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "memory_item_author_idx" ON "memory_item" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "ai_setting" ADD CONSTRAINT "ai_setting_assistant_account_id_ai_account_id_fk" FOREIGN KEY ("assistant_account_id") REFERENCES "public"."ai_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD CONSTRAINT "ai_setting_assistant_tokens_check" CHECK ("ai_setting"."assistant_max_tokens" is null or "ai_setting"."assistant_max_tokens" > 0);--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_type_check" CHECK ("job"."type" in ('extract_text', 'ocr', 'ai_extract', 'export', 'notify', 'analyse', 'purge_trash', 'assistant'));