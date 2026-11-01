-- PROGRAM REVIEW BY RUBRIC (TASK-118, docs/assessment-of-learning-plan.md section 7).
--
--   institution.review_rubric   the rubric (criteria with key questions and evidence to review) and the maturity levels, as
--                               configuration; the default is the 8-criterion assessment-of-learning rubric of the 2026 baseline;
--   program_review_finding      one judgement of one program on one criterion in one pass: level, finding, evidence seen, gaps,
--                               date, basis. Append-only, like the workbook it mirrors: a later pass adds a row, the latest row is
--                               the current judgement, and the history stays. Levels are internal maturity, never an accreditation
--                               judgement (DEC-005).
ALTER TABLE institution ADD COLUMN review_rubric jsonb DEFAULT '{"name":"Assessment of learning: program review","levels":[{"code":"not_evident","name":"Not evident","description":"No documented practice found."},{"code":"emerging","name":"Emerging","description":"Some documents exist but are incomplete, inconsistent or not in use."},{"code":"developing","name":"Developing","description":"Documented and partly in use; gaps against the policy or the key questions."},{"code":"established","name":"Established","description":"Documented, current, in regular use, with evidence of review."},{"code":"pending","name":"Pending review","description":"Cannot be judged from the sources seen so far."}],"criteria":[{"no":1,"name":"Program mission","questions":"Does the program have a published mission statement? Is it aligned with the university mission and its constituencies?","evidence":"Program catalog, website, self-study"},{"no":2,"name":"Educational objectives","questions":"Are objectives clearly stated, measurable, consistent with stakeholder needs, and reviewed on a set cycle? Are changes over recent years documented?","evidence":"Program document, advisory board minutes, review records"},{"no":3,"name":"Program learning outcomes","questions":"Are PLOs documented, measurable, and adequate in breadth and depth to achieve the objectives? Do they use appropriate cognitive levels and avoid overlap?","evidence":"Approved program document, catalog"},{"no":4,"name":"PLO-to-CLO mapping","questions":"Is every PLO addressed by courses at introduced, reinforced and mastered levels? Does every course map to at least one PLO? Are there orphan or over-covered outcomes?","evidence":"Curriculum map, course syllabi"},{"no":5,"name":"Assessment design","questions":"Is there a documented assessment plan with direct and indirect measures for each PLO, designated courses, a schedule, targets, and rubrics? Do course assessments actually test the CLOs?","evidence":"Assessment plan, syllabi, assessment instruments"},{"no":6,"name":"Assessment results","questions":"Is the plan being carried out regularly? Are results collected and analyzed against targets for each PLO, with a stated sample and method?","evidence":"Assessment reports, data sets, dashboards"},{"no":7,"name":"Closing the loop","questions":"Are findings used for action plans on curriculum, teaching and resources? Is there evidence of follow-up and re-assessment?","evidence":"Action plans, committee minutes, revised syllabi"},{"no":8,"name":"Stakeholder input and external validation","questions":"Is there input from students, graduates, employers and industry? Have accreditor or external reviewer recommendations been addressed? Do indirect measures inform outcomes?","evidence":"Surveys, advisory board records, review reports, accreditor observations"}]}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE program_review_finding (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	program_id uuid NOT NULL REFERENCES program(id) ON DELETE CASCADE,
	criterion_no integer NOT NULL,
	level text NOT NULL,
	finding text NOT NULL,
	evidence text,
	gaps text,
	audit_date date NOT NULL,
	pass integer DEFAULT 1 NOT NULL,
	basis text,
	source text,
	CONSTRAINT program_review_finding_criterion_check CHECK (criterion_no BETWEEN 1 AND 50),
	CONSTRAINT program_review_finding_pass_check CHECK (pass BETWEEN 1 AND 99),
	CONSTRAINT program_review_finding_text_check CHECK (length(trim(finding)) > 0)
);--> statement-breakpoint
CREATE INDEX program_review_finding_idx ON program_review_finding (program_id, criterion_no, created_at);--> statement-breakpoint
-- Append-only: a judgement is never edited or deleted (no grant for it); a later one is added.
CREATE FUNCTION program_review_finding_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'review findings are kept as recorded; add a later finding instead' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER a_append_only BEFORE UPDATE ON program_review_finding FOR EACH ROW EXECUTE FUNCTION program_review_finding_append_only();--> statement-breakpoint
ALTER TABLE program_review_finding ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY scoped ON program_review_finding
  USING (institution_id = app_institution_id() AND EXISTS (SELECT 1 FROM program p WHERE p.id = program_id))
  WITH CHECK (institution_id = app_institution_id() AND EXISTS (SELECT 1 FROM program p WHERE p.id = program_id));--> statement-breakpoint
GRANT SELECT, INSERT ON program_review_finding TO ams_app;--> statement-breakpoint
GRANT SELECT ON program_review_finding TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT ON program_review_finding FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON program_review_finding FOR EACH ROW EXECUTE FUNCTION audit_row();
