CREATE TABLE "import_apply" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" uuid,
	"proposal_ids" uuid[] NOT NULL,
	"summary" text NOT NULL,
	"counts" jsonb NOT NULL,
	"inverse" jsonb DEFAULT 'null'::jsonb NOT NULL,
	"state" text DEFAULT 'applied' NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	CONSTRAINT "import_apply_state_check" CHECK ("import_apply"."state" in ('applied', 'undone')),
	CONSTRAINT "import_apply_counts_check" CHECK (jsonb_typeof("import_apply"."counts") = 'object')
);
--> statement-breakpoint
CREATE TABLE "import_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" uuid,
	"file_name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"file_path" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"read_status" text DEFAULT 'queued' NOT NULL,
	"read_error" text,
	"page_count" integer,
	CONSTRAINT "import_document_scope_kind_check" CHECK ("import_document"."scope_kind" in ('programs', 'org_chart', 'glossary')),
	CONSTRAINT "import_document_read_status_check" CHECK ("import_document"."read_status" in ('queued', 'reading', 'read', 'needs_ocr', 'failed')),
	CONSTRAINT "import_document_sha256_check" CHECK ("import_document"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "import_page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"import_document_id" uuid NOT NULL,
	"page_no" integer NOT NULL,
	"text" text NOT NULL,
	"method" text NOT NULL,
	"needs_ocr" boolean DEFAULT false NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "import_page_method_check" CHECK ("import_page"."method" in ('pdf_text', 'ocr', 'table', 'slide', 'sheet')),
	CONSTRAINT "import_page_no_check" CHECK ("import_page"."page_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "import_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"candidate" boolean DEFAULT true NOT NULL,
	"window_no" integer DEFAULT 0 NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"edited_payload" jsonb,
	"document_id" uuid,
	"page_no" integer,
	"quote" text,
	"quote_verified" boolean DEFAULT false NOT NULL,
	"confidence" real,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"applied_ref" jsonb,
	CONSTRAINT "import_proposal_status_check" CHECK ("import_proposal"."status" in ('pending', 'accepted', 'edited', 'skipped', 'applied'))
);
--> statement-breakpoint
CREATE TABLE "import_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" uuid,
	"target_kind" text NOT NULL,
	"document_ids" uuid[] NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model" text,
	"prompt_version" text,
	"usage" jsonb DEFAULT '{"inputTokens":0,"outputTokens":0,"costUsd":null,"calls":0}'::jsonb NOT NULL,
	"error" text,
	"started_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "import_run_status_check" CHECK ("import_run"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "import_run_stage_check" CHECK ("import_run"."stage" is null or "import_run"."stage" in ('read', 'extract', 'verify', 'propose', 'finalise')),
	CONSTRAINT "import_run_documents_check" CHECK (cardinality("import_run"."document_ids") >= 1)
);
--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_type_check";--> statement-breakpoint
ALTER TABLE "trash_item" DROP CONSTRAINT "trash_item_kind_check";--> statement-breakpoint
ALTER TABLE "import_apply" ADD CONSTRAINT "import_apply_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_apply" ADD CONSTRAINT "import_apply_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_apply" ADD CONSTRAINT "import_apply_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_apply" ADD CONSTRAINT "import_apply_run_id_import_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_apply" ADD CONSTRAINT "import_apply_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_document" ADD CONSTRAINT "import_document_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_document" ADD CONSTRAINT "import_document_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_document" ADD CONSTRAINT "import_document_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_page" ADD CONSTRAINT "import_page_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_page" ADD CONSTRAINT "import_page_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_page" ADD CONSTRAINT "import_page_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_page" ADD CONSTRAINT "import_page_import_document_id_import_document_id_fk" FOREIGN KEY ("import_document_id") REFERENCES "public"."import_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_proposal" ADD CONSTRAINT "import_proposal_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_proposal" ADD CONSTRAINT "import_proposal_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_proposal" ADD CONSTRAINT "import_proposal_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_proposal" ADD CONSTRAINT "import_proposal_run_id_import_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run" ADD CONSTRAINT "import_run_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run" ADD CONSTRAINT "import_run_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run" ADD CONSTRAINT "import_run_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run" ADD CONSTRAINT "import_run_started_by_app_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_apply_run_idx" ON "import_apply" USING btree ("run_id","applied_at");--> statement-breakpoint
CREATE INDEX "import_document_scope_idx" ON "import_document" USING btree ("institution_id","scope_kind","scope_id");--> statement-breakpoint
CREATE INDEX "import_document_sha_idx" ON "import_document" USING btree ("institution_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "import_page_doc_page_idx" ON "import_page" USING btree ("import_document_id","page_no");--> statement-breakpoint
CREATE INDEX "import_proposal_run_idx" ON "import_proposal" USING btree ("run_id","candidate","seq");--> statement-breakpoint
CREATE INDEX "import_run_scope_idx" ON "import_run" USING btree ("institution_id","scope_kind","scope_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_run_one_active_idx" ON "import_run" USING btree ("institution_id","scope_kind",coalesce("scope_id", '00000000-0000-0000-0000-000000000000'::uuid),"target_kind") WHERE "import_run"."status" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_type_check" CHECK ("job"."type" in ('extract_text', 'ocr', 'ai_extract', 'export', 'notify', 'analyse', 'purge_trash', 'assistant', 'import'));--> statement-breakpoint
ALTER TABLE "trash_item" ADD CONSTRAINT "trash_item_kind_check" CHECK ("trash_item"."kind" in ('requirement', 'note', 'source_document', 'source_page', 'report_template', 'framework_version', 'framework', 'mapping', 'evidence_link', 'milestone', 'import_document'));--> statement-breakpoint

-- Documents and AI import (TASK-075, DEC-006, DEC-013, DEC-024, DEC-028): tenant isolation and audit for the registry, the
-- run, its proposals and the stored Apply, and exactly what the worker (the agent and parser services) may write.
--
-- import_document / import_page: the parser job (extract_text with an importDocumentId) reads the stored file and fills the pages
--   and the read status. The worker never creates or deletes a document and cannot change its name, scope, file or hash.
-- import_run: like analysis_run; the worker moves its stage, progress, usage and report, and cannot revive an ended run.
-- import_proposal: the worker writes CANDIDATES (extract and verify stages) and merges them (propose stage); once released
--   (candidate = false) a proposal belongs to people. The worker cannot decide one (status, edited_payload, applied_ref are
--   not its to write) and cannot touch the target's real records at all: it has no grant on them.
-- import_apply: written only by the API's Apply as the person; the worker has no grant at all.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_document','import_page','import_run','import_proposal','import_apply'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id())', t);
    EXECUTE format('CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION stamp_actor()', t);
    EXECUTE format('CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON import_document, import_page TO ams_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON import_run, import_apply TO ams_app;
--> statement-breakpoint
GRANT SELECT ON import_proposal TO ams_app;
--> statement-breakpoint
GRANT UPDATE (edited_payload, status, applied_ref) ON import_proposal TO ams_app;
--> statement-breakpoint
GRANT SELECT ON import_document, import_page, import_run, import_proposal TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (read_status, read_error, page_count) ON import_document TO ams_worker;
--> statement-breakpoint
GRANT INSERT, DELETE ON import_page TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (text, method, needs_ocr, warnings) ON import_page TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (status, stage, progress, model, prompt_version, usage, error, started_at, finished_at, report) ON import_run TO ams_worker;
--> statement-breakpoint
GRANT INSERT, DELETE ON import_proposal TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (candidate, label, seq, page_no, quote, quote_verified, confidence, flags) ON import_proposal TO ams_worker;
--> statement-breakpoint

-- A run that has ended stays ended for the worker: a late job of a cancelled run cannot bring it back.
CREATE FUNCTION import_run_worker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'ams_worker' AND OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'import run % has ended (%); the worker cannot change it', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER c_worker_guard BEFORE UPDATE ON import_run FOR EACH ROW EXECUTE FUNCTION import_run_worker_guard();
--> statement-breakpoint

-- The worker adds only pending candidates to a run that is still working, and changes or removes only candidates. Released
-- proposals (candidate = false) are people's: edited, accepted, skipped and applied by them.
CREATE FUNCTION import_proposal_worker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  IF current_user <> 'ams_worker' THEN IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW.candidate OR NEW.status <> 'pending' OR NEW.edited_payload IS NOT NULL OR NEW.applied_ref IS NOT NULL THEN
      RAISE EXCEPTION 'the worker adds only pending candidates (a person decides, edits and applies proposals)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT status INTO s FROM import_run WHERE id = NEW.run_id;
    IF s IS DISTINCT FROM 'running' AND s IS DISTINCT FROM 'queued' THEN
      RAISE EXCEPTION 'import run % is %; the worker adds proposals only while it works', NEW.run_id, s USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT OLD.candidate THEN
    RAISE EXCEPTION 'this proposal has been released to people; the worker cannot change or remove it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER c_worker_guard BEFORE INSERT OR UPDATE OR DELETE ON import_proposal FOR EACH ROW EXECUTE FUNCTION import_proposal_worker_guard();
--> statement-breakpoint

-- What was applied does not change afterwards except its state, its counts and the undo information.
CREATE FUNCTION import_apply_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.proposal_ids IS DISTINCT FROM OLD.proposal_ids OR NEW.applied_at IS DISTINCT FROM OLD.applied_at OR NEW.target_kind IS DISTINCT FROM OLD.target_kind THEN
    RAISE EXCEPTION 'an applied import cannot be rewritten' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_rules BEFORE UPDATE ON import_apply FOR EACH ROW EXECUTE FUNCTION import_apply_rules();
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION import_run_worker_guard(), import_proposal_worker_guard(), import_apply_rules() TO ams_app, ams_worker;
