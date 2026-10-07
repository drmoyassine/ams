CREATE TABLE "evidence_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"internal_framework_id" uuid NOT NULL,
	"internal_code" text NOT NULL,
	"title" text NOT NULL,
	"message" text,
	"assignee_email" text NOT NULL,
	"assignee_user_id" uuid,
	"due_date" date,
	"status" text DEFAULT 'open' NOT NULL,
	"requested_by" uuid,
	"token_hash" text,
	"token_expires_at" timestamp with time zone,
	"supplied_at" timestamp with time zone,
	"supplied_note" text,
	"evidence_link_id" uuid,
	CONSTRAINT "evidence_request_status_check" CHECK ("evidence_request"."status" in ('open', 'supplied', 'cancelled')),
	CONSTRAINT "evidence_request_title" CHECK (length(trim("evidence_request"."title")) > 0)
);
--> statement-breakpoint
ALTER TABLE "evidence_request" ADD CONSTRAINT "evidence_request_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_request" ADD CONSTRAINT "evidence_request_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_request" ADD CONSTRAINT "evidence_request_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_request" ADD CONSTRAINT "evidence_request_internal_framework_id_framework_id_fk" FOREIGN KEY ("internal_framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_request" ADD CONSTRAINT "evidence_request_assignee_user_id_app_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_request" ADD CONSTRAINT "evidence_request_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_request" ADD CONSTRAINT "evidence_request_evidence_link_id_evidence_link_id_fk" FOREIGN KEY ("evidence_link_id") REFERENCES "public"."evidence_link"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_request_internal_idx" ON "evidence_request" USING btree ("internal_framework_id","internal_code");--> statement-breakpoint
CREATE INDEX "evidence_request_assignee_idx" ON "evidence_request" USING btree ("assignee_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_request_token_idx" ON "evidence_request" USING btree ("token_hash");