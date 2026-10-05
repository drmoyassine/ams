CREATE TABLE "engagement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"review_year" integer NOT NULL,
	"key_dates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_phase" text,
	"status" text DEFAULT 'active' NOT NULL,
	"withdrawn_reason" text,
	"lead_user_id" uuid NOT NULL,
	"previous_engagement_id" uuid,
	"template_synced_version_id" uuid,
	CONSTRAINT "engagement_subject_type_check" CHECK ("engagement"."subject_type" in ('institution', 'program')),
	CONSTRAINT "engagement_kind_check" CHECK ("engagement"."kind" in ('initial', 'reaffirmation')),
	CONSTRAINT "engagement_status_check" CHECK ("engagement"."status" in ('active', 'closed', 'withdrawn')),
	CONSTRAINT "engagement_current_phase_check" CHECK ("engagement"."current_phase" is null or "engagement"."current_phase" in ('eligibility', 'self_study', 'review', 'decision', 'maintenance')),
	CONSTRAINT "engagement_review_year_check" CHECK ("engagement"."review_year" between 1990 and 2200),
	CONSTRAINT "engagement_withdrawn_reason" CHECK ("engagement"."status" <> 'withdrawn' or length(trim(coalesce("engagement"."withdrawn_reason", ''))) > 0)
);
--> statement-breakpoint
CREATE TABLE "engagement_requirement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"applicable" boolean DEFAULT true NOT NULL,
	"na_reason" text,
	"owner_id" uuid,
	"reviewer_id" uuid,
	"status" text DEFAULT 'not_started' NOT NULL,
	"working_notes" text,
	"self_rating" real,
	"due_date" date,
	CONSTRAINT "engagement_requirement_status_check" CHECK ("engagement_requirement"."status" in ('not_started', 'in_progress', 'ready_for_review', 'approved', 'needs_work'))
);
--> statement-breakpoint
CREATE TABLE "milestone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"template_key" text,
	"phase" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"due_date" date,
	"due_rule" jsonb,
	"date_needed" boolean DEFAULT false NOT NULL,
	"owner_id" uuid,
	"status" text DEFAULT 'not_started' NOT NULL,
	"completed_at" timestamp with time zone,
	"report_id" uuid,
	"deliverable" jsonb,
	"source_ref" jsonb,
	"recurrence" jsonb,
	"display_order" integer DEFAULT 0 NOT NULL,
	"origin" text DEFAULT 'template' NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"skip_reason" text,
	CONSTRAINT "milestone_phase_check" CHECK ("milestone"."phase" in ('eligibility', 'self_study', 'review', 'decision', 'maintenance')),
	CONSTRAINT "milestone_type_check" CHECK ("milestone"."type" in ('task', 'deliverable', 'submission', 'external_event', 'decision_point')),
	CONSTRAINT "milestone_status_check" CHECK ("milestone"."status" in ('not_started', 'in_progress', 'done', 'skipped')),
	CONSTRAINT "milestone_origin_check" CHECK ("milestone"."origin" in ('template', 'modified', 'local', 'decision', 'response')),
	CONSTRAINT "milestone_skip_reason" CHECK ("milestone"."status" <> 'skipped' or "milestone"."required" = false or length(trim(coalesce("milestone"."skip_reason", ''))) > 0),
	CONSTRAINT "milestone_done_completed_at" CHECK ("milestone"."status" <> 'done' or "milestone"."completed_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_framework_version_id_framework_version_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_lead_user_id_app_user_id_fk" FOREIGN KEY ("lead_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_previous_engagement_id_engagement_id_fk" FOREIGN KEY ("previous_engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_template_synced_version_id_framework_version_id_fk" FOREIGN KEY ("template_synced_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_requirement" ADD CONSTRAINT "engagement_requirement_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_requirement" ADD CONSTRAINT "engagement_requirement_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_requirement" ADD CONSTRAINT "engagement_requirement_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_requirement" ADD CONSTRAINT "engagement_requirement_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_requirement" ADD CONSTRAINT "engagement_requirement_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_requirement" ADD CONSTRAINT "engagement_requirement_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_requirement" ADD CONSTRAINT "engagement_requirement_reviewer_id_app_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engagement_subject_idx" ON "engagement" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "engagement_version_idx" ON "engagement" USING btree ("framework_version_id");--> statement-breakpoint
CREATE INDEX "engagement_lead_idx" ON "engagement" USING btree ("lead_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "engagement_requirement_unique_idx" ON "engagement_requirement" USING btree ("engagement_id","requirement_id");--> statement-breakpoint
CREATE INDEX "engagement_requirement_owner_idx" ON "engagement_requirement" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "milestone_engagement_idx" ON "milestone" USING btree ("engagement_id","phase","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "milestone_engagement_template_key_idx" ON "milestone" USING btree ("engagement_id","template_key") WHERE "milestone"."template_key" is not null and "milestone"."recurrence" is null;