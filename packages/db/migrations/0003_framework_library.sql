CREATE TABLE "accreditor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"type" text NOT NULL,
	"country" text,
	"website" text,
	CONSTRAINT "accreditor_type_check" CHECK ("accreditor"."type" in ('institutional', 'programmatic', 'regulatory'))
);
--> statement-breakpoint
CREATE TABLE "framework" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"accreditor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"commission" text,
	"scope" text NOT NULL,
	"description" text,
	CONSTRAINT "framework_scope_check" CHECK ("framework"."scope" in ('institution', 'program', 'both'))
);
--> statement-breakpoint
CREATE TABLE "framework_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"framework_id" uuid NOT NULL,
	"edition" text NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"level_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lifecycle_template" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision_vocab" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"finding_vocab" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"response_vocab" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rating_method" jsonb,
	"change_summary" text,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	"supersedes_id" uuid,
	CONSTRAINT "framework_version_status_check" CHECK ("framework_version"."status" in ('draft', 'in_review', 'published', 'retired')),
	CONSTRAINT "framework_version_published_fields" CHECK ("framework_version"."status" not in ('published', 'retired') or ("framework_version"."published_at" is not null and "framework_version"."published_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "report_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"structure" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"word_limit" integer,
	"requires_attestation" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"source_document_id" uuid,
	"source_page" integer,
	"source_quote" text,
	"quote_verified" boolean DEFAULT false NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "report_template_kind_check" CHECK ("report_template"."kind" in ('application', 'readiness', 'self_study', 'follow_up', 'annual', 'response', 'other')),
	CONSTRAINT "report_template_origin_check" CHECK ("report_template"."origin" in ('manual', 'import', 'ai')),
	CONSTRAINT "report_template_review_status_check" CHECK ("report_template"."review_status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "report_template_verified_quote_check" CHECK (not "report_template"."quote_verified" or "report_template"."source_quote" is not null)
);
--> statement-breakpoint
CREATE TABLE "requirement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text NOT NULL,
	"level_label" text NOT NULL,
	"title" text NOT NULL,
	"official_text" text,
	"language" text DEFAULT 'en' NOT NULL,
	"translation_en" text,
	"is_assessable" boolean DEFAULT true NOT NULL,
	"applies_when" jsonb,
	"display_order" integer DEFAULT 0 NOT NULL,
	"weight" numeric,
	"origin" text DEFAULT 'manual' NOT NULL,
	"source_document_id" uuid,
	"source_page" integer,
	"source_quote" text,
	"quote_verified" boolean DEFAULT false NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "requirement_origin_check" CHECK ("requirement"."origin" in ('manual', 'import', 'ai')),
	CONSTRAINT "requirement_review_status_check" CHECK ("requirement"."review_status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "requirement_verified_quote_check" CHECK (not "requirement"."quote_verified" or "requirement"."source_quote" is not null)
);
--> statement-breakpoint
CREATE TABLE "requirement_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"type" text NOT NULL,
	"text" text NOT NULL,
	"authority" text NOT NULL,
	"norm" jsonb,
	"origin" text DEFAULT 'manual' NOT NULL,
	"source_document_id" uuid,
	"source_page" integer,
	"source_quote" text,
	"quote_verified" boolean DEFAULT false NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "requirement_note_type_check" CHECK ("requirement_note"."type" in ('guidance', 'evidence_expectation', 'data_request', 'quantitative_norm')),
	CONSTRAINT "requirement_note_authority_check" CHECK ("requirement_note"."authority" in ('required', 'example', 'suggested', 'ai_suggested', 'institution_defined')),
	CONSTRAINT "requirement_note_origin_check" CHECK ("requirement_note"."origin" in ('manual', 'import', 'ai')),
	CONSTRAINT "requirement_note_review_status_check" CHECK ("requirement_note"."review_status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "requirement_note_verified_quote_check" CHECK (not "requirement_note"."quote_verified" or "requirement_note"."source_quote" is not null)
);
--> statement-breakpoint
CREATE TABLE "source_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"title" text NOT NULL,
	"role" text NOT NULL,
	"authority" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"file_path" text NOT NULL,
	"sha256" text NOT NULL,
	"page_count" integer,
	"text_status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "source_document_role_check" CHECK ("source_document"."role" in ('standards', 'policy_procedure', 'guidance', 'report_template', 'evidence_guidance', 'amendment', 'sample_report', 'correspondence', 'other')),
	CONSTRAINT "source_document_authority_check" CHECK ("source_document"."authority" in ('binding', 'interpretive', 'informational')),
	CONSTRAINT "source_document_text_status_check" CHECK ("source_document"."text_status" in ('pending', 'extracted', 'ocr_needed', 'ocr_done', 'failed')),
	CONSTRAINT "source_document_sha256_check" CHECK ("source_document"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "source_page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	"page_no" integer NOT NULL,
	"text" text NOT NULL,
	"method" text NOT NULL,
	"reviewed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "source_page_method_check" CHECK ("source_page"."method" in ('pdf_text', 'ocr')),
	CONSTRAINT "source_page_no_check" CHECK ("source_page"."page_no" >= 1)
);
--> statement-breakpoint
ALTER TABLE "accreditor" ADD CONSTRAINT "accreditor_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accreditor" ADD CONSTRAINT "accreditor_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accreditor" ADD CONSTRAINT "accreditor_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework" ADD CONSTRAINT "framework_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework" ADD CONSTRAINT "framework_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework" ADD CONSTRAINT "framework_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework" ADD CONSTRAINT "framework_accreditor_id_accreditor_id_fk" FOREIGN KEY ("accreditor_id") REFERENCES "public"."accreditor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework_version" ADD CONSTRAINT "framework_version_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework_version" ADD CONSTRAINT "framework_version_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework_version" ADD CONSTRAINT "framework_version_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework_version" ADD CONSTRAINT "framework_version_framework_id_framework_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework_version" ADD CONSTRAINT "framework_version_published_by_app_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework_version" ADD CONSTRAINT "framework_version_supersedes_id_framework_version_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_template" ADD CONSTRAINT "report_template_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_template" ADD CONSTRAINT "report_template_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_template" ADD CONSTRAINT "report_template_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_template" ADD CONSTRAINT "report_template_framework_version_id_framework_version_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_template" ADD CONSTRAINT "report_template_source_document_id_source_document_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_template" ADD CONSTRAINT "report_template_reviewed_by_app_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_framework_version_id_framework_version_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_parent_id_requirement_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."requirement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_source_document_id_source_document_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_reviewed_by_app_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_note" ADD CONSTRAINT "requirement_note_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_note" ADD CONSTRAINT "requirement_note_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_note" ADD CONSTRAINT "requirement_note_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_note" ADD CONSTRAINT "requirement_note_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_note" ADD CONSTRAINT "requirement_note_source_document_id_source_document_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_note" ADD CONSTRAINT "requirement_note_reviewed_by_app_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_document" ADD CONSTRAINT "source_document_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_document" ADD CONSTRAINT "source_document_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_document" ADD CONSTRAINT "source_document_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_document" ADD CONSTRAINT "source_document_framework_version_id_framework_version_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_page" ADD CONSTRAINT "source_page_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_page" ADD CONSTRAINT "source_page_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_page" ADD CONSTRAINT "source_page_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_page" ADD CONSTRAINT "source_page_source_document_id_source_document_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accreditor_short_name_idx" ON "accreditor" USING btree ("institution_id","short_name");--> statement-breakpoint
CREATE INDEX "framework_accreditor_idx" ON "framework" USING btree ("accreditor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "framework_version_edition_idx" ON "framework_version" USING btree ("framework_id","edition");--> statement-breakpoint
CREATE UNIQUE INDEX "report_template_version_key_idx" ON "report_template" USING btree ("framework_version_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_version_code_idx" ON "requirement" USING btree ("framework_version_id","code");--> statement-breakpoint
CREATE INDEX "requirement_parent_idx" ON "requirement" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "requirement_note_requirement_idx" ON "requirement_note" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "source_document_version_idx" ON "source_document" USING btree ("framework_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_page_doc_page_idx" ON "source_page" USING btree ("source_document_id","page_no");--> statement-breakpoint
ALTER TABLE "extraction_item" ADD CONSTRAINT "extraction_item_framework_version_id_framework_version_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_item" ADD CONSTRAINT "extraction_item_source_document_id_source_document_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_document"("id") ON DELETE no action ON UPDATE no action;