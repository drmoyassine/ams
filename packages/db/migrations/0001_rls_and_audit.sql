-- Roles. NOLOGIN group roles: deployments grant membership to the login user; the transaction helper
-- (DEC-010) runs `SET LOCAL ROLE ams_app|ams_worker` so RLS applies even when the login user owns the tables.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ams_app') THEN CREATE ROLE ams_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ams_worker') THEN CREATE ROLE ams_worker NOLOGIN; END IF;
END $$;
--> statement-breakpoint

-- Identity helpers: the single source for "who is calling" (app.user_id / app.institution_id set per transaction).
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_institution_id() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.institution_id', true), '')::uuid $$;
--> statement-breakpoint

-- Role checks read role_assignment as the function owner (SECURITY DEFINER) so policies on that table don't recurse.
CREATE FUNCTION app_is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_assignment ra
    WHERE ra.user_id = app_user_id() AND ra.institution_id = app_institution_id()
      AND ra.role = 'admin' AND ra.scope_type = 'institution'
      AND (ra.expires_at IS NULL OR ra.expires_at > now()))
$$;
--> statement-breakpoint

-- A program is visible through an institution-wide role, a role on any ancestor org unit, or a role on the program.
CREATE FUNCTION app_can_access_program(p_program uuid, p_org_unit uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_assignment ra
    WHERE ra.user_id = app_user_id() AND ra.institution_id = app_institution_id()
      AND (ra.expires_at IS NULL OR ra.expires_at > now())
      AND (
        ra.scope_type = 'institution'
        OR (ra.scope_type = 'program' AND ra.scope_id = p_program)
        OR (ra.scope_type = 'org_unit' AND ra.scope_id IN (
          WITH RECURSIVE up AS (
            SELECT id, parent_id FROM org_unit WHERE id = p_org_unit
            UNION ALL
            SELECT o.id, o.parent_id FROM org_unit o JOIN up ON o.id = up.parent_id)
          SELECT id FROM up))
      ))
$$;
--> statement-breakpoint

-- Row-level security. The tenant key is institution_id (institution.id for institution itself).
-- Not FORCEd: the owner (migrations, SECURITY DEFINER helpers) bypasses; ams_app and ams_worker never do.
ALTER TABLE institution ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON institution USING (id = app_institution_id()) WITH CHECK (id = app_institution_id());
--> statement-breakpoint
ALTER TABLE org_unit ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON org_unit USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());
--> statement-breakpoint
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON app_user USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());
--> statement-breakpoint
ALTER TABLE comment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON comment USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());
--> statement-breakpoint
ALTER TABLE job ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON job USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());
--> statement-breakpoint
ALTER TABLE extraction_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON extraction_item USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());
--> statement-breakpoint

ALTER TABLE program ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY scoped ON program
  USING (institution_id = app_institution_id() AND app_can_access_program(id, org_unit_id))
  WITH CHECK (institution_id = app_institution_id() AND app_can_access_program(id, org_unit_id));
--> statement-breakpoint

ALTER TABLE role_assignment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_or_admin_read ON role_assignment FOR SELECT
  USING (institution_id = app_institution_id() AND (user_id = app_user_id() OR app_is_admin()));
--> statement-breakpoint
CREATE POLICY admin_write ON role_assignment FOR ALL
  USING (institution_id = app_institution_id() AND app_is_admin())
  WITH CHECK (institution_id = app_institution_id() AND app_is_admin());
--> statement-breakpoint

ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY admin_read ON audit_event FOR SELECT
  USING (institution_id = app_institution_id() AND app_is_admin());
--> statement-breakpoint

-- Table privileges. The worker proposes (inserts extraction items, updates jobs and flags) but never approves,
-- publishes or edits domain data (PRD 6.9 #7). It cannot write extraction_item.status or reviewed_by.
GRANT USAGE ON SCHEMA public TO ams_app, ams_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON institution, org_unit, program, app_user, role_assignment, comment, job, extraction_item TO ams_app;
--> statement-breakpoint
GRANT SELECT ON audit_event TO ams_app;
--> statement-breakpoint
GRANT SELECT ON institution, org_unit, program, app_user, role_assignment, comment, audit_event TO ams_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON job TO ams_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON extraction_item TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (payload, source_document_id, source_page, source_quote, quote_verified, confidence, flags, updated_at, updated_by)
  ON extraction_item TO ams_worker;
--> statement-breakpoint
GRANT INSERT ON comment TO ams_worker;
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ams_app, ams_worker;
--> statement-breakpoint

-- Stamp created_by / updated_by / updated_at from the caller.
CREATE FUNCTION stamp_actor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := coalesce(NEW.created_by, app_user_id());
    NEW.updated_by := coalesce(NEW.updated_by, app_user_id());
  ELSE
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.updated_by := app_user_id();
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Audit: every insert/update/delete on a domain table. Runs as the owner so callers need no INSERT on audit_event.
-- actor_type comes from app.actor_type (user | system | ai); defaults to user, or system when there is no user.
CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  inst uuid;
  actor uuid := app_user_id();
  atype text := coalesce(nullif(current_setting('app.actor_type', true), ''), CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END);
BEGIN
  inst := CASE WHEN TG_TABLE_NAME = 'institution' THEN r.id ELSE (to_jsonb(r) ->> 'institution_id')::uuid END;
  INSERT INTO audit_event (institution_id, actor_id, actor_type, action, target_type, target_id, before, after, created_by, updated_by)
  VALUES (inst, actor, atype, lower(TG_OP), TG_TABLE_NAME, r.id,
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
          actor, actor);
  RETURN NULL;
END $$;
--> statement-breakpoint

CREATE FUNCTION audit_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (% not allowed)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_event_no_update_delete BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only();
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['institution','org_unit','program','app_user','role_assignment','comment','job','extraction_item'] LOOP
    EXECUTE format('CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION stamp_actor()', t);
    EXECUTE format('CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;
