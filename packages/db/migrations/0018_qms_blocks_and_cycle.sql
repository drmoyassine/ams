ALTER TABLE "glossary_term" DROP CONSTRAINT "glossary_term_kind_check";--> statement-breakpoint
ALTER TABLE "framework_version" ADD COLUMN "qms_cycle" jsonb;--> statement-breakpoint
ALTER TABLE "glossary_term" ADD CONSTRAINT "glossary_term_kind_check" CHECK ("glossary_term"."kind" in ('block', 'attribute', 'level', 'finding', 'report', 'general'));--> statement-breakpoint
-- "Evidence" was a general term; it is now one of the building blocks of the quality management system.
UPDATE "glossary_term" SET "kind" = 'block' WHERE "key" = 'evidence' AND "kind" = 'general';
