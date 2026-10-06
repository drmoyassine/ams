-- The institution's own quality framework is reference structure for mappings and evidence, never the basis of an
-- engagement: an engagement is a run against an external accreditor's published version (DEC-016).
CREATE OR REPLACE FUNCTION engagement_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'engagements cannot be deleted; withdraw or close them' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM framework_version WHERE id = NEW.framework_version_id AND status = 'published') THEN
      RAISE EXCEPTION 'an engagement needs a published framework version' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM framework_version v JOIN framework f ON f.id = v.framework_id
               WHERE v.id = NEW.framework_version_id AND f.internal) THEN
      RAISE EXCEPTION 'an engagement cannot be built on the institution''s own quality framework' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.framework_version_id <> OLD.framework_version_id OR NEW.subject_type <> OLD.subject_type
     OR NEW.subject_id <> OLD.subject_id OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'an engagement''s framework version, subject and kind cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
