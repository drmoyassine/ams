-- STANDARDS NUMBERED BY THEIR PLACE (the owner, 2026-11-23): in a draft, a move, an addition or a deletion renumbers the version's codes
-- (1, 2, 2.1 … 2.5). What is attached to a standard by framework and code (scope, champion, frequency, approval steps, evidence links,
-- evidence requests, mappings, cycle plans, submissions) follows the new code when the draft is published, so the published version
-- keeps its own until then.
--   framework_version.auto_number  the version numbers its standards by place (off unless a person turns it on; a new version keeps it);
--   requirement.carried_from_id  the requirement of the earlier version this one was copied from (how a publish knows old -> new);
--   app.renumbering              a transaction flag set only while a publish renames codes: it lets an evidence link and an approved
--                                submission change their code, and nothing else.
ALTER TABLE framework_version ADD COLUMN auto_number boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE requirement ADD COLUMN carried_from_id uuid REFERENCES requirement(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX requirement_carried_from_idx ON requirement (carried_from_id);--> statement-breakpoint
-- The drafts there are now came from the newest published version of their standard, codes unchanged since: match on the code.
UPDATE requirement d SET carried_from_id = p.id
FROM framework_version dv, requirement p, framework_version pv
WHERE dv.id = d.framework_version_id AND dv.status = 'draft'
  AND pv.framework_id = dv.framework_id AND pv.status = 'published' AND p.framework_version_id = pv.id AND p.code = d.code
  AND pv.id = (SELECT x.id FROM framework_version x WHERE x.framework_id = dv.framework_id AND x.status = 'published' ORDER BY x.created_at DESC LIMIT 1);--> statement-breakpoint

CREATE OR REPLACE FUNCTION evidence_link_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  renaming boolean := coalesce(current_setting('app.renumbering', true), '') = 'on';
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.evidence_version_id <> OLD.evidence_version_id
      OR NEW.engagement_requirement_id IS DISTINCT FROM OLD.engagement_requirement_id
      OR NEW.internal_framework_id IS DISTINCT FROM OLD.internal_framework_id
      OR (NEW.internal_code IS DISTINCT FROM OLD.internal_code AND NOT renaming)) THEN
    RAISE EXCEPTION 'a link''s evidence and target cannot change; link again instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION quality_submission_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s text;
BEGIN
  IF TG_TABLE_NAME = 'quality_submission' THEN
    IF OLD.status = 'approved' THEN
      -- A publish that renumbers the standards may rename the code; nothing else of an approved submission changes.
      IF TG_OP = 'UPDATE' AND coalesce(current_setting('app.renumbering', true), '') = 'on'
         AND (to_jsonb(NEW) - 'code' - 'updated_at' - 'updated_by') = (to_jsonb(OLD) - 'code' - 'updated_at' - 'updated_by') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'an approved submission is kept as it is' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO s FROM quality_submission WHERE id = COALESCE(NEW.submission_id, OLD.submission_id);
  IF s = 'approved' THEN RAISE EXCEPTION 'an approved submission is kept as it is' USING ERRCODE = 'check_violation'; END IF;
  IF TG_TABLE_NAME = 'quality_submission_step' AND TG_OP <> 'INSERT' THEN
    IF OLD.decision <> 'pending' THEN RAISE EXCEPTION 'a decided step is kept as it is' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
