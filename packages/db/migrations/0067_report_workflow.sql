-- REPORT WORKFLOW (PRD 10.4 steps 2 to 5, TASK-094). Sections are reviewed and approved by people; the decisions are kept
-- (the submission snapshot's manifest lists the approvals); a report becomes internally approved only when every section is
-- approved and the attestation is there (the 0066 trigger already enforces both and stamps who and when); a submission
-- snapshot freezes the whole report (manifest, hashes) and is immutable (PRD 6.9); "Mark submitted" stamps the report and
-- completes its submission milestone. Reopening an approved section of an internally approved report sends the report back
-- to draft — the review starts over — and the database holds that invariant even against a forgotten demotion.

-- The decisions of the section review: one row per approve or return, kept forever. `returned` needs a note (what to fix),
-- like a rejected evidence link (TASK-088). Reopening an approved section is also recorded here: a `returned` decision.
CREATE TABLE "report_section_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_section_decision_decision_check" CHECK ("report_section_decision"."decision" in ('approved', 'returned')),
	CONSTRAINT "report_section_decision_note_check" CHECK ("report_section_decision"."decision" <> 'returned' OR ("report_section_decision"."note" IS NOT NULL AND length(btrim("report_section_decision"."note")) > 0))
);--> statement-breakpoint
ALTER TABLE "report_section_decision" ADD CONSTRAINT "report_section_decision_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_section_decision" ADD CONSTRAINT "report_section_decision_section_id_report_section_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."report_section"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_section_decision" ADD CONSTRAINT "report_section_decision_decided_by_app_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_section_decision_section_idx" ON "report_section_decision" USING btree ("section_id","decided_at");--> statement-breakpoint

ALTER TABLE report_section_decision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON report_section_decision USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON report_section_decision TO ams_app;--> statement-breakpoint
GRANT SELECT ON report_section_decision TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON report_section_decision FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON report_section_decision FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint

CREATE FUNCTION report_section_decision_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- The immutability check comes first: on UPDATE or DELETE `NEW` is the row leaving, and on DELETE it is unassigned,
	-- so the membership checks below (which read NEW) would fire with the wrong message.
	IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'a section decision is kept as it was made' USING ERRCODE = 'check_violation';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM report_section WHERE id = NEW.section_id AND institution_id = NEW.institution_id) THEN
		RAISE EXCEPTION 'a decision belongs to a section of the same institution' USING ERRCODE = 'check_violation';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.decided_by AND institution_id = NEW.institution_id) THEN
		RAISE EXCEPTION 'the decider must be a person of the same institution' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_report_section_decision_rules BEFORE INSERT OR UPDATE OR DELETE ON report_section_decision FOR EACH ROW EXECUTE FUNCTION report_section_decision_rules();--> statement-breakpoint

-- The submission snapshot (PRD 10.4 step 4): the whole report in one manifest — sections and their content, the
-- requirement ids and titles they answer, the approvals, the attestation, the cited evidence with its hashes — hashed, so
-- what went to the accreditor can always be shown. Immutable (PRD 6.9): one per report, never changed or removed. The
-- accreditor's reference of the submission lives on the report (it is known after the snapshot was taken).
CREATE TABLE "submission_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"export_files" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"sha256" text NOT NULL,
	CONSTRAINT "submission_snapshot_round_check" CHECK ("submission_snapshot"."round" >= 1),
	CONSTRAINT "submission_snapshot_sha256_check" CHECK ("submission_snapshot"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "submission_snapshot_manifest_check" CHECK (jsonb_typeof("submission_snapshot"."manifest") = 'object'),
	CONSTRAINT "submission_snapshot_export_files_check" CHECK (jsonb_typeof("submission_snapshot"."export_files") = 'array')
);--> statement-breakpoint
ALTER TABLE "submission_snapshot" ADD CONSTRAINT "submission_snapshot_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_snapshot" ADD CONSTRAINT "submission_snapshot_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "submission_snapshot_report_idx" ON "submission_snapshot" USING btree ("report_id");--> statement-breakpoint

ALTER TABLE submission_snapshot ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON submission_snapshot USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON submission_snapshot TO ams_app;--> statement-breakpoint
GRANT SELECT ON submission_snapshot TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON submission_snapshot FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON submission_snapshot FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint

CREATE FUNCTION submission_snapshot_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- Immutability first: on DELETE `NEW` is unassigned, and the checks below read it.
	IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'a submission snapshot is immutable' USING ERRCODE = 'check_violation';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM report WHERE id = NEW.report_id AND institution_id = NEW.institution_id) THEN
		RAISE EXCEPTION 'a snapshot belongs to a report of the same institution' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.round <> (SELECT round FROM report WHERE id = NEW.report_id) THEN
		RAISE EXCEPTION 'a snapshot carries its report''s round' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_submission_snapshot_rules BEFORE INSERT OR UPDATE OR DELETE ON submission_snapshot FOR EACH ROW EXECUTE FUNCTION submission_snapshot_rules();--> statement-breakpoint

-- The one rule of 0066 that TASK-094 refines: reopening an approved section sends an internally approved report back to
-- draft (the review starts over), and the stamps of the approval are cleared. Everything else about a report stays as it
-- was: draft -> internally_approved -> submitted, nothing else.
CREATE OR REPLACE FUNCTION report_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM report_template WHERE id = NEW.template_id AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'the template of a report must be one of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM framework_version WHERE id = NEW.framework_version_id AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'a report is made from a framework version of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.engagement_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM engagement WHERE id = NEW.engagement_id AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'a report belongs to an engagement of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.approved_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.approved_by AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'the approver must be a person of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.submitted_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.submitted_by AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'the submitter must be a person of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF length(trim(NEW.title)) = 0 THEN
    RAISE EXCEPTION 'a report has a title' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.approved_at IS NOT NULL OR NEW.submitted_at IS NOT NULL THEN
      RAISE EXCEPTION 'a report starts as a draft' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.framework_version_id <> OLD.framework_version_id OR NEW.template_id <> OLD.template_id OR NEW.template_key <> OLD.template_key
       OR NEW.template_name <> OLD.template_name OR NEW.kind <> OLD.kind OR NEW.language <> OLD.language
       OR NEW.word_limit IS DISTINCT FROM OLD.word_limit OR NEW.requires_attestation <> OLD.requires_attestation
       OR NEW.engagement_id IS DISTINCT FROM OLD.engagement_id OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
       OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.round <> OLD.round THEN
      RAISE EXCEPTION 'what a report was made from cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status = 'internally_approved')
      OR (OLD.status = 'internally_approved' AND NEW.status = 'submitted')
      OR (OLD.status = 'internally_approved' AND NEW.status = 'draft')) THEN
      RAISE EXCEPTION 'a report that is % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'draft' AND OLD.status = 'internally_approved' THEN
      -- The demotion is the consequence of reopening an approved section, never a move of its own.
      IF NOT EXISTS (SELECT 1 FROM report_section WHERE report_id = NEW.id AND status <> 'approved') THEN
        RAISE EXCEPTION 'a report returns to draft only when one of its sections was reopened' USING ERRCODE = 'check_violation';
      END IF;
      NEW.approved_at := NULL;
      NEW.approved_by := NULL;
    END IF;
    IF NEW.status = 'internally_approved' AND OLD.status = 'draft' THEN
      IF EXISTS (SELECT 1 FROM report_section WHERE report_id = NEW.id AND status <> 'approved') THEN
        RAISE EXCEPTION 'a report is internally approved only when every section is approved' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.requires_attestation AND NOT EXISTS (
           SELECT 1 FROM report_section WHERE report_id = NEW.id AND block_type = 'attestation'
             AND content ->> 'fileKey' IS NOT NULL AND content ->> 'signatoryName' IS NOT NULL) THEN
        RAISE EXCEPTION 'the template requires an attestation: name the signatory and upload the signed letter first' USING ERRCODE = 'check_violation';
      END IF;
      NEW.approved_at := now();
      NEW.approved_by := app_user_id();
    END IF;
    IF NEW.status = 'submitted' AND OLD.status = 'internally_approved' THEN
      NEW.submitted_at := now();
      NEW.submitted_by := app_user_id();
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- The invariant a forgotten demotion cannot break: by the time the transaction commits, an internally approved or
-- submitted report has every section approved. A section moved out of `approved` inside the transaction is fine only if
-- the report is demoted in the same transaction (the service does both together); after submission nothing reopens.
CREATE FUNCTION report_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  report_status text;
  rid uuid := NEW.report_id;
BEGIN
  SELECT status INTO report_status FROM report WHERE id = rid;
  IF report_status IN ('internally_approved', 'submitted') AND EXISTS (
       SELECT 1 FROM report_section WHERE report_id = rid AND status <> 'approved') THEN
    RAISE EXCEPTION 'an internally approved or submitted report has an unapproved section; reopen the report to draft in the same transaction';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER a_report_consistent AFTER UPDATE OF status ON report_section DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION report_consistent();
