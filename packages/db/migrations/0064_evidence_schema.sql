-- The evidence schema (TASK-089, DEC-031). An evidence item has a title, a type, a definition and ONE collection method with an
-- optional schedule. Forward-only; every existing row stays valid.
--   * description is renamed definition (the word "description" goes away);
--   * the type `data` is renamed `dataset`;
--   * a dataset's own definition (dataset_spec.definition) is merged into the item's definition and the column dropped;
--   * new: method (manual | form | request | bi | survey), method_config, schedule, next_due_at, last_run_at.
-- RLS, audit, stamping, immutability and the worker's read-only grants are untouched: the table keeps its table-level grants, which
-- cover the new columns, and nothing is granted here.

ALTER TABLE "evidence_item" RENAME COLUMN "description" TO "definition";--> statement-breakpoint

-- data -> dataset (the check is replaced around the update).
ALTER TABLE "evidence_item" DROP CONSTRAINT "evidence_item_type_check";--> statement-breakpoint
UPDATE "evidence_item" SET "type" = 'dataset' WHERE "type" = 'data';--> statement-breakpoint
ALTER TABLE "evidence_item" ADD CONSTRAINT "evidence_item_type_check" CHECK ("evidence_item"."type" in ('document', 'dataset'));--> statement-breakpoint

-- The two rules that named the old type (a specification only for datasets; a form request only for a dataset).
CREATE OR REPLACE FUNCTION dataset_spec_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.evidence_item_id <> OLD.evidence_item_id THEN
    RAISE EXCEPTION 'a dataset specification belongs to one item' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM evidence_item WHERE id = NEW.evidence_item_id AND type = 'dataset') THEN
    RAISE EXCEPTION 'only dataset evidence has a dataset specification' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION evidence_request_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.internal_framework_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM framework WHERE id = NEW.internal_framework_id AND internal) THEN
    RAISE EXCEPTION 'evidence is requested for items of the internal quality framework' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.data_item_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM evidence_item WHERE id = NEW.data_item_id AND type = 'dataset') THEN
    RAISE EXCEPTION 'a form request asks for dataset evidence' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.internal_framework_id IS DISTINCT FROM OLD.internal_framework_id OR NEW.internal_code IS DISTINCT FROM OLD.internal_code
       OR NEW.data_item_id IS DISTINCT FROM OLD.data_item_id THEN
      RAISE EXCEPTION 'a request''s target cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'open' AND (NEW.status <> OLD.status OR NEW.token_hash IS NOT NULL) THEN
      RAISE EXCEPTION 'this request is closed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- A dataset's definition joins the item's: copied when the item has none, appended (after a blank line) when it has its own and
-- they differ, so no text is lost. Then the column goes.
UPDATE "evidence_item" e SET "definition" = btrim(s."definition")
  FROM "dataset_spec" s
  WHERE s."evidence_item_id" = e."id" AND nullif(btrim(s."definition"), '') IS NOT NULL AND nullif(btrim(e."definition"), '') IS NULL;--> statement-breakpoint
UPDATE "evidence_item" e SET "definition" = e."definition" || E'\n\n' || btrim(s."definition")
  FROM "dataset_spec" s
  WHERE s."evidence_item_id" = e."id" AND nullif(btrim(s."definition"), '') IS NOT NULL AND nullif(btrim(e."definition"), '') IS NOT NULL
    AND btrim(s."definition") <> btrim(e."definition");--> statement-breakpoint
ALTER TABLE "dataset_spec" DROP COLUMN "definition";--> statement-breakpoint

-- Collection method and schedule.
ALTER TABLE "evidence_item" ADD COLUMN "method" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_item" ADD COLUMN "method_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_item" ADD COLUMN "schedule" jsonb;--> statement-breakpoint
ALTER TABLE "evidence_item" ADD COLUMN "next_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "evidence_item" ADD COLUMN "last_run_at" timestamp with time zone;--> statement-breakpoint

-- A dataset whose online form is in use (open, or with responses) is collected by the form.
UPDATE "evidence_item" e SET "method" = 'form'
  WHERE e."type" = 'dataset' AND (
    EXISTS (SELECT 1 FROM "dataset_spec" s WHERE s."evidence_item_id" = e."id" AND s."form_open")
    OR EXISTS (SELECT 1 FROM "dataset_response" r WHERE r."evidence_item_id" = e."id"));--> statement-breakpoint

ALTER TABLE "evidence_item" ADD CONSTRAINT "evidence_item_method_check" CHECK ("evidence_item"."method" in ('manual', 'form', 'request', 'bi', 'survey'));--> statement-breakpoint
ALTER TABLE "evidence_item" ADD CONSTRAINT "evidence_item_method_config_check" CHECK (jsonb_typeof("evidence_item"."method_config") = 'object');--> statement-breakpoint
-- The form is the dataset's online form and spreadsheet template: only a dataset has one.
ALTER TABLE "evidence_item" ADD CONSTRAINT "evidence_item_form_dataset_check" CHECK ("evidence_item"."method" <> 'form' OR "evidence_item"."type" = 'dataset');--> statement-breakpoint
-- A request names one person or one email address; a BI endpoint is a NAME resolved from the server's environment, never an address.
ALTER TABLE "evidence_item" ADD CONSTRAINT "evidence_item_request_check" CHECK ("evidence_item"."method" <> 'request'
  OR (("evidence_item"."method_config" ->> 'assigneeUserId' IS NOT NULL)::int + ("evidence_item"."method_config" ->> 'assigneeEmail' IS NOT NULL)::int = 1));--> statement-breakpoint
ALTER TABLE "evidence_item" ADD CONSTRAINT "evidence_item_bi_check" CHECK ("evidence_item"."method" <> 'bi'
  OR "evidence_item"."method_config" ->> 'endpointKey' IS NULL OR "evidence_item"."method_config" ->> 'endpointKey' ~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$');--> statement-breakpoint
ALTER TABLE "evidence_item" ADD CONSTRAINT "evidence_item_schedule_check" CHECK ("evidence_item"."schedule" IS NULL OR (
  jsonb_typeof("evidence_item"."schedule") = 'object'
  AND "evidence_item"."schedule" ->> 'every' IN ('day', 'week', 'month', 'quarter', 'semester', 'year')
  AND coalesce("evidence_item"."schedule" ->> 'startDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', false)
  AND CASE WHEN jsonb_typeof("evidence_item"."schedule" -> 'dueAfterDays') = 'number'
        THEN ("evidence_item"."schedule" ->> 'dueAfterDays')::numeric BETWEEN 0 AND 3650 ELSE false END
  AND CASE WHEN jsonb_typeof("evidence_item"."schedule" -> 'timezone') = 'string'
        THEN length(btrim("evidence_item"."schedule" ->> 'timezone')) > 0 ELSE false END));--> statement-breakpoint

-- What an item names belongs to its institution: its owner, its owner unit and the person a request goes to.
CREATE FUNCTION evidence_item_checks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  assignee uuid;
BEGIN
  IF NEW.owner_user_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id)
     AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.owner_user_id AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'the owner must be a person of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.owner_unit_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.owner_unit_id IS DISTINCT FROM OLD.owner_unit_id)
     AND NOT EXISTS (SELECT 1 FROM org_unit WHERE id = NEW.owner_unit_id AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'the owner unit must be a unit of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.method = 'request' AND NEW.method_config ->> 'assigneeUserId' IS NOT NULL THEN
    BEGIN
      assignee := (NEW.method_config ->> 'assigneeUserId')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'the person a request goes to must be named by id' USING ERRCODE = 'check_violation';
    END;
    IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = assignee AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'the person a request goes to must be a person of the same institution' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_evidence_item_checks BEFORE INSERT OR UPDATE ON "evidence_item" FOR EACH ROW EXECUTE FUNCTION evidence_item_checks();
