-- THE CATALOG'S STRUCTURE (DEC-046, step 2): what a degree is made of.
--   program.program_type     degree or minor (a minor is a program with its own unit, code, credits and blocks);
--   institution.catalog_settings   { genedCredits }: the credits of General Education, the same for every program;
--   concentration            a track of a program (a student follows one); its own core and elective credits;
--   gened_area, gened_area_course   the areas of General Education, each with a minimum, and each area's pool of courses;
--   program_block            the credits a program (or one of its concentrations) asks of a block: general education, college,
--                            major or concentration, core or elective;
--   course_program.block / concentration_id   in which block, and for which concentration, a course sits in a program's study plan
--                            (role stays core, elective or service);
--   study_plan_slot          an elective slot of the study plan ("Major elective, 3 credits, year 3 term 2", with the rule it is filled by).
-- Additive: every row stays valid.
ALTER TABLE program ADD COLUMN program_type text DEFAULT 'degree' NOT NULL;--> statement-breakpoint
ALTER TABLE program ADD CONSTRAINT program_type_check CHECK (program_type IN ('degree', 'minor'));--> statement-breakpoint
ALTER TABLE institution ADD COLUMN catalog_settings jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint

CREATE TABLE concentration (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	program_id uuid NOT NULL REFERENCES program(id) ON DELETE CASCADE,
	code text NOT NULL,
	name_en text NOT NULL,
	name_ar text,
	display_order integer DEFAULT 0 NOT NULL,
	active boolean DEFAULT true NOT NULL,
	CONSTRAINT concentration_code_check CHECK (length(trim(code)) > 0),
	CONSTRAINT concentration_name_check CHECK (length(trim(name_en)) > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX concentration_code_idx ON concentration (program_id, lower(code));--> statement-breakpoint

CREATE TABLE gened_area (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	code text NOT NULL,
	name_en text NOT NULL,
	name_ar text,
	min_credits numeric(4,1) DEFAULT 0 NOT NULL,
	display_order integer DEFAULT 0 NOT NULL,
	active boolean DEFAULT true NOT NULL,
	CONSTRAINT gened_area_code_check CHECK (length(trim(code)) > 0),
	CONSTRAINT gened_area_name_check CHECK (length(trim(name_en)) > 0),
	CONSTRAINT gened_area_min_check CHECK (min_credits >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX gened_area_code_idx ON gened_area (institution_id, lower(code));--> statement-breakpoint
CREATE TABLE gened_area_course (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	area_id uuid NOT NULL REFERENCES gened_area(id) ON DELETE CASCADE,
	course_id uuid NOT NULL REFERENCES course(id) ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX gened_area_course_idx ON gened_area_course (area_id, course_id);--> statement-breakpoint
CREATE INDEX gened_area_course_course_idx ON gened_area_course (course_id);--> statement-breakpoint

CREATE TABLE program_block (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	program_id uuid NOT NULL REFERENCES program(id) ON DELETE CASCADE,
	concentration_id uuid REFERENCES concentration(id) ON DELETE CASCADE,
	block text NOT NULL,
	requirement text NOT NULL,
	credits numeric(5,1) NOT NULL,
	CONSTRAINT program_block_block_check CHECK (block IN ('general_education', 'college', 'major', 'concentration')),
	CONSTRAINT program_block_requirement_check CHECK (requirement IN ('core', 'elective')),
	CONSTRAINT program_block_credits_check CHECK (credits >= 0),
	-- The concentration block belongs to a concentration, and only that block does.
	CONSTRAINT program_block_concentration_check CHECK ((block = 'concentration') = (concentration_id IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX program_block_idx ON program_block (program_id, coalesce(concentration_id, '00000000-0000-0000-0000-000000000000'::uuid), block, requirement);--> statement-breakpoint

ALTER TABLE course_program ADD COLUMN block text;--> statement-breakpoint
ALTER TABLE course_program ADD COLUMN concentration_id uuid REFERENCES concentration(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE course_program ADD CONSTRAINT course_program_block_check CHECK (block IS NULL OR block IN ('general_education', 'college', 'major', 'concentration'));--> statement-breakpoint

CREATE TABLE study_plan_slot (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	program_id uuid NOT NULL REFERENCES program(id) ON DELETE CASCADE,
	concentration_id uuid REFERENCES concentration(id) ON DELETE CASCADE,
	block text NOT NULL,
	requirement text DEFAULT 'elective' NOT NULL,
	-- A General Education slot may count toward an area (its minimum).
	area_id uuid REFERENCES gened_area(id) ON DELETE SET NULL,
	name text NOT NULL,
	rule text,
	credits numeric(4,1) NOT NULL,
	year integer,
	term integer,
	CONSTRAINT study_plan_slot_block_check CHECK (block IN ('general_education', 'college', 'major', 'concentration')),
	CONSTRAINT study_plan_slot_requirement_check CHECK (requirement IN ('core', 'elective')),
	CONSTRAINT study_plan_slot_name_check CHECK (length(trim(name)) > 0),
	CONSTRAINT study_plan_slot_credits_check CHECK (credits > 0),
	CONSTRAINT study_plan_slot_year_check CHECK (year IS NULL OR year BETWEEN 1 AND 9),
	CONSTRAINT study_plan_slot_term_check CHECK (term IS NULL OR term BETWEEN 1 AND 4)
);--> statement-breakpoint
CREATE INDEX study_plan_slot_program_idx ON study_plan_slot (program_id);--> statement-breakpoint

ALTER TABLE concentration ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON concentration USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
ALTER TABLE gened_area ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON gened_area USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
ALTER TABLE gened_area_course ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON gened_area_course USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
ALTER TABLE program_block ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON program_block USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
ALTER TABLE study_plan_slot ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON study_plan_slot USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON concentration, gened_area, gened_area_course, program_block, study_plan_slot TO ams_app;--> statement-breakpoint
GRANT SELECT ON concentration, gened_area, gened_area_course, program_block, study_plan_slot TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON concentration FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON gened_area FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON gened_area_course FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON program_block FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON study_plan_slot FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON concentration FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON gened_area FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON gened_area_course FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON program_block FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON study_plan_slot FOR EACH ROW EXECUTE FUNCTION audit_row();
