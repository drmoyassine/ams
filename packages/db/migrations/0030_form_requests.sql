ALTER TABLE "evidence_request" ALTER COLUMN "internal_framework_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_request" ALTER COLUMN "internal_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_request" ADD COLUMN "data_item_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence_request" ADD COLUMN "response_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence_request" ADD CONSTRAINT "evidence_request_data_item_id_evidence_item_id_fk" FOREIGN KEY ("data_item_id") REFERENCES "public"."evidence_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_request" ADD CONSTRAINT "evidence_request_response_id_dataset_response_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."dataset_response"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_request_data_item_idx" ON "evidence_request" USING btree ("data_item_id");--> statement-breakpoint
ALTER TABLE "evidence_request" ADD CONSTRAINT "evidence_request_target" CHECK (("evidence_request"."internal_framework_id" is not null and "evidence_request"."internal_code" is not null) or "evidence_request"."data_item_id" is not null);