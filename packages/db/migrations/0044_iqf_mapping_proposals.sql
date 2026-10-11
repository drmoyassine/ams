CREATE TABLE "iqf_item_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"framework_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"internal_framework_id" uuid NOT NULL,
	"analysis_run_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"parent_code" text,
	"level_label" text NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"reason" text,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"accepted_requirement_id" uuid,
	CONSTRAINT "iqf_item_proposal_status_check" CHECK ("iqf_item_proposal"."status" in ('pending', 'accepted', 'dismissed', 'superseded')),
	CONSTRAINT "iqf_item_proposal_links_check" CHECK (jsonb_typeof("iqf_item_proposal"."links") = 'array')
);
--> statement-breakpoint
ALTER TABLE "analysis_run" DROP CONSTRAINT "analysis_run_stage_check";--> statement-breakpoint
ALTER TABLE "requirement_mapping" ADD COLUMN "edited_by_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "iqf_item_proposal" ADD CONSTRAINT "iqf_item_proposal_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iqf_item_proposal" ADD CONSTRAINT "iqf_item_proposal_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iqf_item_proposal" ADD CONSTRAINT "iqf_item_proposal_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iqf_item_proposal" ADD CONSTRAINT "iqf_item_proposal_framework_id_framework_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iqf_item_proposal" ADD CONSTRAINT "iqf_item_proposal_framework_version_id_framework_version_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iqf_item_proposal" ADD CONSTRAINT "iqf_item_proposal_internal_framework_id_framework_id_fk" FOREIGN KEY ("internal_framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iqf_item_proposal" ADD CONSTRAINT "iqf_item_proposal_analysis_run_id_analysis_run_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."analysis_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iqf_item_proposal" ADD CONSTRAINT "iqf_item_proposal_decided_by_app_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iqf_item_proposal" ADD CONSTRAINT "iqf_item_proposal_accepted_requirement_id_requirement_id_fk" FOREIGN KEY ("accepted_requirement_id") REFERENCES "public"."requirement"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "iqf_item_proposal_version_idx" ON "iqf_item_proposal" USING btree ("framework_version_id","status");--> statement-breakpoint
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_stage_check" CHECK ("analysis_run"."stage" is null or "analysis_run"."stage" in ('read', 'survey', 'structure', 'extract', 'gaps', 'recover', 'write', 'embed', 'map', 'propose_new', 'finalise'));--> statement-breakpoint

-- Framework analysis, step E (DEC-006, DEC-021, DEC-022, DEC-023): the run proposes links from an external standard's
-- requirements to the institution's quality framework (IQF), and NEW IQF items where nothing fits. All of it stays a
-- proposal until a person accepts it. What this migration sets up:
--
--   * requirement_mapping: the worker may now INSERT a link, but only as a proposal (origin 'ai', review 'pending', no
--     reviewer, not marked as a person's edit) and UPDATE only the relation and reason of an AI link nobody has touched.
--     It cannot approve, reject, delete, or touch a link a person made, edited or reviewed. `edited_by_person` is set by
--     the database on any non-worker update (like requirement, 0039).
--   * iqf_item_proposal: tenant RLS, audit, and the same discipline: the worker inserts 'pending' rows and updates only
--     pending ones (new wording, or 'superseded' when a later run replaces them); accepted and dismissed are people's.
--   * The worker no longer writes the IQF itself: requirement, requirement_note and framework_version guards refuse an
--     internal framework (the worker's draft-writing grants of 0039 were meant for external standards).
--   * The publish gate's "AI-originated item needs a source reference" rule applies to external standards only: an IQF
--     item a person accepted from a proposal has no source page (its basis is the external requirements it links to), and
--     the IQF's own rule, every item approved by a person, is unchanged.

ALTER TABLE iqf_item_proposal ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON iqf_item_proposal USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());
--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON iqf_item_proposal FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON iqf_item_proposal FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON iqf_item_proposal TO ams_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON iqf_item_proposal TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (analysis_run_id, status, parent_code, level_label, code, title, description, reason, links) ON iqf_item_proposal TO ams_worker;
--> statement-breakpoint

CREATE FUNCTION iqf_item_proposal_worker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'ams_worker' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.accepted_requirement_id IS NOT NULL THEN
      RAISE EXCEPTION 'the worker proposes new quality framework items; it cannot accept or dismiss them' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM framework WHERE id = NEW.internal_framework_id AND internal)
       OR EXISTS (SELECT 1 FROM framework WHERE id = NEW.framework_id AND internal) THEN
      RAISE EXCEPTION 'a proposal is from an external standard onto the quality framework' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'a person decided this proposal (%); the worker cannot change it', OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status NOT IN ('pending', 'superseded') THEN
      RAISE EXCEPTION 'the worker cannot accept or dismiss a proposal' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER c_worker_guard BEFORE INSERT OR UPDATE ON iqf_item_proposal FOR EACH ROW EXECUTE FUNCTION iqf_item_proposal_worker_guard();
--> statement-breakpoint

GRANT INSERT ON requirement_mapping TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (relation, rationale) ON requirement_mapping TO ams_worker;
--> statement-breakpoint

CREATE FUNCTION requirement_mapping_worker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'ams_worker' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.origin <> 'ai' OR NEW.review_status <> 'pending' OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.edited_by_person THEN
      RAISE EXCEPTION 'the worker proposes links only (origin ai, review pending); a person approves them' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF OLD.origin <> 'ai' OR OLD.edited_by_person OR OLD.review_status <> 'pending' THEN
      RAISE EXCEPTION 'a person made, edited or reviewed this mapping; the worker cannot change it' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER c_worker_guard BEFORE INSERT OR UPDATE ON requirement_mapping FOR EACH ROW EXECUTE FUNCTION requirement_mapping_worker_guard();
--> statement-breakpoint
CREATE TRIGGER b_mark_person_edit BEFORE UPDATE ON requirement_mapping FOR EACH ROW EXECUTE FUNCTION mark_person_edit();
--> statement-breakpoint

-- The worker does not write the quality framework: the draft-writing rules of 0039, plus a refusal for the internal one.
CREATE OR REPLACE FUNCTION framework_content_worker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v uuid;
  s text;
  internal_fw boolean;
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

  -- requirement and requirement_note
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

-- The publish gate (0042) with one change: the source-reference rule for AI-originated items is for external standards.
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

  IF NOT is_internal THEN
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
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ams_app, ams_worker;
