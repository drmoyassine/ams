-- ASSESSMENT OF LEARNING: PLAN, ATTAINMENT, RESULTS, CORRECTIVE ACTIONS, ILO ROTATION (TASK-114..117; docs/assessment-of-learning-plan.md 2-6).
--
--   institution.assessment_benchmarks  institution targets (CLO and PLO score and share of students, indirect score); a plan item may
--                                      set its own. Empty until the institution decides (the QAIEO guidance leaves them open);
--   assessment_plan / _item            IE-001: per program and academic year, per PLO the rotation year, the direct method in a course
--                                      (at mastery), rubric, the indirect method, frequency, respondents, the benchmark, who, when;
--   course_assessment / _part          the QAIEO method: an assessment of a course offering (term), its total marks and class average,
--                                      split into parts (questions) each worth marks and assessing CLOs;
--   outcome_result                     a result for a CLO or PLO in a term: direct or indirect, sample, students at target, share,
--                                      mean score on a scale, response rate; aggregates only (nothing student-level, BI rule 5);
--   corrective_action                  the close-the-loop record (gap, root cause, action, owner, term, verification) and its state;
--   ilo_schedule                       the five-year ILO rotation: which ILO in which academic year, by what mechanism.
ALTER TABLE institution ADD COLUMN assessment_benchmarks jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE assessment_plan (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	program_id uuid NOT NULL REFERENCES program(id) ON DELETE CASCADE,
	academic_year text NOT NULL,
	status text DEFAULT 'draft' NOT NULL,
	coordinator text, endorsed_by text, submitted_on date, endorsed_on date, notes text,
	CONSTRAINT assessment_plan_status_check CHECK (status IN ('draft', 'submitted', 'endorsed', 'returned')),
	CONSTRAINT assessment_plan_year_check CHECK (academic_year ~ '^[0-9]{4}-[0-9]{2}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX assessment_plan_idx ON assessment_plan (program_id, academic_year);--> statement-breakpoint
CREATE TABLE assessment_plan_item (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	plan_id uuid NOT NULL REFERENCES assessment_plan(id) ON DELETE CASCADE,
	plo_id uuid NOT NULL REFERENCES learning_outcome(id) ON DELETE CASCADE,
	assess_in text, direct_course_id uuid REFERENCES course(id) ON DELETE SET NULL,
	direct_method text, direct_rubric text, indirect_method text, indirect_frequency text, indirect_respondents text,
	target_score numeric(6,2), target_share numeric(5,2), benchmark text, responsible text, collection_window text, submit_by date, reassess_in text,
	CONSTRAINT assessment_plan_item_share_check CHECK (target_share IS NULL OR target_share BETWEEN 0 AND 100)
);--> statement-breakpoint
CREATE UNIQUE INDEX assessment_plan_item_idx ON assessment_plan_item (plan_id, plo_id);--> statement-breakpoint
CREATE TABLE course_assessment (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	course_id uuid NOT NULL REFERENCES course(id) ON DELETE CASCADE,
	term text NOT NULL,
	name text NOT NULL,
	total_marks numeric(7,2) NOT NULL,
	class_average numeric(7,2),
	students integer,
	display_order integer DEFAULT 0 NOT NULL,
	CONSTRAINT course_assessment_marks_check CHECK (total_marks > 0 AND (class_average IS NULL OR (class_average >= 0 AND class_average <= total_marks))),
	CONSTRAINT course_assessment_name_check CHECK (length(trim(name)) > 0 AND length(trim(term)) > 0)
);--> statement-breakpoint
CREATE INDEX course_assessment_idx ON course_assessment (course_id, term);--> statement-breakpoint
CREATE TABLE course_assessment_part (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	assessment_id uuid NOT NULL REFERENCES course_assessment(id) ON DELETE CASCADE,
	label text NOT NULL,
	marks numeric(7,2) NOT NULL,
	clo_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	display_order integer DEFAULT 0 NOT NULL,
	CONSTRAINT course_assessment_part_marks_check CHECK (marks > 0)
);--> statement-breakpoint
CREATE INDEX course_assessment_part_idx ON course_assessment_part (assessment_id);--> statement-breakpoint
CREATE TABLE outcome_result (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	outcome_id uuid NOT NULL REFERENCES learning_outcome(id) ON DELETE CASCADE,
	course_id uuid REFERENCES course(id) ON DELETE SET NULL,
	term text NOT NULL,
	kind text NOT NULL,
	method text,
	sample_size integer, students_at_target integer, share_at_target numeric(5,2), mean_score numeric(7,2), scale_max numeric(7,2), response_rate numeric(5,2),
	source text, notes text,
	CONSTRAINT outcome_result_kind_check CHECK (kind IN ('direct', 'indirect')),
	CONSTRAINT outcome_result_share_check CHECK (share_at_target IS NULL OR share_at_target BETWEEN 0 AND 100),
	CONSTRAINT outcome_result_rate_check CHECK (response_rate IS NULL OR response_rate BETWEEN 0 AND 100),
	CONSTRAINT outcome_result_counts_check CHECK (students_at_target IS NULL OR sample_size IS NULL OR students_at_target <= sample_size)
);--> statement-breakpoint
CREATE INDEX outcome_result_idx ON outcome_result (outcome_id, term);--> statement-breakpoint
CREATE TABLE corrective_action (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	program_id uuid NOT NULL REFERENCES program(id) ON DELETE CASCADE,
	outcome_id uuid REFERENCES learning_outcome(id) ON DELETE SET NULL,
	result_id uuid REFERENCES outcome_result(id) ON DELETE SET NULL,
	gap text NOT NULL, root_cause text, action text, owner text, implement_in text, verification_plan text,
	status text DEFAULT 'open' NOT NULL,
	verified_result_id uuid REFERENCES outcome_result(id) ON DELETE SET NULL,
	verification_note text,
	CONSTRAINT corrective_action_status_check CHECK (status IN ('open', 'in_progress', 'implemented', 'verified', 'not_effective', 'closed')),
	CONSTRAINT corrective_action_gap_check CHECK (length(trim(gap)) > 0)
);--> statement-breakpoint
CREATE INDEX corrective_action_program_idx ON corrective_action (program_id, status);--> statement-breakpoint
CREATE TABLE ilo_schedule (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	ilo_id uuid NOT NULL REFERENCES learning_outcome(id) ON DELETE CASCADE,
	academic_year text NOT NULL,
	mechanism text, indirect_measure text,
	CONSTRAINT ilo_schedule_year_check CHECK (academic_year ~ '^[0-9]{4}-[0-9]{2}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX ilo_schedule_idx ON ilo_schedule (ilo_id, academic_year);--> statement-breakpoint
-- Program-owned rows follow program visibility; course and outcome rows are institution-wide like their parents.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assessment_plan', 'corrective_action'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scoped ON %I USING (institution_id = app_institution_id() AND EXISTS (SELECT 1 FROM program p WHERE p.id = program_id)) WITH CHECK (institution_id = app_institution_id() AND EXISTS (SELECT 1 FROM program p WHERE p.id = program_id))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['assessment_plan_item', 'course_assessment', 'course_assessment_part', 'outcome_result', 'ilo_schedule'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['assessment_plan', 'assessment_plan_item', 'course_assessment', 'course_assessment_part', 'outcome_result', 'corrective_action', 'ilo_schedule'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ams_app', t);
    EXECUTE format('GRANT SELECT ON %I TO ams_worker', t);
    EXECUTE format('CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION stamp_actor()', t);
    EXECUTE format('CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;
