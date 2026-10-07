CREATE TABLE "dataset_spec" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"evidence_item_id" uuid NOT NULL,
	"definition" text,
	"grain" text,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_kind" text DEFAULT 'manual_upload' NOT NULL,
	"source_config" jsonb,
	CONSTRAINT "dataset_spec_source_check" CHECK ("dataset_spec"."source_kind" in ('manual_upload', 'governed_metric'))
);
--> statement-breakpoint
ALTER TABLE "dataset_spec" ADD CONSTRAINT "dataset_spec_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_spec" ADD CONSTRAINT "dataset_spec_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_spec" ADD CONSTRAINT "dataset_spec_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_spec" ADD CONSTRAINT "dataset_spec_evidence_item_id_evidence_item_id_fk" FOREIGN KEY ("evidence_item_id") REFERENCES "public"."evidence_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_spec_item_idx" ON "dataset_spec" USING btree ("evidence_item_id");