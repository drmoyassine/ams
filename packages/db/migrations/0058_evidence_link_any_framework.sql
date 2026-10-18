-- Evidence may be linked directly to a requirement of any standard, by (framework, code) at the library level, so the
-- link carries across versions of that standard (owner, 2026-10-19). The columns were always generic; only the insert
-- rule limited the target to the institution's own quality framework. A link's evidence and target still cannot change.
CREATE OR REPLACE FUNCTION evidence_link_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.evidence_version_id <> OLD.evidence_version_id
      OR NEW.engagement_requirement_id IS DISTINCT FROM OLD.engagement_requirement_id
      OR NEW.internal_framework_id IS DISTINCT FROM OLD.internal_framework_id OR NEW.internal_code IS DISTINCT FROM OLD.internal_code) THEN
    RAISE EXCEPTION 'a link''s evidence and target cannot change; link again instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
