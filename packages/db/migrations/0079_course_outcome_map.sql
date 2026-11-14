-- The curriculum map built top-down (DEC-039): a course mapped directly to an outcome of a program at one level (I, R or M), without
-- needing CLOs. The bottom-up side stays the CLO -> PLO links (outcome_link). One level per course and outcome; a course may map to
-- several outcomes (the syllabus rules' minimum and maximum PLOs flag it, never block). The target is a PLO of a program the course is
-- in; an ILO is allowed by the table for courses that will map to institutional outcomes instead (not offered on the screen yet).
-- The level is checked by the service against institution.outcome_levels (configuration, not a constraint).
CREATE TABLE course_outcome_map (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	course_id uuid NOT NULL REFERENCES course(id) ON DELETE CASCADE,
	outcome_id uuid NOT NULL REFERENCES learning_outcome(id) ON DELETE CASCADE,
	level text NOT NULL,
	CONSTRAINT course_outcome_map_level_check CHECK (length(trim(level)) > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX course_outcome_map_idx ON course_outcome_map (course_id, outcome_id);--> statement-breakpoint
CREATE INDEX course_outcome_map_outcome_idx ON course_outcome_map (outcome_id);--> statement-breakpoint
CREATE FUNCTION course_outcome_map_checks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t learning_outcome;
BEGIN
  SELECT * INTO t FROM learning_outcome WHERE id = NEW.outcome_id;
  IF t.kind NOT IN ('plo', 'ilo') THEN RAISE EXCEPTION 'a course maps to a PLO or an ILO' USING ERRCODE = '23514'; END IF;
  IF t.kind = 'plo' AND NOT EXISTS (SELECT 1 FROM course_program cp WHERE cp.course_id = NEW.course_id AND cp.program_id = t.program_id) THEN
    RAISE EXCEPTION 'the course is not part of that PLO''s program' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_checks BEFORE INSERT OR UPDATE ON course_outcome_map FOR EACH ROW EXECUTE FUNCTION course_outcome_map_checks();--> statement-breakpoint
-- Taking a course out of a program removes its top-down map to that program's PLOs, as it removes its CLOs' links.
CREATE FUNCTION course_program_unmap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM course_outcome_map m USING learning_outcome o
   WHERE m.outcome_id = o.id AND m.course_id = OLD.course_id AND o.kind = 'plo' AND o.program_id = OLD.program_id;
  RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER unmap AFTER DELETE ON course_program FOR EACH ROW EXECUTE FUNCTION course_program_unmap();--> statement-breakpoint
ALTER TABLE course_outcome_map ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON course_outcome_map USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON course_outcome_map TO ams_app;--> statement-breakpoint
GRANT SELECT ON course_outcome_map TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON course_outcome_map FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON course_outcome_map FOR EACH ROW EXECUTE FUNCTION audit_row();
