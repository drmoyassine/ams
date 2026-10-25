-- REPORTS (PRD 10, TASK-091). One object for every kind of report (application, self-study, annual, ...), made from a
-- report template of a framework version: the template's sections become report_section rows at creation, the template's
-- requirement codes resolve to requirement ids then, and section owners come from the engagement's requirement owners or
-- the standards' champions. Tenant RLS and the audit trigger as everywhere; the worker only reads (nothing in the
-- background writes a report, DEC-006).
--
-- The rules that must hold whatever the code does are triggers here:
--   * a report is for an engagement, or about a subject (institution, unit, program) — never both, never neither; what it
--     was made from (version, template, subject, round) never changes;
--   * the state machine is draft -> internally_approved -> submitted. Becoming internally approved stamps who and when,
--     and is refused while a section is not approved, or while the template's attestation is missing its signed letter;
--     becoming submitted requires having been internally approved and stamps who and when. Approved and submitted reports
--     do not change: a section of an internally approved report cannot be edited (reopen the section first, 094), a
--     submitted report freezes entirely (the submission snapshot of 094 is immutable on top of this);
--   * a section belongs to the report's institution; its key, block type and report never change; a section with content
--     is written only while the report is a draft and the section is draft or returned (the owner revises a returned one);
--     a section's status moves draft -> in_review -> approved, in_review -> returned, returned -> back to in_review or
--     draft, approved -> draft (reopen) — the moves themselves are TASK-094's services;
--   * the word count of a narrative is recomputed by the trigger from the stored plain text, never trusted from the caller;
--   * every person a row names belongs to the same institution (a foreign key does not see the tenant).

CREATE TABLE "report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"title" text NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"template_name" text NOT NULL,
	"kind" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"word_limit" integer,
	"requires_attestation" boolean DEFAULT false NOT NULL,
	"engagement_id" uuid,
	"subject_kind" text,
	"subject_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"submitted_ref" text,
	CONSTRAINT "report_kind_check" CHECK ("report"."kind" in ('application', 'readiness', 'self_study', 'follow_up', 'annual', 'response', 'other')),
	CONSTRAINT "report_status_check" CHECK ("report"."status" in ('draft', 'internally_approved', 'submitted')),
	CONSTRAINT "report_subject_kind_check" CHECK ("report"."subject_kind" is null or "report"."subject_kind" in ('institution', 'org_unit', 'program')),
	CONSTRAINT "report_wrapper_check" CHECK (("report"."engagement_id" is null) <> ("report"."subject_kind" is null)),
	CONSTRAINT "report_subject_pair_check" CHECK (("report"."subject_kind" is null) = ("report"."subject_id" is null)),
	CONSTRAINT "report_round_check" CHECK ("report"."round" >= 1),
	CONSTRAINT "report_approved_stamp_check" CHECK ("report"."status" <> 'internally_approved' or "report"."approved_at" is not null),
	CONSTRAINT "report_submitted_stamp_check" CHECK ("report"."status" <> 'submitted' or "report"."submitted_at" is not null)
);--> statement-breakpoint
CREATE TABLE "report_section" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"key" text NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"block_type" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"prompt" text,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"word_limit" integer,
	"word_count" integer,
	"columns" jsonb,
	"dataset_binding" jsonb,
	"owner_id" uuid,
	"owner_unresolved" boolean DEFAULT false NOT NULL,
	CONSTRAINT "report_section_block_type_check" CHECK ("report_section"."block_type" in ('narrative', 'data_table', 'compliance_matrix', 'evidence_index', 'feedback_response', 'attestation', 'appendix')),
	CONSTRAINT "report_section_status_check" CHECK ("report_section"."status" in ('draft', 'in_review', 'approved', 'returned')),
	CONSTRAINT "report_section_content_check" CHECK (jsonb_typeof("report_section"."content") = 'object'),
	CONSTRAINT "report_section_word_count_check" CHECK ("report_section"."word_count" is null or "report_section"."word_count" >= 0)
);--> statement-breakpoint
CREATE TABLE "report_section_requirement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"code" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_framework_version_id_framework_version_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_template_id_report_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."report_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_submitted_by_app_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_section" ADD CONSTRAINT "report_section_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_section" ADD CONSTRAINT "report_section_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_section" ADD CONSTRAINT "report_section_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_section" ADD CONSTRAINT "report_section_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_section" ADD CONSTRAINT "report_section_parent_id_report_section_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."report_section"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_section" ADD CONSTRAINT "report_section_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_section_requirement" ADD CONSTRAINT "report_section_requirement_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_section_requirement" ADD CONSTRAINT "report_section_requirement_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_section_requirement" ADD CONSTRAINT "report_section_requirement_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_section_requirement" ADD CONSTRAINT "report_section_requirement_section_id_report_section_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."report_section"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_section_requirement" ADD CONSTRAINT "report_section_requirement_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_institution_idx" ON "report" USING btree ("institution_id","status");--> statement-breakpoint
CREATE INDEX "report_version_idx" ON "report" USING btree ("framework_version_id");--> statement-breakpoint
CREATE INDEX "report_engagement_idx" ON "report" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "report_subject_idx" ON "report" USING btree ("institution_id","subject_kind","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_engagement_template_round_idx" ON "report" USING btree ("engagement_id","template_id","round");--> statement-breakpoint
CREATE UNIQUE INDEX "report_section_key_idx" ON "report_section" USING btree ("report_id","key");--> statement-breakpoint
CREATE INDEX "report_section_report_idx" ON "report_section" USING btree ("report_id","display_order");--> statement-breakpoint
CREATE INDEX "report_section_parent_idx" ON "report_section" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "report_section_owner_idx" ON "report_section" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_section_requirement_idx" ON "report_section_requirement" USING btree ("section_id","requirement_id");--> statement-breakpoint
CREATE INDEX "report_section_requirement_req_idx" ON "report_section_requirement" USING btree ("requirement_id");--> statement-breakpoint
ALTER TABLE "trash_item" DROP CONSTRAINT "trash_item_kind_check";--> statement-breakpoint
ALTER TABLE "trash_item" ADD CONSTRAINT "trash_item_kind_check" CHECK ("trash_item"."kind" in ('requirement', 'note', 'source_document', 'source_page', 'report_template', 'framework_version', 'framework', 'mapping', 'evidence_link', 'milestone', 'import_document', 'org_unit', 'cycle', 'report'));--> statement-breakpoint

-- Row-level security: the tenant. Who may read or write which report is the permission service's decision (the routes'
-- report:read / report:write / report:manage); the database narrows every role to the tenant and lets the worker read only.
ALTER TABLE report ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE report_section ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE report_section_requirement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON report USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY tenant ON report_section USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY tenant ON report_section_requirement USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON report, report_section, report_section_requirement TO ams_app;--> statement-breakpoint
GRANT SELECT ON report, report_section, report_section_requirement TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON report FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON report_section FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON report_section_requirement FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON report FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON report_section FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON report_section_requirement FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint

-- What a report is, and how it moves.
CREATE FUNCTION report_rules() RETURNS trigger LANGUAGE plpgsql AS $$
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
      OR (OLD.status = 'internally_approved' AND NEW.status = 'submitted')) THEN
      RAISE EXCEPTION 'a report that is % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
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
CREATE TRIGGER a_report_rules BEFORE INSERT OR UPDATE ON report FOR EACH ROW EXECUTE FUNCTION report_rules();--> statement-breakpoint

-- What a section is, and how it moves. The word count of a narrative is recomputed here from the stored plain text.
CREATE FUNCTION report_section_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  report_status text;
  rid uuid := COALESCE(NEW.report_id, OLD.report_id);
  inst uuid := COALESCE(NEW.institution_id, OLD.institution_id);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM report WHERE id = rid AND institution_id = inst) THEN
    RAISE EXCEPTION 'a section belongs to a report of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.owner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.owner_id AND institution_id = inst) THEN
    RAISE EXCEPTION 'the owner of a section must be a person of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status INTO report_status FROM report WHERE id = rid;
  IF TG_OP = 'DELETE' THEN
    IF report_status <> 'draft' THEN
      RAISE EXCEPTION 'the sections of a report are fixed once it leaves the draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    IF report_status <> 'draft' THEN
      RAISE EXCEPTION 'the sections of a report are fixed once it leaves the draft' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.report_id <> OLD.report_id OR NEW.key <> OLD.key OR NEW.block_type <> OLD.block_type OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
       OR NEW.title <> OLD.title OR NEW.prompt IS DISTINCT FROM OLD.prompt OR NEW.word_limit IS DISTINCT FROM OLD.word_limit
       OR NEW.display_order <> OLD.display_order OR NEW.columns IS DISTINCT FROM OLD.columns OR NEW.dataset_binding IS DISTINCT FROM OLD.dataset_binding THEN
      RAISE EXCEPTION 'the shape of a section comes from the template and cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status = 'in_review')
      OR (OLD.status = 'in_review' AND NEW.status IN ('approved', 'returned', 'draft'))
      OR (OLD.status = 'returned' AND NEW.status IN ('in_review', 'draft'))
      OR (OLD.status = 'approved' AND NEW.status = 'draft')) THEN
      RAISE EXCEPTION 'a section that is % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.content IS DISTINCT FROM OLD.content) AND NOT (report_status = 'draft' AND NEW.status IN ('draft', 'returned')) THEN
      RAISE EXCEPTION 'a section is written while the report is a draft and the section is draft or returned' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.block_type = 'narrative' THEN
    NEW.word_count := (SELECT count(*) FROM regexp_split_to_table(btrim(coalesce(NEW.content ->> 'text', '')), '\s+') AS w WHERE w <> '');
  ELSE
    NEW.word_count := NULL;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_report_section_rules BEFORE INSERT OR UPDATE OR DELETE ON report_section FOR EACH ROW EXECUTE FUNCTION report_section_rules();--> statement-breakpoint

-- A section's requirements are of the report's institution, and they are fixed with the shape.
CREATE FUNCTION report_section_requirement_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM report_section WHERE id = NEW.section_id AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'a link belongs to a section of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM requirement WHERE id = NEW.requirement_id AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'a section answers a requirement of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_report_section_requirement_rules BEFORE INSERT OR UPDATE ON report_section_requirement
  FOR EACH ROW EXECUTE FUNCTION report_section_requirement_rules();
