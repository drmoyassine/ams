-- Glossary tables: tenant isolation, audit and privileges, like the other institution-owned tables. Reading is open to
-- everyone in the institution (the UI uses it for labels); changing it is checked in the service (framework:write).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['glossary_term','glossary_alias'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ams_app', t);
    EXECUTE format('GRANT SELECT ON %I TO ams_worker', t);
    EXECUTE format('CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION stamp_actor()', t);
    EXECUTE format('CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- A term's kind is fixed (aliases of a kind point only at terms of that kind), and an alias may only point at a term of
-- the kind its source needs: level labels to level terms, finding codes to finding terms, report templates to report terms.
CREATE FUNCTION glossary_alias_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  SELECT kind INTO k FROM glossary_term WHERE id = NEW.term_id;
  IF (NEW.source = 'level_label' AND k <> 'level') OR (NEW.source = 'finding_code' AND k <> 'finding') OR (NEW.source = 'report_template' AND k <> 'report') THEN
    RAISE EXCEPTION 'a % maps to a term of another kind (%)', NEW.source, k USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_glossary_alias_rules BEFORE INSERT OR UPDATE ON glossary_alias FOR EACH ROW EXECUTE FUNCTION glossary_alias_rules();
--> statement-breakpoint
CREATE FUNCTION glossary_term_kind_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind <> OLD.kind AND EXISTS (SELECT 1 FROM glossary_alias WHERE term_id = OLD.id) THEN
    RAISE EXCEPTION 'a term that standards map to cannot change kind' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_glossary_term_kind_fixed BEFORE UPDATE ON glossary_term FOR EACH ROW EXECUTE FUNCTION glossary_term_kind_fixed();
