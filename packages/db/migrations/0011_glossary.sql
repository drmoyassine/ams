CREATE TABLE "glossary_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"framework_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_term" text NOT NULL,
	CONSTRAINT "glossary_alias_source_check" CHECK ("glossary_alias"."source" in ('level_label', 'finding_code', 'report_template'))
);
--> statement-breakpoint
CREATE TABLE "glossary_term" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text,
	"definition_en" text,
	"definition_ar" text,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "glossary_term_kind_check" CHECK ("glossary_term"."kind" in ('level', 'finding', 'report', 'general')),
	CONSTRAINT "glossary_term_key_format" CHECK ("glossary_term"."key" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
ALTER TABLE "glossary_alias" ADD CONSTRAINT "glossary_alias_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glossary_alias" ADD CONSTRAINT "glossary_alias_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glossary_alias" ADD CONSTRAINT "glossary_alias_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glossary_alias" ADD CONSTRAINT "glossary_alias_term_id_glossary_term_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."glossary_term"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glossary_alias" ADD CONSTRAINT "glossary_alias_framework_id_framework_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glossary_term" ADD CONSTRAINT "glossary_term_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glossary_term" ADD CONSTRAINT "glossary_term_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glossary_term" ADD CONSTRAINT "glossary_term_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "glossary_alias_unique_idx" ON "glossary_alias" USING btree ("framework_id","source","external_term");--> statement-breakpoint
CREATE INDEX "glossary_alias_term_idx" ON "glossary_alias" USING btree ("term_id");--> statement-breakpoint
CREATE UNIQUE INDEX "glossary_term_key_idx" ON "glossary_term" USING btree ("institution_id","key");