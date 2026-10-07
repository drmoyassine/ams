-- Forms on data items (DEC-020): responses visible with their item, audited, kept as given; the public link lookup.

ALTER TABLE dataset_response ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON dataset_response TO ams_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dataset_response TO ams_app;
--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON dataset_response FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON dataset_response FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE POLICY scoped ON dataset_response
  USING (institution_id = app_institution_id() AND app_can_see_evidence(evidence_item_id))
  WITH CHECK (institution_id = app_institution_id() AND app_can_see_evidence(evidence_item_id));
--> statement-breakpoint

-- A response's answers never change; the only change is, once, the version it was added to.
CREATE FUNCTION dataset_response_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.answers IS DISTINCT FROM OLD.answers OR NEW.evidence_item_id <> OLD.evidence_item_id OR NEW.via <> OLD.via
     OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     OR (OLD.included_in_version_id IS NOT NULL AND NEW.included_in_version_id IS DISTINCT FROM OLD.included_in_version_id) THEN
    RAISE EXCEPTION 'responses are kept as they were given' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_dataset_response_rules BEFORE UPDATE ON dataset_response FOR EACH ROW EXECUTE FUNCTION dataset_response_rules();
--> statement-breakpoint

-- The public form link: the open form of an active, non-restricted data item, found before any institution is known.
CREATE FUNCTION app_resolve_form_link(p_token text) RETURNS TABLE (evidence_item_id uuid, institution_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT s.evidence_item_id, s.institution_id FROM dataset_spec s JOIN evidence_item e ON e.id = s.evidence_item_id
  WHERE s.form_link_token = p_token AND s.form_open AND e.status = 'active' AND e.confidentiality <> 'restricted'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_resolve_form_link(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_resolve_form_link(text) TO ams_app;
