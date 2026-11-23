-- GENERAL EDUCATION AND FREE ELECTIVES, INSTITUTION DEFAULTS WITH PROGRAM OVERRIDES; A COURSE IN SEVERAL CONCENTRATIONS (DEC-047).
--   block 'free_elective'          a block of its own next to General education (any course; no pool), in program_block, course_program and
--                                  study_plan_slot;
--   institution.catalog_settings   gains `freeElectiveCredits` beside `genedCredits` (the defaults);
--   program.gened_credits,
--   program.free_elective_credits  a program's own credits when they differ from the institution's (null: the default);
--   program_gened_area             a program's own minimum for a General education area (0: the program does not ask for it);
--   course_program_concentration   the concentrations a course of a program's study plan counts toward (several: "choose one" tracks that
--                                  share a course); replaces course_program.concentration_id (copied, then dropped).
ALTER TABLE program_block DROP CONSTRAINT program_block_block_check;--> statement-breakpoint
ALTER TABLE program_block ADD CONSTRAINT program_block_block_check CHECK (block IN ('general_education', 'free_elective', 'college', 'major', 'concentration'));--> statement-breakpoint
ALTER TABLE course_program DROP CONSTRAINT course_program_block_check;--> statement-breakpoint
ALTER TABLE course_program ADD CONSTRAINT course_program_block_check CHECK (block IS NULL OR block IN ('general_education', 'free_elective', 'college', 'major', 'concentration'));--> statement-breakpoint
ALTER TABLE study_plan_slot DROP CONSTRAINT study_plan_slot_block_check;--> statement-breakpoint
ALTER TABLE study_plan_slot ADD CONSTRAINT study_plan_slot_block_check CHECK (block IN ('general_education', 'free_elective', 'college', 'major', 'concentration'));--> statement-breakpoint

ALTER TABLE program ADD COLUMN gened_credits numeric(5,1);--> statement-breakpoint
ALTER TABLE program ADD COLUMN free_elective_credits numeric(5,1);--> statement-breakpoint
ALTER TABLE program ADD CONSTRAINT program_gened_credits_check CHECK (gened_credits IS NULL OR gened_credits >= 0);--> statement-breakpoint
ALTER TABLE program ADD CONSTRAINT program_free_elective_credits_check CHECK (free_elective_credits IS NULL OR free_elective_credits >= 0);--> statement-breakpoint

CREATE TABLE program_gened_area (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	program_id uuid NOT NULL REFERENCES program(id) ON DELETE CASCADE,
	area_id uuid NOT NULL REFERENCES gened_area(id) ON DELETE CASCADE,
	min_credits numeric(4,1) NOT NULL,
	CONSTRAINT program_gened_area_min_check CHECK (min_credits >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX program_gened_area_idx ON program_gened_area (program_id, area_id);--> statement-breakpoint

CREATE TABLE course_program_concentration (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	course_program_id uuid NOT NULL REFERENCES course_program(id) ON DELETE CASCADE,
	concentration_id uuid NOT NULL REFERENCES concentration(id) ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX course_program_concentration_idx ON course_program_concentration (course_program_id, concentration_id);--> statement-breakpoint
CREATE INDEX course_program_concentration_conc_idx ON course_program_concentration (concentration_id);--> statement-breakpoint
INSERT INTO course_program_concentration (institution_id, course_program_id, concentration_id, created_by, updated_by)
  SELECT institution_id, id, concentration_id, updated_by, updated_by FROM course_program WHERE concentration_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE course_program DROP COLUMN concentration_id;--> statement-breakpoint

ALTER TABLE program_gened_area ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON program_gened_area USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
ALTER TABLE course_program_concentration ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON course_program_concentration USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON program_gened_area, course_program_concentration TO ams_app;--> statement-breakpoint
GRANT SELECT ON program_gened_area, course_program_concentration TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON program_gened_area FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON course_program_concentration FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON program_gened_area FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON course_program_concentration FOR EACH ROW EXECUTE FUNCTION audit_row();
