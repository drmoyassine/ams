-- Evidence (PRD 6.5, 9): tenant isolation, restricted items, immutable versions, reasoned links, audit, privileges.

-- Who may see an evidence item: everyone in the institution, except that a restricted item is visible only to an
-- institution-wide role, a role on its owner unit or an ancestor of it, or its owner (PRD 9.1).
-- Decided from the item's own columns, so the policy also works on the row being inserted.
CREATE FUNCTION app_can_see_evidence_fields(p_confidentiality text, p_owner_user uuid, p_owner_unit uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT p_confidentiality <> 'restricted' OR p_owner_user = app_user_id() OR EXISTS (
    SELECT 1 FROM role_assignment ra
    WHERE ra.user_id = app_user_id() AND ra.institution_id = app_institution_id()
      AND (ra.expires_at IS NULL OR ra.expires_at > now())
      AND (ra.scope_type = 'institution' OR (ra.scope_type = 'org_unit' AND p_owner_unit IS NOT NULL AND ra.scope_id IN (
        WITH RECURSIVE up AS (
          SELECT id, parent_id FROM org_unit WHERE id = p_owner_unit
          UNION ALL
          SELECT o.id, o.parent_id FROM org_unit o JOIN up ON o.id = up.parent_id)
        SELECT id FROM up))))
$$;
--> statement-breakpoint
CREATE FUNCTION app_can_see_evidence(p_item uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM evidence_item e
    WHERE e.id = p_item AND e.institution_id = app_institution_id()
      AND app_can_see_evidence_fields(e.confidentiality, e.owner_user_id, e.owner_unit_id))
$$;
--> statement-breakpoint
CREATE FUNCTION app_can_see_evidence_version(p_version uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM evidence_version v WHERE v.id = p_version AND app_can_see_evidence(v.evidence_item_id))
$$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['evidence_item','evidence_version','evidence_link'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT ON %I TO ams_worker', t);
    EXECUTE format('CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION stamp_actor()', t);
    EXECUTE format('CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Versions are kept, never changed or deleted; items are archived, never deleted.
GRANT SELECT, INSERT, UPDATE ON evidence_item TO ams_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON evidence_version TO ams_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON evidence_link TO ams_app;
--> statement-breakpoint

CREATE POLICY scoped ON evidence_item
  USING (institution_id = app_institution_id() AND app_can_see_evidence_fields(confidentiality, owner_user_id, owner_unit_id))
  WITH CHECK (institution_id = app_institution_id());
--> statement-breakpoint
CREATE POLICY scoped ON evidence_version
  USING (institution_id = app_institution_id() AND app_can_see_evidence(evidence_item_id))
  WITH CHECK (institution_id = app_institution_id() AND app_can_see_evidence(evidence_item_id));
--> statement-breakpoint
-- A link is visible when its evidence is, and (for an engagement link) its engagement is.
CREATE POLICY scoped ON evidence_link
  USING (institution_id = app_institution_id() AND app_can_see_evidence_version(evidence_version_id)
    AND (engagement_requirement_id IS NULL OR EXISTS (
      SELECT 1 FROM engagement_requirement er WHERE er.id = engagement_requirement_id AND app_can_access_engagement_id(er.engagement_id))))
  WITH CHECK (institution_id = app_institution_id() AND app_can_see_evidence_version(evidence_version_id)
    AND (engagement_requirement_id IS NULL OR EXISTS (
      SELECT 1 FROM engagement_requirement er WHERE er.id = engagement_requirement_id AND app_can_access_engagement_id(er.engagement_id))));
--> statement-breakpoint

CREATE FUNCTION evidence_version_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'evidence versions are kept as they were uploaded; add a new version instead' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version_no <> COALESCE((SELECT max(version_no) FROM evidence_version WHERE evidence_item_id = NEW.evidence_item_id), 0) + 1 THEN
    RAISE EXCEPTION 'evidence versions are numbered one after another' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_evidence_version_rules BEFORE INSERT OR UPDATE OR DELETE ON evidence_version FOR EACH ROW EXECUTE FUNCTION evidence_version_rules();
--> statement-breakpoint

-- A link's evidence version and target are fixed (link a newer version as a new link); an internal target must be the
-- institution's own framework.
CREATE FUNCTION evidence_link_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.evidence_version_id <> OLD.evidence_version_id
      OR NEW.engagement_requirement_id IS DISTINCT FROM OLD.engagement_requirement_id
      OR NEW.internal_framework_id IS DISTINCT FROM OLD.internal_framework_id OR NEW.internal_code IS DISTINCT FROM OLD.internal_code) THEN
    RAISE EXCEPTION 'a link''s evidence and target cannot change; link again instead' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.internal_framework_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM framework WHERE id = NEW.internal_framework_id AND internal) THEN
    RAISE EXCEPTION 'evidence is attached to items of the internal quality framework or to engagement requirements' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_evidence_link_rules BEFORE INSERT OR UPDATE ON evidence_link FOR EACH ROW EXECUTE FUNCTION evidence_link_rules();
