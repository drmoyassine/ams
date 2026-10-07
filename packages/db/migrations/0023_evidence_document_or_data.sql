-- Evidence type is now simply a document or data. The earlier kinds (policy, minutes, report …) are kept as the
-- sub-type, for the sub-types to come; datasets become data, everything else a document.
ALTER TABLE "evidence_item" DROP CONSTRAINT "evidence_item_type_check";--> statement-breakpoint
ALTER TABLE "evidence_item" ADD COLUMN "subtype" text;--> statement-breakpoint
UPDATE "evidence_item" SET "subtype" = "type" WHERE "type" NOT IN ('document', 'dataset');--> statement-breakpoint
UPDATE "evidence_item" SET "type" = CASE WHEN "type" = 'dataset' THEN 'data' ELSE 'document' END;--> statement-breakpoint
ALTER TABLE "evidence_item" ADD CONSTRAINT "evidence_item_type_check" CHECK ("evidence_item"."type" in ('document', 'data'));
