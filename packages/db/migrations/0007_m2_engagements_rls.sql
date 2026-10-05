-- Engagements and roadmap (PRD 6.4): row-level security by engagement access, audit, privileges and the
-- invariants that belong in the database (PRD 6.9 #12 roadmap guardrails, #13 one lead).

-- An engagement is visible through an institution-wide role, a role scoped to the engagement itself, or (for a
-- program engagement) any role that gives access to that program (program, or an ancestor org unit).
CREATE FUNCTION app_can_access_engagement(p_id uuid, p_subject_type text, p_subject_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_assignment ra
    WHERE ra.user_id = app_user_id() AND ra.institution_id = app_institution_id()
      AND (ra.expires_at IS NULL OR ra.expires_at > now())
      AND (ra.scope_type = 'institution' OR (ra.scope_type = 'engagement' AND ra.scope_id = p_id)))
  OR (p_subject_type = 'program' AND app_can_access_program(
        p_subject_id, (SELECT org_unit_id FROM program WHERE id = p_subject_id)))
$$;
--> statement-breakpoint
-- Same decision by engagement id, for the tables that hang off an engagement.
CREATE FUNCTION app_can_access_engagement_id(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM engagement e
    WHERE e.id = p_id AND e.institution_id = app_institution_id()
      AND app_can_access_engagement(e.id, e.subject_type, e.subject_id))
$$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['engagement','milestone','engagement_requirement'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ams_app', t);
    EXECUTE format('GRANT SELECT ON %I TO ams_worker', t);
    EXECUTE format('CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION stamp_actor()', t);
    EXECUTE format('CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY scoped ON engagement
  USING (institution_id = app_institution_id() AND app_can_access_engagement(id, subject_type, subject_id))
  WITH CHECK (institution_id = app_institution_id() AND app_can_access_engagement(id, subject_type, subject_id));
--> statement-breakpoint
CREATE POLICY scoped ON milestone
  USING (institution_id = app_institution_id() AND app_can_access_engagement_id(engagement_id))
  WITH CHECK (institution_id = app_institution_id() AND app_can_access_engagement_id(engagement_id));
--> statement-breakpoint
CREATE POLICY scoped ON engagement_requirement
  USING (institution_id = app_institution_id() AND app_can_access_engagement_id(engagement_id))
  WITH CHECK (institution_id = app_institution_id() AND app_can_access_engagement_id(engagement_id));
--> statement-breakpoint

-- ---- Engagement rules ---------------------------------------------------------------------------------------

-- An engagement is built on a published framework version, which never changes; its subject and kind are fixed.
-- Engagements are withdrawn or closed, never deleted.
CREATE FUNCTION engagement_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'engagements cannot be deleted; withdraw or close them' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM framework_version WHERE id = NEW.framework_version_id AND status = 'published') THEN
      RAISE EXCEPTION 'an engagement needs a published framework version' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.framework_version_id <> OLD.framework_version_id OR NEW.subject_type <> OLD.subject_type
     OR NEW.subject_id <> OLD.subject_id OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'an engagement''s framework version, subject and kind cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
--> statement-breakpoint
CREATE TRIGGER a_engagement_rules BEFORE INSERT OR UPDATE OR DELETE ON engagement FOR EACH ROW EXECUTE FUNCTION engagement_rules();
--> statement-breakpoint

-- One lead (PRD 6.9 #13): an active engagement has exactly one engagement_lead assignment, held by lead_user_id.
-- Checked at commit so the engagement and its lead assignment can be created in either order.
CREATE FUNCTION check_engagement_lead(p_engagement uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE e engagement%ROWTYPE; n int; held boolean;
BEGIN
  SELECT * INTO e FROM engagement WHERE id = p_engagement;
  IF NOT FOUND OR e.status <> 'active' THEN RETURN; END IF;
  SELECT count(*), bool_or(user_id = e.lead_user_id) INTO n, held
    FROM role_assignment WHERE role = 'engagement_lead' AND scope_type = 'engagement' AND scope_id = p_engagement;
  IF n <> 1 OR NOT coalesce(held, false) THEN
    RAISE EXCEPTION 'engagement % must have exactly one engagement lead, and it must be lead_user_id', p_engagement
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION engagement_lead_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_engagement_lead(NEW.id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION lead_assignment_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.role = 'engagement_lead' THEN PERFORM check_engagement_lead(OLD.scope_id); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.role = 'engagement_lead' THEN PERFORM check_engagement_lead(NEW.scope_id); END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER engagement_has_lead AFTER INSERT OR UPDATE ON engagement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION engagement_lead_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER lead_assignment_added AFTER INSERT ON role_assignment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.role = 'engagement_lead')
  EXECUTE FUNCTION lead_assignment_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER lead_assignment_changed AFTER UPDATE ON role_assignment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.role = 'engagement_lead' OR NEW.role = 'engagement_lead')
  EXECUTE FUNCTION lead_assignment_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER lead_assignment_removed AFTER DELETE ON role_assignment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.role = 'engagement_lead')
  EXECUTE FUNCTION lead_assignment_check();
--> statement-breakpoint

-- ---- Roadmap guardrails (PRD 6.9 #12, 8.5) -------------------------------------------------------------------

-- Locked milestones (the self-study deliverable, decision points, reply milestones) cannot be deleted or unlocked.
-- Milestones that came from the template keep their phase, requiredness and key; only the origin may move from
-- template to modified. (Required milestones can be skipped only with a reason: a CHECK on the table.)
CREATE FUNCTION milestone_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.locked THEN
      RAISE EXCEPTION 'milestone "%" is locked and cannot be deleted', OLD.name USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.engagement_id <> OLD.engagement_id THEN
    RAISE EXCEPTION 'a milestone cannot move between engagements' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.locked AND NOT NEW.locked THEN
    RAISE EXCEPTION 'milestone "%" is locked and cannot be unlocked', OLD.name USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.template_key IS DISTINCT FROM OLD.template_key THEN
    RAISE EXCEPTION 'a milestone''s template key cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.origin <> OLD.origin AND NOT (OLD.origin = 'template' AND NEW.origin = 'modified') THEN
    RAISE EXCEPTION 'a milestone''s origin cannot change from % to %', OLD.origin, NEW.origin USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.origin <> 'local' AND NEW.phase <> OLD.phase THEN
    RAISE EXCEPTION 'only local milestones can move between phases' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.origin <> 'local' AND NEW.required <> OLD.required THEN
    RAISE EXCEPTION 'whether a milestone is required comes from the template and cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_milestone_rules BEFORE UPDATE OR DELETE ON milestone FOR EACH ROW EXECUTE FUNCTION milestone_rules();
--> statement-breakpoint

-- A requirement can only be worked on in an engagement built on the version that contains it, and the pair is fixed.
CREATE FUNCTION engagement_requirement_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.engagement_id <> OLD.engagement_id OR NEW.requirement_id <> OLD.requirement_id THEN
      RAISE EXCEPTION 'an engagement requirement''s engagement and requirement cannot change' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM engagement e JOIN requirement r ON r.framework_version_id = e.framework_version_id
    WHERE e.id = NEW.engagement_id AND r.id = NEW.requirement_id) THEN
    RAISE EXCEPTION 'requirement does not belong to the engagement''s framework version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_engagement_requirement_rules BEFORE INSERT OR UPDATE ON engagement_requirement FOR EACH ROW EXECUTE FUNCTION engagement_requirement_rules();
