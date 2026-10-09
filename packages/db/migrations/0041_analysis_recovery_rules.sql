-- Framework analysis, check-and-recover (step D): remembering what a person deleted.
--
-- analysis_dismissal holds one row per AI-made requirement or note a person deleted, so a re-run does not add it back.
-- It is written by the database, not by a service: an AFTER DELETE trigger on requirement and requirement_note records
-- the row when it was made by the analysis (origin 'ai') and the deletion was not the worker's (the worker has no DELETE
-- grant anyway). A trigger, like mark_person_edit (0039), so every present and future delete path counts and no service
-- can forget it. The note's own text is kept; its fingerprint is computed in packages/core, which owns text normalisation.
--
-- Rows are append-only for the app (no UPDATE or DELETE grant); the worker only reads them. Tenant RLS and audit as usual.
-- The frozen-version and worker-guard triggers are not changed: deleting is still refused in a published version.

ALTER TABLE analysis_dismissal ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON analysis_dismissal USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());
--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON analysis_dismissal FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON analysis_dismissal FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
GRANT SELECT, INSERT ON analysis_dismissal TO ams_app;
--> statement-breakpoint
GRANT SELECT ON analysis_dismissal TO ams_worker;
--> statement-breakpoint

CREATE FUNCTION record_ai_dismissal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v uuid;
  c text;
BEGIN
  IF current_user = 'ams_worker' OR OLD.origin <> 'ai' THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME = 'requirement' THEN
    INSERT INTO analysis_dismissal (institution_id, framework_version_id, kind, code)
      VALUES (OLD.institution_id, OLD.framework_version_id, 'requirement', OLD.code);
  ELSE
    -- A note is deleted before its requirement (deleteRequirement), so the requirement is still there to name it.
    SELECT framework_version_id, code INTO v, c FROM requirement WHERE id = OLD.requirement_id;
    IF v IS NOT NULL THEN
      INSERT INTO analysis_dismissal (institution_id, framework_version_id, kind, code, note_text)
        VALUES (OLD.institution_id, v, 'note', c, OLD.text);
    END IF;
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER d_record_ai_dismissal AFTER DELETE ON requirement FOR EACH ROW EXECUTE FUNCTION record_ai_dismissal();
--> statement-breakpoint
CREATE TRIGGER d_record_ai_dismissal AFTER DELETE ON requirement_note FOR EACH ROW EXECUTE FUNCTION record_ai_dismissal();
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ams_app, ams_worker;
