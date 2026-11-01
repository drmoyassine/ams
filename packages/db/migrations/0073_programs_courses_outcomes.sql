-- PROGRAMS, COURSES AND LEARNING OUTCOMES (TASK-104, TASK-105, TASK-112; docs/assessment-of-learning-plan.md, DEC-036).
--
--   org_unit.code / external_id       a short code and the student-information-system id of a school or department;
--   program.*                         the program record: code, SIS id, mission, vision, description, mode, duration, credits,
--                                     language of instruction, campus, first intake year;
--   course                            a course of the institution, owned by an org unit; code unique in the institution;
--   course_program                    which programs a course serves: role (core, elective, service), year and term of study;
--   learning_outcome                  ILO (institution), PEO and PLO (program), performance indicator (under a PLO), CLO (course);
--   outcome_link                      CLO -> PLO (with a mapping level, in the context of one program), PLO -> ILO, PLO -> PEO;
--   institution.outcome_levels        the mapping levels (DEC-036): code, name, aliases, which one counts as mastery.
-- Additive: every existing row stays valid. Courses, course links and outcomes are institution-wide rows (like org units).
ALTER TABLE org_unit ADD COLUMN code text;--> statement-breakpoint
ALTER TABLE org_unit ADD COLUMN external_id text;--> statement-breakpoint
CREATE UNIQUE INDEX org_unit_code_idx ON org_unit (institution_id, lower(code)) WHERE code IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX org_unit_external_id_idx ON org_unit (institution_id, external_id) WHERE external_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE program ADD COLUMN code text;--> statement-breakpoint
ALTER TABLE program ADD COLUMN external_id text;--> statement-breakpoint
ALTER TABLE program ADD COLUMN mission text;--> statement-breakpoint
ALTER TABLE program ADD COLUMN vision text;--> statement-breakpoint
ALTER TABLE program ADD COLUMN description text;--> statement-breakpoint
ALTER TABLE program ADD COLUMN mode text;--> statement-breakpoint
ALTER TABLE program ADD COLUMN duration_years numeric(3,1);--> statement-breakpoint
ALTER TABLE program ADD COLUMN credits integer;--> statement-breakpoint
ALTER TABLE program ADD COLUMN language_of_instruction text;--> statement-breakpoint
ALTER TABLE program ADD COLUMN campus text;--> statement-breakpoint
ALTER TABLE program ADD COLUMN start_year integer;--> statement-breakpoint
ALTER TABLE program ADD CONSTRAINT program_mode_check CHECK (mode IS NULL OR mode IN ('full_time', 'part_time', 'online', 'blended'));--> statement-breakpoint
ALTER TABLE program ADD CONSTRAINT program_credits_check CHECK (credits IS NULL OR credits > 0);--> statement-breakpoint
ALTER TABLE program ADD CONSTRAINT program_duration_check CHECK (duration_years IS NULL OR duration_years > 0);--> statement-breakpoint
CREATE UNIQUE INDEX program_code_idx ON program (institution_id, lower(code)) WHERE code IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX program_external_id_idx ON program (institution_id, external_id) WHERE external_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE institution ADD COLUMN outcome_levels jsonb DEFAULT '[{"code":"I","name":"Introduced","aliases":[],"mastery":false},{"code":"R","name":"Reinforced","aliases":["D"],"mastery":false},{"code":"M","name":"Mastered","aliases":[],"mastery":true}]'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE course (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	org_unit_id uuid REFERENCES org_unit(id),
	code text NOT NULL,
	external_id text,
	title_en text NOT NULL,
	title_ar text,
	description text,
	credits numeric(4,1),
	level integer,
	language_of_instruction text,
	active boolean DEFAULT true NOT NULL,
	CONSTRAINT course_code_check CHECK (length(trim(code)) > 0),
	CONSTRAINT course_title_check CHECK (length(trim(title_en)) > 0),
	CONSTRAINT course_level_check CHECK (level IS NULL OR level BETWEEN 0 AND 9),
	CONSTRAINT course_credits_check CHECK (credits IS NULL OR credits >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX course_code_idx ON course (institution_id, lower(code));--> statement-breakpoint
CREATE UNIQUE INDEX course_external_id_idx ON course (institution_id, external_id) WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX course_unit_idx ON course (org_unit_id);--> statement-breakpoint
CREATE TABLE course_program (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	course_id uuid NOT NULL REFERENCES course(id) ON DELETE CASCADE,
	program_id uuid NOT NULL REFERENCES program(id) ON DELETE CASCADE,
	role text DEFAULT 'core' NOT NULL,
	year integer,
	term integer,
	CONSTRAINT course_program_role_check CHECK (role IN ('core', 'elective', 'service')),
	CONSTRAINT course_program_year_check CHECK (year IS NULL OR year BETWEEN 1 AND 9),
	CONSTRAINT course_program_term_check CHECK (term IS NULL OR term BETWEEN 1 AND 4)
);--> statement-breakpoint
CREATE UNIQUE INDEX course_program_idx ON course_program (course_id, program_id);--> statement-breakpoint
CREATE INDEX course_program_program_idx ON course_program (program_id);--> statement-breakpoint
CREATE TABLE learning_outcome (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	kind text NOT NULL,
	program_id uuid REFERENCES program(id) ON DELETE CASCADE,
	course_id uuid REFERENCES course(id) ON DELETE CASCADE,
	parent_id uuid REFERENCES learning_outcome(id) ON DELETE CASCADE,
	code text NOT NULL,
	text_en text NOT NULL,
	text_ar text,
	bloom_level text,
	display_order integer DEFAULT 0 NOT NULL,
	status text DEFAULT 'draft' NOT NULL,
	approved_on date,
	approval_ref text,
	source text,
	CONSTRAINT learning_outcome_kind_check CHECK (kind IN ('ilo', 'peo', 'plo', 'pi', 'clo')),
	CONSTRAINT learning_outcome_status_check CHECK (status IN ('draft', 'approved', 'retired')),
	CONSTRAINT learning_outcome_bloom_check CHECK (bloom_level IS NULL OR bloom_level IN ('remember', 'understand', 'apply', 'analyze', 'evaluate', 'create')),
	CONSTRAINT learning_outcome_code_check CHECK (length(trim(code)) > 0),
	CONSTRAINT learning_outcome_text_check CHECK (length(trim(text_en)) > 0),
	CONSTRAINT learning_outcome_owner_check CHECK (
		(kind = 'ilo' AND program_id IS NULL AND course_id IS NULL AND parent_id IS NULL)
		OR (kind IN ('peo', 'plo') AND program_id IS NOT NULL AND course_id IS NULL AND parent_id IS NULL)
		OR (kind = 'pi' AND program_id IS NOT NULL AND course_id IS NULL AND parent_id IS NOT NULL)
		OR (kind = 'clo' AND program_id IS NULL AND course_id IS NOT NULL AND parent_id IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX learning_outcome_code_idx ON learning_outcome (institution_id, kind, coalesce(program_id, course_id, institution_id), lower(code));--> statement-breakpoint
CREATE INDEX learning_outcome_program_idx ON learning_outcome (program_id);--> statement-breakpoint
CREATE INDEX learning_outcome_course_idx ON learning_outcome (course_id);--> statement-breakpoint
CREATE TABLE outcome_link (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	from_id uuid NOT NULL REFERENCES learning_outcome(id) ON DELETE CASCADE,
	to_id uuid NOT NULL REFERENCES learning_outcome(id) ON DELETE CASCADE,
	level text,
	CONSTRAINT outcome_link_self_check CHECK (from_id <> to_id)
);--> statement-breakpoint
CREATE UNIQUE INDEX outcome_link_idx ON outcome_link (from_id, to_id);--> statement-breakpoint
CREATE INDEX outcome_link_to_idx ON outcome_link (to_id);--> statement-breakpoint
-- A pi sits under a PLO of its own program; a link joins CLO->PLO, PLO->ILO or PLO->PEO, and a CLO->PLO link needs the course in that
-- PLO's program. The mapping level is checked by the service against institution.outcome_levels (configuration, not a constraint).
CREATE FUNCTION learning_outcome_checks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p learning_outcome;
BEGIN
  IF NEW.kind = 'pi' THEN
    SELECT * INTO p FROM learning_outcome WHERE id = NEW.parent_id;
    IF p.kind <> 'plo' OR p.program_id <> NEW.program_id THEN RAISE EXCEPTION 'a performance indicator belongs under a PLO of the same program' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_checks BEFORE INSERT OR UPDATE ON learning_outcome FOR EACH ROW EXECUTE FUNCTION learning_outcome_checks();--> statement-breakpoint
CREATE FUNCTION outcome_link_checks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f learning_outcome; t learning_outcome;
BEGIN
  SELECT * INTO f FROM learning_outcome WHERE id = NEW.from_id;
  SELECT * INTO t FROM learning_outcome WHERE id = NEW.to_id;
  IF NOT ((f.kind = 'clo' AND t.kind = 'plo') OR (f.kind = 'plo' AND t.kind IN ('ilo', 'peo'))) THEN
    RAISE EXCEPTION 'a link joins a CLO to a PLO, or a PLO to an ILO or a PEO' USING ERRCODE = '23514';
  END IF;
  IF f.kind = 'plo' AND t.kind = 'peo' AND f.program_id <> t.program_id THEN
    RAISE EXCEPTION 'a PLO links only to a PEO of its own program' USING ERRCODE = '23514';
  END IF;
  IF f.kind = 'clo' AND NOT EXISTS (SELECT 1 FROM course_program cp WHERE cp.course_id = f.course_id AND cp.program_id = t.program_id) THEN
    RAISE EXCEPTION 'the course is not part of that PLO''s program' USING ERRCODE = '23514';
  END IF;
  IF f.kind <> 'clo' AND NEW.level IS NOT NULL THEN
    RAISE EXCEPTION 'only a CLO-PLO link has a mapping level' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_checks BEFORE INSERT OR UPDATE ON outcome_link FOR EACH ROW EXECUTE FUNCTION outcome_link_checks();--> statement-breakpoint
ALTER TABLE course ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON course USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
ALTER TABLE course_program ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON course_program USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
ALTER TABLE learning_outcome ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON learning_outcome USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
ALTER TABLE outcome_link ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON outcome_link USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON course, course_program, learning_outcome, outcome_link TO ams_app;--> statement-breakpoint
GRANT SELECT ON course, course_program, learning_outcome, outcome_link TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON course FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON course_program FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON learning_outcome FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON outcome_link FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON course FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON course_program FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON learning_outcome FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON outcome_link FOR EACH ROW EXECUTE FUNCTION audit_row();
