-- EVIDENCE COLLECTION RUNS (TASK-090, DEC-031). A run is one period of an evidence item's schedule, made once, carried out by the item's
-- collection method (ask the BI, send a request, open the form, tell the owner) and supplied by the evidence version that answers it.
-- Forward-only. Nothing is re-granted broadly: the worker (the scheduler and the executor) gets exactly what a run needs and each grant is
-- narrowed by a trigger or a policy below; it still never approves, publishes or sets an official status (DEC-006).

-- The notification kinds of runs, and the scheduler's job type (it carries no job row, like purge_trash).
ALTER TABLE "notification" DROP CONSTRAINT "notification_kind_check";--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_kind_check" CHECK ("notification"."kind" in ('link_rejected', 'link_approved', 'collection_due', 'collection_late', 'collection_failed'));--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_type_check";--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_type_check" CHECK ("job"."type" in ('extract_text', 'ocr', 'ai_extract', 'export', 'notify', 'analyse', 'purge_trash', 'collect_tick', 'assistant', 'import', 'translate'));--> statement-breakpoint

CREATE TABLE "evidence_collection_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"evidence_item_id" uuid NOT NULL,
	"period_label" text NOT NULL,
	"scheduled_for" date NOT NULL,
	"period_end" date,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"version_id" uuid,
	"requested_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"callback_token_hash" text,
	"callback_expires_at" timestamp with time zone,
	"skip_reason" text,
	CONSTRAINT "evidence_collection_run_status_check" CHECK ("evidence_collection_run"."status" in ('pending', 'requested', 'supplied', 'late', 'failed', 'skipped')),
	CONSTRAINT "evidence_collection_run_trigger_check" CHECK ("evidence_collection_run"."trigger" in ('schedule', 'manual')),
	CONSTRAINT "evidence_collection_run_attempts_check" CHECK ("evidence_collection_run"."attempts" >= 0),
	CONSTRAINT "evidence_collection_run_details_check" CHECK (jsonb_typeof("evidence_collection_run"."details") = 'object'),
	CONSTRAINT "evidence_collection_run_supplied_check" CHECK ("evidence_collection_run"."status" <> 'supplied' or "evidence_collection_run"."version_id" is not null),
	CONSTRAINT "evidence_collection_run_skipped_check" CHECK ("evidence_collection_run"."status" <> 'skipped' or length(trim(coalesce("evidence_collection_run"."skip_reason", ''))) > 0),
	CONSTRAINT "evidence_collection_run_failed_check" CHECK ("evidence_collection_run"."status" <> 'failed' or "evidence_collection_run"."last_error" is not null),
	CONSTRAINT "evidence_collection_run_token_pair_check" CHECK (("evidence_collection_run"."callback_token_hash" is null) = ("evidence_collection_run"."callback_expires_at" is null))
);--> statement-breakpoint
ALTER TABLE "evidence_collection_run" ADD CONSTRAINT "evidence_collection_run_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_collection_run" ADD CONSTRAINT "evidence_collection_run_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_collection_run" ADD CONSTRAINT "evidence_collection_run_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_collection_run" ADD CONSTRAINT "evidence_collection_run_evidence_item_id_evidence_item_id_fk" FOREIGN KEY ("evidence_item_id") REFERENCES "public"."evidence_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_collection_run" ADD CONSTRAINT "evidence_collection_run_version_id_evidence_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."evidence_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_collection_run_period_idx" ON "evidence_collection_run" USING btree ("evidence_item_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "evidence_collection_run_status_idx" ON "evidence_collection_run" USING btree ("institution_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_collection_run_token_idx" ON "evidence_collection_run" USING btree ("callback_token_hash");--> statement-breakpoint

-- A request made by a run (the `request` method): its answer is a new version of the run's item, not a new item.
ALTER TABLE "evidence_request" ADD COLUMN "collection_run_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence_request" ADD CONSTRAINT "evidence_request_collection_run_id_evidence_collection_run_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."evidence_collection_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_request_run_idx" ON "evidence_request" USING btree ("collection_run_id");--> statement-breakpoint
ALTER TABLE "evidence_request" DROP CONSTRAINT "evidence_request_target";--> statement-breakpoint
ALTER TABLE "evidence_request" ADD CONSTRAINT "evidence_request_target" CHECK (("evidence_request"."internal_framework_id" is not null and "evidence_request"."internal_code" is not null) or "evidence_request"."data_item_id" is not null or "evidence_request"."collection_run_id" is not null);--> statement-breakpoint

-- Row-level security: a run is visible with its evidence item (a restricted item's runs are visible only to those who see the item).
ALTER TABLE evidence_collection_run ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY scoped ON evidence_collection_run FOR ALL TO ams_app
  USING (institution_id = app_institution_id() AND app_can_see_evidence(evidence_item_id))
  WITH CHECK (institution_id = app_institution_id() AND app_can_see_evidence(evidence_item_id));--> statement-breakpoint
CREATE POLICY worker_read ON evidence_collection_run FOR SELECT TO ams_worker
  USING (institution_id = app_institution_id() AND app_can_see_evidence(evidence_item_id));--> statement-breakpoint
CREATE POLICY worker_insert ON evidence_collection_run FOR INSERT TO ams_worker
  WITH CHECK (institution_id = app_institution_id() AND app_can_see_evidence(evidence_item_id));--> statement-breakpoint
CREATE POLICY worker_update ON evidence_collection_run FOR UPDATE TO ams_worker
  USING (institution_id = app_institution_id() AND app_can_see_evidence(evidence_item_id))
  WITH CHECK (institution_id = app_institution_id() AND app_can_see_evidence(evidence_item_id));--> statement-breakpoint
-- Runs are kept: no delete for anyone. The app skips, retries and supplies; the worker makes runs and moves them along, in these
-- columns only (it cannot skip, and cannot change what a run is about).
GRANT SELECT, INSERT, UPDATE ON evidence_collection_run TO ams_app;--> statement-breakpoint
GRANT SELECT, INSERT ON evidence_collection_run TO ams_worker;--> statement-breakpoint
GRANT UPDATE (status, attempts, requested_at, responded_at, last_error, next_attempt_at, details, version_id, callback_token_hash, callback_expires_at)
  ON evidence_collection_run TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON evidence_collection_run FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON evidence_collection_run FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint

-- Two lookups that must see past row-level security: which institution an item belongs to, and which item a version belongs to.
CREATE FUNCTION collection_item_institution(p_item uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT institution_id FROM evidence_item WHERE id = p_item $$;--> statement-breakpoint
CREATE FUNCTION collection_version_item(p_version uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT evidence_item_id FROM evidence_version WHERE id = p_version $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION collection_item_institution(uuid), collection_version_item(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION collection_item_institution(uuid), collection_version_item(uuid) TO ams_app, ams_worker;--> statement-breakpoint

-- What a run is, and how it moves. The item and the version belong to the run's institution (the version to the run's item); the period
-- never changes; a status moves only along the allowed ways; the BI's one-time token is cleared the moment the run is supplied,
-- skipped or failed; the worker never skips a run (only a person decides to).
--   pending   -> requested | supplied | late | failed | skipped
--   requested -> supplied | late | failed | skipped
--   late      -> supplied | failed | skipped        (a late run still takes a supply)
--   failed    -> requested | supplied | skipped      (retry, or a person supplies or skips it)
--   supplied and skipped are final.
CREATE FUNCTION collection_run_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF collection_item_institution(NEW.evidence_item_id) IS DISTINCT FROM NEW.institution_id THEN
    RAISE EXCEPTION 'a collection run belongs to an evidence item of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version_id IS NOT NULL AND collection_version_item(NEW.version_id) IS DISTINCT FROM NEW.evidence_item_id THEN
    RAISE EXCEPTION 'a run is supplied by a version of its own evidence item' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.evidence_item_id <> OLD.evidence_item_id OR NEW.institution_id <> OLD.institution_id OR NEW.scheduled_for <> OLD.scheduled_for
       OR NEW.period_label <> OLD.period_label OR NEW.period_end IS DISTINCT FROM OLD.period_end OR NEW.due_at <> OLD.due_at OR NEW."trigger" <> OLD."trigger" THEN
      RAISE EXCEPTION 'what a collection run is about cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'pending' AND NEW.status IN ('requested', 'supplied', 'late', 'failed', 'skipped'))
      OR (OLD.status = 'requested' AND NEW.status IN ('supplied', 'late', 'failed', 'skipped'))
      OR (OLD.status = 'late' AND NEW.status IN ('supplied', 'failed', 'skipped'))
      OR (OLD.status = 'failed' AND NEW.status IN ('requested', 'supplied', 'skipped'))) THEN
      RAISE EXCEPTION 'a run that is % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status IN ('supplied', 'skipped') AND (NEW.version_id IS DISTINCT FROM OLD.version_id OR NEW.skip_reason IS DISTINCT FROM OLD.skip_reason) THEN
      RAISE EXCEPTION 'a % run is final', OLD.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF current_user = 'ams_worker' AND NEW.status = 'skipped' THEN
    RAISE EXCEPTION 'a person decides to skip a period' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IN ('supplied', 'skipped', 'failed') THEN
    NEW.callback_token_hash := NULL;
    NEW.callback_expires_at := NULL;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_collection_run_rules BEFORE INSERT OR UPDATE ON evidence_collection_run FOR EACH ROW EXECUTE FUNCTION collection_run_rules();--> statement-breakpoint

-- The scheduler has no tenant of its own (row-level security shows it nothing), so it asks this one narrow question: which institutions have
-- an active scheduled item, or a run that is waiting for something. Then it works each institution under a system identity.
CREATE FUNCTION collection_institutions() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT institution_id FROM evidence_item WHERE status = 'active' AND schedule IS NOT NULL AND method <> 'survey'
  UNION
  SELECT institution_id FROM evidence_collection_run WHERE status IN ('pending', 'requested', 'late') OR (status = 'failed' AND next_attempt_at IS NOT NULL)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION collection_institutions() FROM PUBLIC, ams_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION collection_institutions() TO ams_worker;--> statement-breakpoint

-- The BI's callback finds its run by id, before any institution is known; the caller compares the token's hash in constant time.
-- It answers only for a run that holds a token (nothing for a run whose token was used, cleared or never issued).
CREATE FUNCTION app_resolve_collection_callback(p_run uuid) RETURNS TABLE (institution_id uuid, token_hash text, expires_at timestamptz, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT r.institution_id, r.callback_token_hash, r.callback_expires_at, r.status FROM evidence_collection_run r WHERE r.id = p_run AND r.callback_token_hash IS NOT NULL $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_resolve_collection_callback(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_resolve_collection_callback(uuid) TO ams_app;--> statement-breakpoint

-- ---- What the worker may do for a run, beyond the run itself -------------------------------------------------------------------------
-- 1. Keep the item's next due time and last run time (the schedule's bookkeeping), and nothing else of the item.
GRANT UPDATE (next_due_at, last_run_at) ON evidence_item TO ams_worker;--> statement-breakpoint

-- 2. Add the version the BI supplied (never one of a person): the lineage names the BI as the origin.
GRANT INSERT ON evidence_version TO ams_worker;--> statement-breakpoint
CREATE FUNCTION evidence_version_worker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'ams_worker' AND coalesce(NEW.lineage ->> 'origin', '') <> 'bi' THEN
    RAISE EXCEPTION 'the worker adds only the versions the BI supplied' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER b_evidence_version_worker_guard BEFORE INSERT ON evidence_version FOR EACH ROW EXECUTE FUNCTION evidence_version_worker_guard();--> statement-breakpoint

-- 3. Send the request of a `request` run (the worker cannot answer, cancel or change any request).
GRANT INSERT ON evidence_request TO ams_worker;--> statement-breakpoint
CREATE OR REPLACE FUNCTION evidence_request_rules() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NEW.internal_framework_id IS DISTINCT FROM OLD.internal_framework_id OR NEW.internal_code IS DISTINCT FROM OLD.internal_code
       OR NEW.data_item_id IS DISTINCT FROM OLD.data_item_id OR NEW.collection_run_id IS DISTINCT FROM OLD.collection_run_id THEN
      RAISE EXCEPTION 'a request''s target cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'open' AND (NEW.status <> OLD.status OR NEW.token_hash IS NOT NULL) THEN
      RAISE EXCEPTION 'this request is closed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 4. Open the online form of a `form` run (it never closes one).
GRANT UPDATE (form_open) ON dataset_spec TO ams_worker;--> statement-breakpoint
CREATE FUNCTION dataset_spec_worker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'ams_worker' AND (NEW.form_open IS NOT TRUE OR NEW.columns IS DISTINCT FROM OLD.columns OR NEW.form_link_token IS DISTINCT FROM OLD.form_link_token) THEN
    RAISE EXCEPTION 'the worker only opens a form' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER b_dataset_spec_worker_guard BEFORE UPDATE ON dataset_spec FOR EACH ROW EXECUTE FUNCTION dataset_spec_worker_guard();--> statement-breakpoint

-- 5. Tell people: the notices of runs (due, late, failed) and no other kind.
GRANT INSERT ON notification TO ams_worker;--> statement-breakpoint
CREATE POLICY worker_notify ON notification FOR INSERT TO ams_worker
  WITH CHECK (institution_id = app_institution_id() AND kind IN ('collection_due', 'collection_late', 'collection_failed'));
