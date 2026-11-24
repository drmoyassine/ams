-- NUMBERING BY PLACE IS ALWAYS ON (the owner, 2026-11-24): a draft's codes follow the places of its standards, so the per-version
-- switch added in 0090 goes. (A published version keeps its codes; what hangs on them follows at publish.)
ALTER TABLE framework_version DROP COLUMN auto_number;--> statement-breakpoint
-- A renumbering (a draft's codes following its places, or a publish carrying what hangs on the codes) may change the code of a
-- mapping or of an evidence request; nothing else about them. The transaction flag app.renumbering is set only by that code
-- (see 0090 for evidence links and approved submissions).
CREATE OR REPLACE FUNCTION requirement_mapping_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  renaming boolean := coalesce(current_setting('app.renumbering', true), '') = 'on';
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.framework_id <> OLD.framework_id OR NEW.internal_framework_id <> OLD.internal_framework_id
      OR (NOT renaming AND (NEW.external_code <> OLD.external_code OR NEW.internal_code <> OLD.internal_code))) THEN
    RAISE EXCEPTION 'a mapping''s requirements cannot change; delete it and map again' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM framework WHERE id = NEW.framework_id AND internal) THEN
      RAISE EXCEPTION 'map from an external standard, not from the quality framework' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM framework WHERE id = NEW.internal_framework_id AND internal) THEN
      RAISE EXCEPTION 'map onto the institution''s own quality framework' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION evidence_request_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  renaming boolean := coalesce(current_setting('app.renumbering', true), '') = 'on';
BEGIN
  IF current_user = 'ams_worker' AND NEW.collection_run_id IS NULL THEN
    RAISE EXCEPTION 'the worker sends only the requests of collection runs' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.internal_framework_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM framework WHERE id = NEW.internal_framework_id AND internal) THEN
    RAISE EXCEPTION 'evidence is requested for items of the internal quality framework' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.data_item_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM evidence_item WHERE id = NEW.data_item_id AND type = 'dataset') THEN
    RAISE EXCEPTION 'a form request asks for dataset evidence' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.collection_run_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.collection_run_id IS DISTINCT FROM OLD.collection_run_id)
     AND NOT EXISTS (SELECT 1 FROM evidence_collection_run WHERE id = NEW.collection_run_id AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'a request belongs to a collection run of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.internal_framework_id IS DISTINCT FROM OLD.internal_framework_id OR (NEW.internal_code IS DISTINCT FROM OLD.internal_code AND NOT renaming)
       OR NEW.data_item_id IS DISTINCT FROM OLD.data_item_id OR NEW.collection_run_id IS DISTINCT FROM OLD.collection_run_id THEN
      RAISE EXCEPTION 'a request''s target cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'open' AND (NEW.status <> OLD.status OR NEW.token_hash IS NOT NULL) THEN
      RAISE EXCEPTION 'this request is closed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- What the analysis recognises its own work by is the code the source gave, not the code a requirement shows now: a draft's codes
-- follow its places, so a person's move, addition or deletion renumbers the AI-made rows too. The writer matches a re-run, and the
-- memory of what a person deleted is kept, by source_code (null on rows a person made: their code is their key).
ALTER TABLE requirement ADD COLUMN source_code text;--> statement-breakpoint
UPDATE requirement SET source_code = code WHERE origin = 'ai';--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_ai_dismissal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v uuid;
  c text;
BEGIN
  IF current_user = 'ams_worker' OR OLD.origin <> 'ai' THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME = 'requirement' THEN
    INSERT INTO analysis_dismissal (institution_id, framework_version_id, kind, code)
      VALUES (OLD.institution_id, OLD.framework_version_id, 'requirement', coalesce(OLD.source_code, OLD.code));
  ELSE
    -- A note is deleted before its requirement (deleteRequirement), so the requirement is still there to name it.
    SELECT framework_version_id, coalesce(source_code, code) INTO v, c FROM requirement WHERE id = OLD.requirement_id;
    IF v IS NOT NULL THEN
      INSERT INTO analysis_dismissal (institution_id, framework_version_id, kind, code, note_text)
        VALUES (OLD.institution_id, v, 'note', c, OLD.text);
    END IF;
  END IF;
  RETURN OLD;
END $$;--> statement-breakpoint

-- Renumbering is not an edit of content: a requirement or mapping whose code only follows its place keeps its mark (so the analysis
-- still refreshes it and does not count it as changed by a person).
CREATE OR REPLACE FUNCTION mark_person_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'ams_worker' AND coalesce(current_setting('app.renumbering', true), '') <> 'on' THEN
    NEW.edited_by_person := true;
  ELSE
    NEW.edited_by_person := OLD.edited_by_person;
  END IF;
  RETURN NEW;
END $$;
