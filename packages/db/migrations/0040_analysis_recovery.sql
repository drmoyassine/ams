CREATE TABLE "analysis_dismissal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"note_text" text,
	CONSTRAINT "analysis_dismissal_kind_check" CHECK ("analysis_dismissal"."kind" in ('requirement', 'note')),
	CONSTRAINT "analysis_dismissal_note_text_check" CHECK (("analysis_dismissal"."kind" = 'note') = ("analysis_dismissal"."note_text" is not null))
);
--> statement-breakpoint
ALTER TABLE "analysis_run" DROP CONSTRAINT "analysis_run_stage_check";--> statement-breakpoint
ALTER TABLE "ai_setting" ADD COLUMN "max_recovery_rounds" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_dismissal" ADD CONSTRAINT "analysis_dismissal_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_dismissal" ADD CONSTRAINT "analysis_dismissal_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_dismissal" ADD CONSTRAINT "analysis_dismissal_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_dismissal" ADD CONSTRAINT "analysis_dismissal_framework_version_id_framework_version_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_dismissal_version_idx" ON "analysis_dismissal" USING btree ("framework_version_id");--> statement-breakpoint
ALTER TABLE "ai_setting" ADD CONSTRAINT "ai_setting_recovery_rounds_check" CHECK ("ai_setting"."max_recovery_rounds" between 0 and 5);--> statement-breakpoint
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_stage_check" CHECK ("analysis_run"."stage" is null or "analysis_run"."stage" in ('read', 'survey', 'structure', 'extract', 'gaps', 'recover', 'write', 'finalise'));