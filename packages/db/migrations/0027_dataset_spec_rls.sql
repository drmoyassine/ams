-- Data definitions (PRD 9.4): visible with their evidence item, audited, only on data items.

ALTER TABLE dataset_spec ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON dataset_spec TO ams_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON dataset_spec TO ams_app;
--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON dataset_spec FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON dataset_spec FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE POLICY scoped ON dataset_spec
  USING (institution_id = app_institution_id() AND app_can_see_evidence(evidence_item_id))
  WITH CHECK (institution_id = app_institution_id() AND app_can_see_evidence(evidence_item_id));
--> statement-breakpoint
CREATE FUNCTION dataset_spec_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.evidence_item_id <> OLD.evidence_item_id THEN
    RAISE EXCEPTION 'a data definition belongs to one item' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM evidence_item WHERE id = NEW.evidence_item_id AND type = 'data') THEN
    RAISE EXCEPTION 'only data evidence has a data definition' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_dataset_spec_rules BEFORE INSERT OR UPDATE ON dataset_spec FOR EACH ROW EXECUTE FUNCTION dataset_spec_rules();
