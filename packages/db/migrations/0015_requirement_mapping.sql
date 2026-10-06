CREATE TABLE "requirement_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"framework_id" uuid NOT NULL,
	"external_code" text NOT NULL,
	"internal_framework_id" uuid NOT NULL,
	"internal_code" text NOT NULL,
	"relation" text NOT NULL,
	"rationale" text,
	"origin" text DEFAULT 'manual' NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "requirement_mapping_relation_check" CHECK ("requirement_mapping"."relation" in ('covers', 'partly_covers', 'related')),
	CONSTRAINT "requirement_mapping_origin_check" CHECK ("requirement_mapping"."origin" in ('manual', 'import', 'ai')),
	CONSTRAINT "requirement_mapping_review_status_check" CHECK ("requirement_mapping"."review_status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "requirement_mapping" ADD CONSTRAINT "requirement_mapping_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_mapping" ADD CONSTRAINT "requirement_mapping_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_mapping" ADD CONSTRAINT "requirement_mapping_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_mapping" ADD CONSTRAINT "requirement_mapping_framework_id_framework_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_mapping" ADD CONSTRAINT "requirement_mapping_internal_framework_id_framework_id_fk" FOREIGN KEY ("internal_framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_mapping" ADD CONSTRAINT "requirement_mapping_reviewed_by_app_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_mapping_unique_idx" ON "requirement_mapping" USING btree ("framework_id","external_code","internal_code");--> statement-breakpoint
CREATE INDEX "requirement_mapping_internal_idx" ON "requirement_mapping" USING btree ("internal_framework_id","internal_code");