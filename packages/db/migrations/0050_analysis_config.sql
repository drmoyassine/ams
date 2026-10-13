ALTER TABLE "analysis_run" DROP CONSTRAINT "analysis_run_stage_check";--> statement-breakpoint
ALTER TABLE "framework_version" ADD COLUMN "config_found" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "framework_version" ADD COLUMN "config_edited" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "report_template" ADD COLUMN "edited_by_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_stage_check" CHECK ("analysis_run"."stage" is null or "analysis_run"."stage" in ('read', 'survey', 'structure', 'extract', 'gaps', 'recover', 'write', 'config_survey', 'config_extract', 'config_write', 'embed', 'map', 'propose_new', 'finalise'));--> statement-breakpoint

-- Compiler step H (PRD 15.1 step 4; DEC-006, DEC-022): the analysis also reads policy, template and guidance documents and
-- writes the version's LIFECYCLE, DECISION / FINDING / RESPONSE vocabularies, RATING METHOD and REPORT TEMPLATES as proposals
-- into a DRAFT version. Publishing stays the gate. What this migration sets up:
--
--   * framework_version.config_found: what the analysis wrote into each configuration part, with the page and quote of every
--     item (the Settings tabs show it). A part that holds something not recorded here was made by a person or an import.
--   * framework_version.config_edited: the parts a person has changed. Set by the database (trigger b_mark_config_edit) on any
--     update that is not the worker's, like edited_by_person on requirement (0039), so every edit path counts.
--   * the worker may UPDATE the five configuration columns and config_found of a draft version, but only a part that is empty
--     or that the analysis itself wrote and nobody has edited since; never status, publication or review. It still cannot
--     delete anything.
--   * report_template: the worker may INSERT an AI template (origin ai, review pending, unedited) and UPDATE an AI template
--     nobody has touched; edited_by_person is set by the database, as on requirement.

CREATE FUNCTION config_part_is_empty(k text, v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT v IS NULL OR v IN ('null'::jsonb, '{}'::jsonb, '[]'::jsonb)
    OR (k = 'lifecycle_template' AND (jsonb_typeof(v -> 'phases') IS DISTINCT FROM 'array' OR jsonb_array_length(v -> 'phases') = 0));
$$;
--> statement-breakpoint

CREATE FUNCTION mark_config_edit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k text;
  edited jsonb := OLD.config_edited;
BEGIN
  IF current_user = 'ams_worker' THEN
    NEW.config_edited := OLD.config_edited;
    RETURN NEW;
  END IF;
  FOREACH k IN ARRAY ARRAY['lifecycle_template', 'decision_vocab', 'finding_vocab', 'response_vocab', 'rating_method'] LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      edited := edited || jsonb_build_object(k, true);
    END IF;
  END LOOP;
  NEW.config_edited := edited;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER b_mark_config_edit BEFORE UPDATE ON framework_version FOR EACH ROW EXECUTE FUNCTION mark_config_edit();
--> statement-breakpoint
CREATE TRIGGER b_mark_person_edit BEFORE UPDATE ON report_template FOR EACH ROW EXECUTE FUNCTION mark_person_edit();
--> statement-breakpoint

GRANT UPDATE (lifecycle_template, decision_vocab, finding_vocab, response_vocab, rating_method, config_found) ON framework_version TO ams_worker;
--> statement-breakpoint
GRANT INSERT ON report_template TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (name, kind, language, structure, word_limit, requires_attestation, source_document_id, source_page, source_quote, quote_verified) ON report_template TO ams_worker;
--> statement-breakpoint

-- The worker guard of 0044 with the configuration rule added for framework_version.
CREATE OR REPLACE FUNCTION framework_content_worker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v uuid;
  s text;
  internal_fw boolean;
  k text;
BEGIN
  IF current_user <> 'ams_worker' THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME = 'framework_version' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'the worker writes only into a draft framework version (this one is %)', OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT internal INTO internal_fw FROM framework WHERE id = OLD.framework_id;
    IF internal_fw THEN
      RAISE EXCEPTION 'the worker does not write the institution''s quality framework; it proposes, a person accepts' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    FOREACH k IN ARRAY ARRAY['lifecycle_template', 'decision_vocab', 'finding_vocab', 'response_vocab', 'rating_method'] LOOP
      IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
        IF coalesce(OLD.config_edited ->> k, '') = 'true' THEN
          RAISE EXCEPTION 'a person edited the % of this version; the worker cannot change it', k USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NOT (config_part_is_empty(k, to_jsonb(OLD) -> k) OR jsonb_exists(OLD.config_found, k)) THEN
          RAISE EXCEPTION 'the % of this version was not written by the analysis; the worker cannot change it', k USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'source_document' THEN
    IF NEW.role IS DISTINCT FROM OLD.role OR NEW.role_origin IS DISTINCT FROM OLD.role_origin THEN
      IF OLD.role_origin = 'manual' THEN
        RAISE EXCEPTION 'a person chose the role of this source; the worker cannot change it' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.role_origin <> 'ai' THEN
        RAISE EXCEPTION 'a role the worker sets is recorded as the analysis''s choice' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- requirement, requirement_note and report_template
  v := framework_version_of(TG_TABLE_NAME, to_jsonb(NEW));
  SELECT fv.status, f.internal INTO s, internal_fw FROM framework_version fv JOIN framework f ON f.id = fv.framework_id WHERE fv.id = v;
  IF s IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'the worker writes only into a draft framework version (this one is %)', s USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF internal_fw THEN
    RAISE EXCEPTION 'the worker does not write the institution''s quality framework; it proposes, a person accepts' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.origin <> 'ai' OR NEW.review_status <> 'pending' OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.edited_by_person THEN
      RAISE EXCEPTION 'the worker adds only unreviewed AI items (origin ai, review pending)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF OLD.origin <> 'ai' OR OLD.edited_by_person OR OLD.review_status <> 'pending' THEN
      RAISE EXCEPTION 'a person made, edited or reviewed this %; the worker cannot change it', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'requirement_note' THEN
    IF NEW.authority = 'required' AND NOT NEW.quote_verified THEN
      RAISE EXCEPTION 'an AI note may be required only with a verified quote' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER c_worker_guard BEFORE INSERT OR UPDATE ON report_template FOR EACH ROW EXECUTE FUNCTION framework_content_worker_guard();
--> statement-breakpoint
-- Only the new functions (a blanket grant would undo the REVOKEs of 0046 and 0049).
GRANT EXECUTE ON FUNCTION config_part_is_empty(text, jsonb), mark_config_edit() TO ams_app, ams_worker;
