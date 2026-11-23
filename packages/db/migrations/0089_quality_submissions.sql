-- QUALITY MANAGEMENT AS THE IQF IN OPERATION (DEC-048).
--   requirement_frequency   how often a standard asks for its evidence (a rule, or an opt-out of the inherited one), by framework + code;
--   requirement_approval    the approval steps a standard's submissions go through before the QA office and the champion;
--   institution.quality_office_unit_id  the unit whose head and members are the QA office step;
--   course scope items      the Course level lists courses (scopes and champions per course);
--   quality_submission      one scoped item's evidence for a standard and a period, with its status;
--   quality_submission_evidence  the version that answers each linked evidence item;
--   quality_submission_step the approval steps of each round (a return starts a new round); a decided step and an approved
--                           submission are frozen here, in the database.
CREATE TABLE requirement_frequency (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	framework_id uuid NOT NULL REFERENCES framework(id),
	code text NOT NULL,
	rule jsonb,
	opt_out boolean DEFAULT false NOT NULL,
	CONSTRAINT requirement_frequency_rule_check CHECK ((rule IS NOT NULL) <> opt_out)
);--> statement-breakpoint
CREATE UNIQUE INDEX requirement_frequency_idx ON requirement_frequency (institution_id, framework_id, code);--> statement-breakpoint
CREATE TABLE requirement_approval (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	framework_id uuid NOT NULL REFERENCES framework(id),
	code text NOT NULL,
	steps jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT requirement_approval_steps_check CHECK (jsonb_typeof(steps) = 'array')
);--> statement-breakpoint
CREATE UNIQUE INDEX requirement_approval_idx ON requirement_approval (institution_id, framework_id, code);--> statement-breakpoint
ALTER TABLE institution ADD COLUMN quality_office_unit_id uuid REFERENCES org_unit(id) ON DELETE SET NULL;--> statement-breakpoint

-- Courses as scope items: a Course-level scope may list courses, and a champion may be set per course.
ALTER TABLE requirement_champion DROP CONSTRAINT requirement_champion_item_kind_check;--> statement-breakpoint
ALTER TABLE requirement_champion ADD CONSTRAINT requirement_champion_item_kind_check CHECK (scope_item_kind IS NULL OR scope_item_kind IN ('org_unit', 'program', 'course'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION requirement_assignment_checks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM framework WHERE id = NEW.framework_id AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'the standard must be one of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'requirement_scope' THEN
    SELECT kind INTO k FROM scope_level WHERE institution_id = NEW.institution_id AND key = NEW.level_key;
    IF cardinality(NEW.item_ids) > 0 THEN
      IF k = 'org_unit' THEN
        IF EXISTS (SELECT 1 FROM unnest(NEW.item_ids) AS i(id) WHERE NOT EXISTS (SELECT 1 FROM org_unit u WHERE u.id = i.id AND u.institution_id = NEW.institution_id)) THEN
          RAISE EXCEPTION 'a scope can list only units of the same institution' USING ERRCODE = 'check_violation';
        END IF;
      ELSIF k = 'program' THEN
        IF EXISTS (SELECT 1 FROM unnest(NEW.item_ids) AS i(id) WHERE NOT EXISTS (SELECT 1 FROM program p WHERE p.id = i.id AND p.institution_id = NEW.institution_id)) THEN
          RAISE EXCEPTION 'a scope can list only programs of the same institution' USING ERRCODE = 'check_violation';
        END IF;
      ELSIF k = 'course' THEN
        IF EXISTS (SELECT 1 FROM unnest(NEW.item_ids) AS i(id) WHERE NOT EXISTS (SELECT 1 FROM course c WHERE c.id = i.id AND c.institution_id = NEW.institution_id)) THEN
          RAISE EXCEPTION 'a scope can list only courses of the same institution' USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        RAISE EXCEPTION 'this level has no list of items to choose from' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.user_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'a champion must be a person of the same institution' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.scope_item_kind = 'org_unit' AND NOT EXISTS (SELECT 1 FROM org_unit WHERE id = NEW.scope_item_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'the unit of a champion must be a unit of the same institution' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.scope_item_kind = 'program' AND NOT EXISTS (SELECT 1 FROM program WHERE id = NEW.scope_item_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'the program of a champion must be a program of the same institution' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.scope_item_kind = 'course' AND NOT EXISTS (SELECT 1 FROM course WHERE id = NEW.scope_item_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'the course of a champion must be a course of the same institution' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TABLE quality_submission (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	framework_id uuid NOT NULL REFERENCES framework(id),
	code text NOT NULL,
	subject_kind text NOT NULL,
	subject_id uuid,
	period_key text NOT NULL,
	period_label text NOT NULL,
	period_start date NOT NULL,
	due_at timestamp with time zone NOT NULL,
	status text DEFAULT 'draft' NOT NULL,
	round integer DEFAULT 1 NOT NULL,
	submitted_by uuid REFERENCES app_user(id),
	submitted_at timestamp with time zone,
	approved_at timestamp with time zone,
	CONSTRAINT quality_submission_subject_check CHECK (subject_kind IN ('course', 'program', 'org_unit', 'institution') AND ((subject_kind = 'institution') = (subject_id IS NULL))),
	CONSTRAINT quality_submission_status_check CHECK (status IN ('draft', 'submitted', 'returned', 'approved'))
);--> statement-breakpoint
CREATE UNIQUE INDEX quality_submission_idx ON quality_submission (institution_id, framework_id, code, subject_kind, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid), period_key);--> statement-breakpoint
CREATE INDEX quality_submission_subject_idx ON quality_submission (subject_kind, subject_id);--> statement-breakpoint
CREATE TABLE quality_submission_evidence (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	submission_id uuid NOT NULL REFERENCES quality_submission(id) ON DELETE CASCADE,
	evidence_item_id uuid NOT NULL REFERENCES evidence_item(id),
	evidence_version_id uuid REFERENCES evidence_version(id),
	note text
);--> statement-breakpoint
CREATE UNIQUE INDEX quality_submission_evidence_idx ON quality_submission_evidence (submission_id, evidence_item_id);--> statement-breakpoint
CREATE TABLE quality_submission_step (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	submission_id uuid NOT NULL REFERENCES quality_submission(id) ON DELETE CASCADE,
	round integer NOT NULL,
	ordinal integer NOT NULL,
	kind text NOT NULL,
	label text NOT NULL,
	approver_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	decision text DEFAULT 'pending' NOT NULL,
	decided_by uuid REFERENCES app_user(id),
	decided_at timestamp with time zone,
	note text,
	CONSTRAINT quality_submission_step_decision_check CHECK (decision IN ('pending', 'approved', 'returned', 'skipped'))
);--> statement-breakpoint
CREATE UNIQUE INDEX quality_submission_step_idx ON quality_submission_step (submission_id, round, ordinal);--> statement-breakpoint

-- What is decided stays: an approved submission, its evidence and its steps; and a step once decided.
CREATE FUNCTION quality_submission_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s text;
BEGIN
  IF TG_TABLE_NAME = 'quality_submission' THEN
    IF OLD.status = 'approved' THEN RAISE EXCEPTION 'an approved submission is kept as it is' USING ERRCODE = 'check_violation'; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO s FROM quality_submission WHERE id = COALESCE(NEW.submission_id, OLD.submission_id);
  IF s = 'approved' THEN RAISE EXCEPTION 'an approved submission is kept as it is' USING ERRCODE = 'check_violation'; END IF;
  IF TG_TABLE_NAME = 'quality_submission_step' AND TG_OP <> 'INSERT' THEN
    IF OLD.decision <> 'pending' THEN RAISE EXCEPTION 'a decided step is kept as it is' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_frozen BEFORE UPDATE OR DELETE ON quality_submission FOR EACH ROW EXECUTE FUNCTION quality_submission_frozen();--> statement-breakpoint
CREATE TRIGGER a_frozen BEFORE INSERT OR UPDATE OR DELETE ON quality_submission_evidence FOR EACH ROW EXECUTE FUNCTION quality_submission_frozen();--> statement-breakpoint
CREATE TRIGGER a_frozen BEFORE INSERT OR UPDATE OR DELETE ON quality_submission_step FOR EACH ROW EXECUTE FUNCTION quality_submission_frozen();--> statement-breakpoint

ALTER TABLE requirement_frequency ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE requirement_approval ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE quality_submission ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE quality_submission_evidence ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE quality_submission_step ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON requirement_frequency USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY tenant ON requirement_approval USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY tenant ON quality_submission USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY tenant ON quality_submission_evidence USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY tenant ON quality_submission_step USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON requirement_frequency, requirement_approval, quality_submission, quality_submission_evidence, quality_submission_step TO ams_app;--> statement-breakpoint
GRANT SELECT ON requirement_frequency, requirement_approval, quality_submission, quality_submission_evidence, quality_submission_step TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON requirement_frequency FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON requirement_approval FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON quality_submission FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON quality_submission_evidence FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON quality_submission_step FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON requirement_frequency FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON requirement_approval FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON quality_submission FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON quality_submission_evidence FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON quality_submission_step FOR EACH ROW EXECUTE FUNCTION audit_row();
