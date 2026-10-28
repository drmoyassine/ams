-- A target may organise what its windows found in one more step (the `organise` stage of the import engine, TASK-111): for the
-- institution's own framework, headings found page by page become one framework of standards and sub-standards. The stage sits
-- between verify and propose.
ALTER TABLE import_run DROP CONSTRAINT import_run_stage_check;
--> statement-breakpoint
ALTER TABLE import_run ADD CONSTRAINT import_run_stage_check CHECK (stage IS NULL OR stage IN ('read', 'extract', 'verify', 'organise', 'propose', 'finalise'));
