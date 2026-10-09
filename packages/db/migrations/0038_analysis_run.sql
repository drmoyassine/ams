CREATE TABLE "analysis_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model" text,
	"prompt_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage" jsonb DEFAULT '{"inputTokens":0,"outputTokens":0,"costUsd":null,"calls":0}'::jsonb NOT NULL,
	"error" text,
	"started_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "analysis_run_status_check" CHECK ("analysis_run"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "analysis_run_stage_check" CHECK ("analysis_run"."stage" is null or "analysis_run"."stage" in ('read', 'survey', 'structure', 'extract', 'write', 'finalise'))
);
--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_type_check";--> statement-breakpoint
ALTER TABLE "extraction_item" ADD COLUMN "analysis_run_id" uuid;--> statement-breakpoint
ALTER TABLE "requirement" ADD COLUMN "edited_by_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "requirement_note" ADD COLUMN "edited_by_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "source_document" ADD COLUMN "role_origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_framework_version_id_framework_version_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_started_by_app_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_run_version_idx" ON "analysis_run" USING btree ("framework_version_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_run_one_active_idx" ON "analysis_run" USING btree ("framework_version_id") WHERE "analysis_run"."status" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "extraction_item" ADD CONSTRAINT "extraction_item_analysis_run_id_analysis_run_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."analysis_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extraction_item_run_idx" ON "extraction_item" USING btree ("analysis_run_id");--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_type_check" CHECK ("job"."type" in ('extract_text', 'ocr', 'ai_extract', 'export', 'notify', 'analyse'));--> statement-breakpoint
ALTER TABLE "source_document" ADD CONSTRAINT "source_document_role_origin_check" CHECK ("source_document"."role_origin" in ('manual', 'ai', 'unset'));