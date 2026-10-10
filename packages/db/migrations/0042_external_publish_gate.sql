-- DEC-022: an external standard drafted by the framework analysis is gated by publishing, not by per-line approval.
--
-- Replaces the body of enforce_publish_gate() (0005). For an external standard (framework.internal = false) a pending
-- requirement or note no longer blocks publishing: the person who publishes the version (framework_version.published_by
-- and published_at) is the human approval of everything in it. A row a person explicitly rejected still blocks. The
-- internal quality framework keeps the 0005 rule unchanged: every requirement and note approved.
--
-- Unchanged for every framework: a `required` note needs a verified quote (DEC-006), and every AI-originated item needs
-- a source reference. No row is updated; the trigger b_publish_gate, the frozen-version triggers and the version
-- lifecycle trigger are not touched, so a published version stays immutable exactly as before.

CREATE OR REPLACE FUNCTION enforce_publish_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n integer;
  is_internal boolean;
BEGIN
  IF NEW.status <> 'published' OR OLD.status = 'published' THEN RETURN NEW; END IF;

  SELECT f.internal INTO is_internal FROM framework f WHERE f.id = NEW.framework_id;

  IF is_internal THEN
    SELECT count(*) INTO n FROM requirement WHERE framework_version_id = NEW.id AND review_status <> 'approved';
    IF n > 0 THEN
      RAISE EXCEPTION 'publish gate: % requirement(s) are not approved', n USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    SELECT count(*) INTO n FROM requirement_note rn JOIN requirement r ON r.id = rn.requirement_id
      WHERE r.framework_version_id = NEW.id AND rn.review_status <> 'approved';
    IF n > 0 THEN
      RAISE EXCEPTION 'publish gate: % requirement note(s) are not approved', n USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    SELECT (SELECT count(*) FROM requirement WHERE framework_version_id = NEW.id AND review_status = 'rejected')
         + (SELECT count(*) FROM requirement_note rn JOIN requirement r ON r.id = rn.requirement_id
              WHERE r.framework_version_id = NEW.id AND rn.review_status = 'rejected')
      INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'publish gate: % requirement(s) or note(s) were rejected; edit or delete them first', n USING ERRCODE = 'integrity_constraint_violation';
    END IF;
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
