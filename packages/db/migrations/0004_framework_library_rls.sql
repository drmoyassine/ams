-- Row-level security, audit and privileges for the framework library tables (PRD 6.2).
-- Same pattern as the core tables: tenant key institution_id, read via app.institution_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accreditor','framework','framework_version','source_document','source_page','requirement','requirement_note','report_template'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ams_app', t);
    EXECUTE format('GRANT SELECT ON %I TO ams_worker', t);
    EXECUTE format('CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION stamp_actor()', t);
    EXECUTE format('CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- The worker (AI/extraction) stores page text and extraction proposals; it never writes requirements, notes,
-- templates, versions or any review_status (PRD 6.9 #7).
GRANT INSERT ON source_page TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (text_status, page_count) ON source_document TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (text, method, reviewed) ON source_page TO ams_worker;
