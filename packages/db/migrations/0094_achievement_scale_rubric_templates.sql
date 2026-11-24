-- THE ACHIEVEMENT SCALE AND RUBRIC TEMPLATES (the owner, 2026-11-24): Settings, Outcomes & Syllabus.
--   institution.achievement_scale  the levels every rubric is described at (name, score range) and the target level, whose lowest
--                                  score is the CLO score target (assessment_benchmarks.cloScore follows it); null = the default scale;
--   institution.rubric_templates   the rubrics coordinators start from, one per kind of assessment; null = the default templates.
ALTER TABLE institution ADD COLUMN achievement_scale jsonb;--> statement-breakpoint
ALTER TABLE institution ADD COLUMN rubric_templates jsonb;
