-- PRD 6.9 invariants 1-3, enforced by triggers (they also bind the table owner; do not relax them to fix a test).

-- 1. Published is frozen: nothing belonging to a published or retired framework_version can change.
CREATE FUNCTION framework_version_of(p_table text, p_row jsonb) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN CASE p_table
    WHEN 'requirement_note' THEN (SELECT r.framework_version_id FROM requirement r WHERE r.id = (p_row ->> 'requirement_id')::uuid)
    WHEN 'source_page' THEN (SELECT d.framework_version_id FROM source_document d WHERE d.id = (p_row ->> 'source_document_id')::uuid)
    ELSE (p_row ->> 'framework_version_id')::uuid
  END;
END $$;
--> statement-breakpoint

CREATE FUNCTION enforce_version_not_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v uuid;
  s text;
BEGIN
  FOR v IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN framework_version_of(TG_TABLE_NAME, to_jsonb(OLD)) END,
      CASE WHEN TG_OP <> 'DELETE' THEN framework_version_of(TG_TABLE_NAME, to_jsonb(NEW)) END]) AS x WHERE x IS NOT NULL
  LOOP
    SELECT status INTO s FROM framework_version WHERE id = v;
    IF s IN ('published', 'retired') THEN
      RAISE EXCEPTION 'framework version % is % and immutable: % on % is not allowed; create a new version', v, s, TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['requirement','requirement_note','report_template','source_document','source_page','extraction_item'] LOOP
    EXECUTE format('CREATE TRIGGER a_version_frozen BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_version_not_frozen()', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- The framework_version row itself: new versions start as drafts; status moves only along
-- draft -> in_review -> published -> retired (in_review may go back to draft); once published only the status
-- may change (to retired), and a published or retired version cannot be deleted.
CREATE FUNCTION enforce_version_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_cols text[] := ARRAY['updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a new framework version must start as draft, not %', NEW.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('published', 'retired') THEN
      RAISE EXCEPTION 'framework version % is % and immutable: it cannot be deleted', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('published', 'retired') THEN
    IF NOT (OLD.status = 'published' AND NEW.status = 'retired')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'framework version % is % and immutable: status cannot change to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (to_jsonb(NEW) - audit_cols - 'status') IS DISTINCT FROM (to_jsonb(OLD) - audit_cols - 'status') THEN
      RAISE EXCEPTION 'framework version % is % and immutable: only its status may change', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'in_review')
    OR (OLD.status = 'in_review' AND NEW.status IN ('draft', 'published'))) THEN
    RAISE EXCEPTION 'illegal framework version status change % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_version_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON framework_version
  FOR EACH ROW EXECUTE FUNCTION enforce_version_lifecycle();
--> statement-breakpoint

-- 2. Publish gate. Runs when a version becomes published.
CREATE FUNCTION enforce_publish_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  IF NEW.status <> 'published' OR OLD.status = 'published' THEN RETURN NEW; END IF;

  SELECT count(*) INTO n FROM requirement WHERE framework_version_id = NEW.id AND review_status <> 'approved';
  IF n > 0 THEN
    RAISE EXCEPTION 'publish gate: % requirement(s) are not approved', n USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*) INTO n FROM requirement_note rn JOIN requirement r ON r.id = rn.requirement_id
    WHERE r.framework_version_id = NEW.id AND rn.review_status <> 'approved';
  IF n > 0 THEN
    RAISE EXCEPTION 'publish gate: % requirement note(s) are not approved', n USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*) INTO n FROM requirement_note rn JOIN requirement r ON r.id = rn.requirement_id
    WHERE r.framework_version_id = NEW.id AND rn.authority = 'required' AND NOT rn.quote_verified;
  IF n > 0 THEN
    RAISE EXCEPTION 'publish gate: % required note(s) lack a verified quote', n USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT (SELECT count(*) FROM requirement WHERE framework_version_id = NEW.id AND origin = 'ai'
            AND (source_document_id IS NULL OR source_page IS NULL OR source_quote IS NULL))
       + (SELECT count(*) FROM requirement_note rn JOIN requirement r ON r.id = rn.requirement_id
            WHERE r.framework_version_id = NEW.id AND rn.origin = 'ai'
              AND (rn.source_document_id IS NULL OR rn.source_page IS NULL OR rn.source_quote IS NULL))
       + (SELECT count(*) FROM report_template WHERE framework_version_id = NEW.id AND origin = 'ai'
            AND (source_document_id IS NULL OR source_page IS NULL OR source_quote IS NULL))
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'publish gate: % AI-originated item(s) lack a source reference', n USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER b_publish_gate BEFORE UPDATE ON framework_version
  FOR EACH ROW EXECUTE FUNCTION enforce_publish_gate();
--> statement-breakpoint

-- 3. Sample reports never create requirements: nothing sourced from a sample_report document may become a
-- requirement or a `required` note, whether entered directly or accepted from an extraction proposal.
CREATE FUNCTION enforce_no_sample_report_requirements() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc uuid;
  creates boolean;
  is_sample boolean;
BEGIN
  IF TG_TABLE_NAME = 'requirement' THEN
    doc := NEW.source_document_id; creates := true;
  ELSIF TG_TABLE_NAME = 'requirement_note' THEN
    doc := NEW.source_document_id; creates := NEW.authority = 'required';
  ELSE -- extraction_item: only acceptance counts
    doc := NEW.source_document_id;
    creates := NEW.status IN ('accepted', 'edited')
      AND (NEW.kind = 'requirement' OR (NEW.kind = 'note' AND NEW.payload ->> 'authority' = 'required'));
  END IF;
  IF doc IS NULL OR NOT creates THEN RETURN NEW; END IF;
  SELECT role = 'sample_report' INTO is_sample FROM source_document WHERE id = doc;
  IF is_sample THEN
    RAISE EXCEPTION 'sample reports never create requirements: % sourced from a sample_report document', TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER b_no_sample_requirements BEFORE INSERT OR UPDATE ON requirement
  FOR EACH ROW EXECUTE FUNCTION enforce_no_sample_report_requirements();
--> statement-breakpoint
CREATE TRIGGER b_no_sample_requirements BEFORE INSERT OR UPDATE ON requirement_note
  FOR EACH ROW EXECUTE FUNCTION enforce_no_sample_report_requirements();
--> statement-breakpoint
CREATE TRIGGER b_no_sample_requirements BEFORE INSERT OR UPDATE ON extraction_item
  FOR EACH ROW EXECUTE FUNCTION enforce_no_sample_report_requirements();
