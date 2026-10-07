CREATE TABLE "dataset_response" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"evidence_item_id" uuid NOT NULL,
	"answers" jsonb NOT NULL,
	"via" text NOT NULL,
	"submitted_by" uuid,
	"included_in_version_id" uuid,
	CONSTRAINT "dataset_response_via_check" CHECK ("dataset_response"."via" in ('ams', 'link'))
);
--> statement-breakpoint
ALTER TABLE "dataset_spec" ADD COLUMN "form_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "dataset_spec" ADD COLUMN "form_link_token" text;--> statement-breakpoint
ALTER TABLE "dataset_response" ADD CONSTRAINT "dataset_response_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_response" ADD CONSTRAINT "dataset_response_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_response" ADD CONSTRAINT "dataset_response_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_response" ADD CONSTRAINT "dataset_response_evidence_item_id_evidence_item_id_fk" FOREIGN KEY ("evidence_item_id") REFERENCES "public"."evidence_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_response" ADD CONSTRAINT "dataset_response_submitted_by_app_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_response" ADD CONSTRAINT "dataset_response_included_in_version_id_evidence_version_id_fk" FOREIGN KEY ("included_in_version_id") REFERENCES "public"."evidence_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dataset_response_item_idx" ON "dataset_response" USING btree ("evidence_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_spec_form_link_idx" ON "dataset_spec" USING btree ("form_link_token");