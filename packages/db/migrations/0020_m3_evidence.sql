CREATE TABLE "evidence_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"owner_unit_id" uuid,
	"owner_user_id" uuid,
	"period_label" text,
	"confidentiality" text DEFAULT 'internal' NOT NULL,
	"contains_student_data" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "evidence_item_type_check" CHECK ("evidence_item"."type" in ('document', 'dataset', 'url', 'minutes', 'policy', 'report', 'other')),
	CONSTRAINT "evidence_item_confidentiality_check" CHECK ("evidence_item"."confidentiality" in ('public', 'internal', 'restricted')),
	CONSTRAINT "evidence_item_status_check" CHECK ("evidence_item"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "evidence_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"evidence_version_id" uuid NOT NULL,
	"engagement_requirement_id" uuid,
	"internal_framework_id" uuid,
	"internal_code" text,
	"rationale" text NOT NULL,
	"linked_by" uuid,
	"review_status" text DEFAULT 'proposed' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_comment" text,
	CONSTRAINT "evidence_link_review_check" CHECK ("evidence_link"."review_status" in ('proposed', 'approved', 'rejected')),
	CONSTRAINT "evidence_link_rationale" CHECK (length(trim("evidence_link"."rationale")) > 0),
	CONSTRAINT "evidence_link_one_target" CHECK (("evidence_link"."engagement_requirement_id" is not null) <> ("evidence_link"."internal_framework_id" is not null and "evidence_link"."internal_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "evidence_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"evidence_item_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"file_path" text,
	"url" text,
	"sha256" text,
	"file_name" text,
	"mime" text,
	"size" integer,
	"as_of_date" date,
	"notes" text,
	"data" jsonb,
	"lineage" jsonb,
	CONSTRAINT "evidence_version_content" CHECK (("evidence_version"."file_path" is not null and "evidence_version"."sha256" is not null) or "evidence_version"."url" is not null or "evidence_version"."data" is not null)
);
--> statement-breakpoint
ALTER TABLE "evidence_item" ADD CONSTRAINT "evidence_item_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_item" ADD CONSTRAINT "evidence_item_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_item" ADD CONSTRAINT "evidence_item_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_item" ADD CONSTRAINT "evidence_item_owner_unit_id_org_unit_id_fk" FOREIGN KEY ("owner_unit_id") REFERENCES "public"."org_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_item" ADD CONSTRAINT "evidence_item_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_link" ADD CONSTRAINT "evidence_link_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_link" ADD CONSTRAINT "evidence_link_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_link" ADD CONSTRAINT "evidence_link_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_link" ADD CONSTRAINT "evidence_link_evidence_version_id_evidence_version_id_fk" FOREIGN KEY ("evidence_version_id") REFERENCES "public"."evidence_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_link" ADD CONSTRAINT "evidence_link_engagement_requirement_id_engagement_requirement_id_fk" FOREIGN KEY ("engagement_requirement_id") REFERENCES "public"."engagement_requirement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_link" ADD CONSTRAINT "evidence_link_internal_framework_id_framework_id_fk" FOREIGN KEY ("internal_framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_link" ADD CONSTRAINT "evidence_link_linked_by_app_user_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_link" ADD CONSTRAINT "evidence_link_reviewed_by_app_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_version" ADD CONSTRAINT "evidence_version_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_version" ADD CONSTRAINT "evidence_version_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_version" ADD CONSTRAINT "evidence_version_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_version" ADD CONSTRAINT "evidence_version_evidence_item_id_evidence_item_id_fk" FOREIGN KEY ("evidence_item_id") REFERENCES "public"."evidence_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_link_version_idx" ON "evidence_link" USING btree ("evidence_version_id");--> statement-breakpoint
CREATE INDEX "evidence_link_er_idx" ON "evidence_link" USING btree ("engagement_requirement_id");--> statement-breakpoint
CREATE INDEX "evidence_link_internal_idx" ON "evidence_link" USING btree ("internal_framework_id","internal_code");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_version_no_idx" ON "evidence_version" USING btree ("evidence_item_id","version_no");