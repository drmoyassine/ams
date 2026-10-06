-- Mappings from an external standard's requirements to the institution's quality framework (DEC-016): tenant
-- isolation, audit and privileges. The worker may read them (to propose more) but not write or approve: AI proposes,
-- humans publish (DEC-006).
ALTER TABLE requirement_mapping ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON requirement_mapping USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON requirement_mapping TO ams_app;
--> statement-breakpoint
GRANT SELECT ON requirement_mapping TO ams_worker;
--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON requirement_mapping FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON requirement_mapping FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint

-- The external side must be an external standard and the internal side the institution's own framework; the pair of
-- frameworks is fixed once chosen.
CREATE FUNCTION requirement_mapping_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.framework_id <> OLD.framework_id OR NEW.internal_framework_id <> OLD.internal_framework_id
      OR NEW.external_code <> OLD.external_code OR NEW.internal_code <> OLD.internal_code) THEN
    RAISE EXCEPTION 'a mapping''s requirements cannot change; delete it and map again' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM framework WHERE id = NEW.framework_id AND internal) THEN
      RAISE EXCEPTION 'map from an external standard, not from the quality framework' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM framework WHERE id = NEW.internal_framework_id AND internal) THEN
      RAISE EXCEPTION 'map onto the institution''s own quality framework' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_requirement_mapping_rules BEFORE INSERT OR UPDATE ON requirement_mapping FOR EACH ROW EXECUTE FUNCTION requirement_mapping_rules();
