-- THE COURSE SYLLABUS (TASK-122, DEC-038): the AIU syllabus template as the course schema.
--
--   course (new columns)       contact hours (lecture, lab, other), type, level band (100-400), category, sustainability indicator and the
--                              course coordinator; written from the approved syllabus;
--   course_instructor          who teaches the course (an instructor may suggest changes to its syllabus);
--   course_requisite           prerequisites and co-requisites;
--   institution                syllabus_settings (min and max CLOs and PLOs, escalation days) and syllabus_template (the sections an admin edits);
--   syllabus_version           one document per course and version: draft, in_review, endorsed, approved, superseded. An approved version
--                              is locked by a trigger (only its computed issue columns and its supersession may change) and is never deleted;
--   syllabus_suggestion        an instructor's suggestion for a section, accepted or declined by the coordinator;
--   notification               a new kind, syllabus_flagged: a syllabus with errors needs the responsible person's attention.
ALTER TABLE course ADD COLUMN contact_lecture numeric(4,1), ADD COLUMN contact_lab numeric(4,1), ADD COLUMN contact_other numeric(4,1),
  ADD COLUMN course_type text, ADD COLUMN level_band text, ADD COLUMN category text, ADD COLUMN sustainability text,
  ADD COLUMN coordinator_user_id uuid REFERENCES app_user(id);--> statement-breakpoint
ALTER TABLE course ADD CONSTRAINT course_contact_check CHECK ((contact_lecture IS NULL OR contact_lecture >= 0) AND (contact_lab IS NULL OR contact_lab >= 0) AND (contact_other IS NULL OR contact_other >= 0)),
  ADD CONSTRAINT course_type_check CHECK (course_type IS NULL OR course_type IN ('didactic', 'lab', 'studio', 'internship', 'independent_study', 'project')),
  ADD CONSTRAINT course_level_band_check CHECK (level_band IS NULL OR level_band IN ('100', '200', '300', '400')),
  ADD CONSTRAINT course_category_check CHECK (category IS NULL OR category IN ('general_education', 'program_core', 'program_elective', 'free_elective')),
  ADD CONSTRAINT course_sustainability_check CHECK (sustainability IS NULL OR sustainability IN ('focused', 'related', 'none'));--> statement-breakpoint
ALTER TABLE institution ADD COLUMN syllabus_settings jsonb DEFAULT '{}'::jsonb NOT NULL, ADD COLUMN syllabus_template jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE course_instructor (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	course_id uuid NOT NULL REFERENCES course(id) ON DELETE CASCADE,
	user_id uuid NOT NULL REFERENCES app_user(id)
);--> statement-breakpoint
CREATE UNIQUE INDEX course_instructor_idx ON course_instructor (course_id, user_id);--> statement-breakpoint
CREATE TABLE course_requisite (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	course_id uuid NOT NULL REFERENCES course(id) ON DELETE CASCADE,
	requisite_id uuid NOT NULL REFERENCES course(id) ON DELETE CASCADE,
	kind text NOT NULL,
	CONSTRAINT course_requisite_kind_check CHECK (kind IN ('prerequisite', 'corequisite')),
	CONSTRAINT course_requisite_self_check CHECK (course_id <> requisite_id)
);--> statement-breakpoint
CREATE UNIQUE INDEX course_requisite_idx ON course_requisite (course_id, requisite_id);--> statement-breakpoint
CREATE TABLE syllabus_version (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	course_id uuid NOT NULL REFERENCES course(id) ON DELETE CASCADE,
	version_no integer NOT NULL,
	status text DEFAULT 'draft' NOT NULL,
	content jsonb NOT NULL,
	-- Computed by the rule checker every time the draft is saved or the settings change; an import or an upsert still loads with errors.
	issues jsonb DEFAULT '[]'::jsonb NOT NULL,
	error_count integer DEFAULT 0 NOT NULL,
	warning_count integer DEFAULT 0 NOT NULL,
	flagged_since timestamp with time zone,
	escalation_level smallint DEFAULT 0 NOT NULL,
	effective_from text,
	source text,
	submitted_by uuid REFERENCES app_user(id), submitted_at timestamp with time zone,
	endorsed_by uuid REFERENCES app_user(id), endorsed_at timestamp with time zone,
	approved_by uuid REFERENCES app_user(id), approved_at timestamp with time zone,
	returned_note text,
	CONSTRAINT syllabus_version_status_check CHECK (status IN ('draft', 'in_review', 'endorsed', 'approved', 'superseded')),
	CONSTRAINT syllabus_version_no_check CHECK (version_no >= 1),
	CONSTRAINT syllabus_version_content_check CHECK (jsonb_typeof(content) = 'object' AND jsonb_typeof(issues) = 'array'),
	CONSTRAINT syllabus_version_escalation_check CHECK (escalation_level BETWEEN 0 AND 3)
);--> statement-breakpoint
CREATE UNIQUE INDEX syllabus_version_no_idx ON syllabus_version (course_id, version_no);--> statement-breakpoint
-- One version in progress (draft, in review or endorsed) and one approved version per course.
CREATE UNIQUE INDEX syllabus_version_open_idx ON syllabus_version (course_id) WHERE status IN ('draft', 'in_review', 'endorsed');--> statement-breakpoint
CREATE UNIQUE INDEX syllabus_version_approved_idx ON syllabus_version (course_id) WHERE status = 'approved';--> statement-breakpoint
CREATE INDEX syllabus_version_flagged_idx ON syllabus_version (institution_id) WHERE error_count > 0;--> statement-breakpoint
-- An approved or superseded version is history: its content cannot change and it is never deleted. Its computed issue columns may be
-- recomputed (when the settings change), and an approved version may become superseded, nothing else.
CREATE FUNCTION syllabus_version_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('approved', 'superseded') THEN RAISE EXCEPTION 'an approved syllabus is kept: it cannot be deleted' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('approved', 'superseded') THEN
    IF NEW.content IS DISTINCT FROM OLD.content OR NEW.course_id <> OLD.course_id OR NEW.version_no <> OLD.version_no OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.endorsed_by IS DISTINCT FROM OLD.endorsed_by THEN
      RAISE EXCEPTION 'an approved syllabus cannot be changed: make a new version' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT (OLD.status = 'approved' AND NEW.status = 'superseded') THEN
      RAISE EXCEPTION 'an approved syllabus can only be superseded' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_syllabus_version_rules BEFORE UPDATE OR DELETE ON syllabus_version FOR EACH ROW EXECUTE FUNCTION syllabus_version_rules();--> statement-breakpoint
CREATE TABLE syllabus_suggestion (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	syllabus_version_id uuid NOT NULL REFERENCES syllabus_version(id) ON DELETE CASCADE,
	section text NOT NULL,
	suggestion text NOT NULL,
	status text DEFAULT 'open' NOT NULL,
	resolved_by uuid REFERENCES app_user(id), resolved_at timestamp with time zone, resolution_note text,
	CONSTRAINT syllabus_suggestion_status_check CHECK (status IN ('open', 'accepted', 'declined')),
	CONSTRAINT syllabus_suggestion_text_check CHECK (length(trim(suggestion)) > 0 AND length(trim(section)) > 0)
);--> statement-breakpoint
CREATE INDEX syllabus_suggestion_idx ON syllabus_suggestion (syllabus_version_id, status);--> statement-breakpoint
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;--> statement-breakpoint
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (kind in ('link_rejected', 'link_approved', 'collection_due', 'collection_late', 'collection_failed', 'syllabus_flagged'));--> statement-breakpoint
-- Courses and their syllabi are institution-wide like the course catalogue; writes are checked in the services.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['course_instructor', 'course_requisite', 'syllabus_version', 'syllabus_suggestion'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ams_app', t);
    EXECUTE format('GRANT SELECT ON %I TO ams_worker', t);
    EXECUTE format('CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION stamp_actor()', t);
    EXECUTE format('CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;
