-- The internal framework is kept simple: no quality cycle and no building-block definitions. "Evidence" goes back to
-- being a general term; the other building blocks and the two attributes are removed (nothing refers to them).
ALTER TABLE "glossary_term" DROP CONSTRAINT "glossary_term_kind_check";--> statement-breakpoint
ALTER TABLE "framework_version" DROP COLUMN "qms_cycle";--> statement-breakpoint
UPDATE "glossary_term" SET "kind" = 'general' WHERE "key" = 'evidence' AND "kind" = 'block';--> statement-breakpoint
DELETE FROM "glossary_term" WHERE "kind" IN ('block', 'attribute');--> statement-breakpoint
ALTER TABLE "glossary_term" ADD CONSTRAINT "glossary_term_kind_check" CHECK ("glossary_term"."kind" in ('level', 'finding', 'report', 'general'));
