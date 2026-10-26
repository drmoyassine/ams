-- THE IQF FROM DOCUMENTS (TASK-107). The internal quality framework is analysed from the institution's own documents like
-- an external standard: the analysis gains a `wording` stage and the internal version is no longer refused. A document may
-- also propose improved wording for an existing, human-written item: one row per proposal, carrying the quote it came from
-- and the text it proposes to replace, decided (accepted or declined) by a person — never applied silently. A published
-- version is never touched: an analysis writes only into a draft, and a decision edits the draft's requirement. The
-- worker-guard of 0044 and 0050, which kept the worker out of the institution's framework altogether, gives way to the
-- same proposal rules as any external standard: the worker drafts unreviewed AI rows into the internal DRAFT and nothing
-- more — the level names (DEC-016) were never among its columns, and a person's rows stay out of its reach.
ALTER TABLE "analysis_run" DROP CONSTRAINT "analysis_run_stage_check";--> statement-breakpoint
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_stage_check" CHECK ("analysis_run"."stage" is null or "analysis_run"."stage" in ('read', 'survey', 'structure', 'extract', 'gaps', 'recover', 'write', 'config_survey', 'config_extract', 'config_write', 'wording', 'embed', 'map', 'propose_new', 'finalise'));--> statement-breakpoint

CREATE TABLE "wording_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"analysis_run_id" uuid,
	"source_document_id" uuid,
	"source_page" integer,
	"source_quote" text NOT NULL,
	"current_text" text NOT NULL,
	"proposed_text" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "wording_proposal_status_check" CHECK ("wording_proposal"."status" in ('pending', 'accepted', 'declined')),
	CONSTRAINT "wording_proposal_current_text_check" CHECK (length(btrim("wording_proposal"."current_text")) > 0),
	CONSTRAINT "wording_proposal_proposed_text_check" CHECK (length(btrim("wording_proposal"."proposed_text")) > 0),
	CONSTRAINT "wording_proposal_source_quote_check" CHECK (length(btrim("wording_proposal"."source_quote")) > 0),
	CONSTRAINT "wording_proposal_decision_check" CHECK (("wording_proposal"."status" = 'pending') = ("wording_proposal"."decided_by" is null AND "wording_proposal"."decided_at" is null))
);--> statement-breakpoint
ALTER TABLE "wording_proposal" ADD CONSTRAINT "wording_proposal_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wording_proposal" ADD CONSTRAINT "wording_proposal_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wording_proposal" ADD CONSTRAINT "wording_proposal_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wording_proposal" ADD CONSTRAINT "wording_proposal_framework_version_id_framework_version_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wording_proposal" ADD CONSTRAINT "wording_proposal_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wording_proposal" ADD CONSTRAINT "wording_proposal_analysis_run_id_analysis_run_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wording_proposal" ADD CONSTRAINT "wording_proposal_source_document_id_source_document_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_document"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wording_proposal" ADD CONSTRAINT "wording_proposal_decided_by_app_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wording_proposal_version_idx" ON "wording_proposal" USING btree ("framework_version_id","status");--> statement-breakpoint

ALTER TABLE wording_proposal ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- The institution's proposals, like the extraction's: everyone acting in the institution sees them; only a person decides.
CREATE POLICY tenant ON wording_proposal USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON wording_proposal TO ams_app;--> statement-breakpoint
-- The agent writes proposals during the analysis and never decides one (DEC-006).
GRANT SELECT, INSERT ON wording_proposal TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON wording_proposal FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON wording_proposal FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint

CREATE FUNCTION wording_proposal_checks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'a wording proposal is decided once' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'pending' AND (NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a pending wording proposal has no decision' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.requirement_id <> OLD.requirement_id OR NEW.framework_version_id <> OLD.framework_version_id
       OR NEW.source_quote <> OLD.source_quote OR NEW.current_text <> OLD.current_text OR NEW.proposed_text <> OLD.proposed_text
       OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.analysis_run_id IS DISTINCT FROM OLD.analysis_run_id
       OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id OR NEW.source_page IS DISTINCT FROM OLD.source_page THEN
      RAISE EXCEPTION 'only the status of a wording proposal can change' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status <> 'pending' AND NEW.decided_by IS NULL THEN
    RAISE EXCEPTION 'a decided wording proposal names who decided it' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM requirement r JOIN framework_version v ON v.id = r.framework_version_id
    WHERE r.id = NEW.requirement_id AND r.framework_version_id = NEW.framework_version_id AND v.institution_id = NEW.institution_id
  ) THEN
    RAISE EXCEPTION 'a wording proposal names a requirement of its own version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_wording_proposal_checks BEFORE INSERT OR UPDATE ON wording_proposal FOR EACH ROW EXECUTE FUNCTION wording_proposal_checks();--> statement-breakpoint

-- The worker-guard of 0044 and 0050, without the blanket refusal for the internal framework (TASK-107): the analysis of
-- the institution's own documents drafts into its draft exactly as into an external standard's draft — unreviewed AI rows
-- only, a person's rows untouched, only where the version is still a draft. Two things stay the institution's alone:
-- the level names (DEC-016, below), and every decision — the worker proposes, a person decides.
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
    -- The institution names the levels of its own framework (DEC-016); the analysis records its proposal on the run.
    SELECT internal INTO internal_fw FROM framework WHERE id = OLD.framework_id;
    IF internal_fw AND to_jsonb(NEW) -> 'level_labels' IS DISTINCT FROM to_jsonb(OLD) -> 'level_labels' THEN
      RAISE EXCEPTION 'the institution names the levels of its own framework; the worker does not' USING ERRCODE = 'integrity_constraint_violation';
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
  SELECT fv.status INTO s FROM framework_version fv WHERE fv.id = v;
  IF s IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'the worker writes only into a draft framework version (this one is %)', s USING ERRCODE = 'integrity_constraint_violation';
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
