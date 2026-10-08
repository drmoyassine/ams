-- ai_setting and embedding: tenant isolation, audit and privileges, like the other institution-owned tables.
-- ai_setting: changing it needs the ai:manage permission (admin), checked in the service. The worker reads it to open its
-- AI connection (DEC-012) and can never change it. Provider keys are stored encrypted; the audit trail therefore holds
-- ciphertext, never a key.
-- embedding (DEC-023): derived, rebuildable vectors of framework text. The worker writes them (it is the only AI caller);
-- the owner type is limited to 'requirement' by a CHECK. Not under the frozen-version triggers.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_setting','embedding'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id())', t);
    EXECUTE format('CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION stamp_actor()', t);
    EXECUTE format('GRANT SELECT ON %I TO ams_worker', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON ai_setting TO ams_app;
--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON ai_setting FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
-- Vectors are bulk derived data: not audited row by row (the audit log would hold thousands of float arrays).
GRANT SELECT, INSERT, UPDATE, DELETE ON embedding TO ams_app, ams_worker;
