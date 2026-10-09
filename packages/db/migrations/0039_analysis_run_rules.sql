-- Framework analysis (PRD 15, step C; DEC-006, DEC-022): tenant isolation and audit for analysis_run, what the worker may
-- write, and the marker that a person edited an AI-made requirement or note.
--
-- The worker (ams_worker) may now draft requirements and notes, but only:
--   * into a DRAFT version (the frozen-version trigger keeps refusing published and retired ones; this adds in_review),
--   * as origin 'ai', never approved (review_status stays 'pending', no reviewer), never marked as a person's edit,
--   * updating only AI rows nobody has touched (not edited by a person, not reviewed),
--   * with a 'required' note only when its quote is verified.
-- It still cannot approve, publish, set official status or delete anything (no DELETE grant, no review columns).

ALTER TABLE analysis_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON analysis_run USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());
--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON analysis_run FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON analysis_run FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON analysis_run TO ams_app;
--> statement-breakpoint
GRANT SELECT ON analysis_run TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (status, stage, progress, model, prompt_versions, usage, error, started_at, finished_at, report) ON analysis_run TO ams_worker;
--> statement-breakpoint

-- A run that has ended stays ended for the worker: a late job of a cancelled run cannot bring it back.
CREATE FUNCTION analysis_run_worker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'ams_worker' AND OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'analysis run % has ended (%); the worker cannot change it', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER c_worker_guard BEFORE UPDATE ON analysis_run FOR EACH ROW EXECUTE FUNCTION analysis_run_worker_guard();
--> statement-breakpoint

-- What the worker may write into a draft version.
GRANT INSERT ON requirement, requirement_note TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (parent_id, title, official_text, level_label, display_order, language, is_assessable,
  source_document_id, source_page, source_quote, quote_verified) ON requirement TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (type, text, authority, source_document_id, source_page, source_quote, quote_verified) ON requirement_note TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (level_labels) ON framework_version TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (role, role_origin) ON source_document TO ams_worker;
--> statement-breakpoint

CREATE FUNCTION framework_content_worker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v uuid;
  s text;
BEGIN
  IF current_user <> 'ams_worker' THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME = 'framework_version' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'the worker writes only into a draft framework version (this one is %)', OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'source_document' THEN
    IF NEW.role IS DISTINCT FROM OLD.role OR NEW.role_origin IS DISTINCT FROM OLD.role_origin THEN
      IF OLD.role_origin = 'manual' THEN
        RAISE EXCEPTION 'a person chose the role of this source; the worker cannot change it' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.role_origin <> 'ai' THEN
        RAISE EXCEPTION 'a role the worker sets is recorded as the analysis''s choice' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- requirement and requirement_note
  v := framework_version_of(TG_TABLE_NAME, to_jsonb(NEW));
  SELECT status INTO s FROM framework_version WHERE id = v;
  IF s IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'the worker writes only into a draft framework version (this one is %)', s USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.origin <> 'ai' OR NEW.review_status <> 'pending' OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.edited_by_person THEN
      RAISE EXCEPTION 'the worker adds only unreviewed AI items (origin ai, review pending)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF OLD.origin <> 'ai' OR OLD.edited_by_person OR OLD.review_status <> 'pending' THEN
      RAISE EXCEPTION 'a person made, edited or reviewed this %; the worker cannot change it', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'requirement_note' THEN
    IF NEW.authority = 'required' AND NOT NEW.quote_verified THEN
      RAISE EXCEPTION 'an AI note may be required only with a verified quote' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER c_worker_guard BEFORE INSERT OR UPDATE ON requirement FOR EACH ROW EXECUTE FUNCTION framework_content_worker_guard();
--> statement-breakpoint
CREATE TRIGGER c_worker_guard BEFORE INSERT OR UPDATE ON requirement_note FOR EACH ROW EXECUTE FUNCTION framework_content_worker_guard();
--> statement-breakpoint
CREATE TRIGGER c_worker_guard BEFORE UPDATE ON framework_version FOR EACH ROW EXECUTE FUNCTION framework_content_worker_guard();
--> statement-breakpoint
CREATE TRIGGER c_worker_guard BEFORE UPDATE ON source_document FOR EACH ROW EXECUTE FUNCTION framework_content_worker_guard();
--> statement-breakpoint

-- Human edits win (DEC-022): any change by someone other than the worker marks the row, whichever service made it.
-- The worker's own updates leave the mark as it is (and the guard above stops it touching marked rows).
CREATE FUNCTION mark_person_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'ams_worker' THEN
    NEW.edited_by_person := true;
  ELSE
    NEW.edited_by_person := OLD.edited_by_person;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER b_mark_person_edit BEFORE UPDATE ON requirement FOR EACH ROW EXECUTE FUNCTION mark_person_edit();
--> statement-breakpoint
CREATE TRIGGER b_mark_person_edit BEFORE UPDATE ON requirement_note FOR EACH ROW EXECUTE FUNCTION mark_person_edit();
--> statement-breakpoint

-- The new trigger functions, like the others, are callable by both roles.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ams_app, ams_worker;
