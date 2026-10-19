CREATE TABLE "cycle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"title" text NOT NULL,
	"template_id" uuid,
	"template_version" integer,
	"anchor_kind" text NOT NULL,
	"anchor_id" uuid NOT NULL,
	"subject_kind" text,
	"subject_id" uuid,
	"responsible_unit_id" uuid NOT NULL,
	"lead_user_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"cancel_reason" text,
	"start_date" date NOT NULL,
	"end_date" date,
	"previous_cycle_id" uuid,
	"period_label" text,
	"parent_cycle_id" uuid,
	"parent_stage_id" uuid,
	"origin" text DEFAULT 'manual' NOT NULL,
	CONSTRAINT "cycle_anchor_kind_check" CHECK ("cycle"."anchor_kind" in ('institution', 'org_unit', 'program', 'framework_version', 'requirement', 'evidence_item', 'engagement')),
	CONSTRAINT "cycle_subject_kind_check" CHECK ("cycle"."subject_kind" is null or "cycle"."subject_kind" in ('institution', 'org_unit', 'program')),
	CONSTRAINT "cycle_subject_pair_check" CHECK (("cycle"."subject_kind" is null) = ("cycle"."subject_id" is null)),
	CONSTRAINT "cycle_status_check" CHECK ("cycle"."status" in ('draft', 'active', 'completed', 'cancelled')),
	CONSTRAINT "cycle_origin_check" CHECK ("cycle"."origin" in ('manual', 'assistant')),
	CONSTRAINT "cycle_cancel_reason_check" CHECK ("cycle"."status" <> 'cancelled' or length(trim(coalesce("cycle"."cancel_reason", ''))) > 0),
	CONSTRAINT "cycle_dates_check" CHECK ("cycle"."end_date" is null or "cycle"."end_date" >= "cycle"."start_date"),
	CONSTRAINT "cycle_template_pair_check" CHECK (("cycle"."template_id" is null) = ("cycle"."template_version" is null)),
	CONSTRAINT "cycle_previous_self_check" CHECK ("cycle"."previous_cycle_id" is distinct from "cycle"."id")
);
--> statement-breakpoint
CREATE TABLE "cycle_input" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"output_id" uuid,
	"pick_kind" text,
	"ref_kind" text,
	"ref_id" uuid,
	"required" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "cycle_input_source_check" CHECK ("cycle_input"."source" in ('stage_output', 'previous_cycle', 'pick')),
	CONSTRAINT "cycle_input_key_check" CHECK ("cycle_input"."key" ~ '^[a-z][a-z0-9_]{0,47}$'),
	CONSTRAINT "cycle_input_pick_check" CHECK (("cycle_input"."source" = 'pick' and "cycle_input"."output_id" is null) or ("cycle_input"."source" <> 'pick' and "cycle_input"."ref_kind" is null and "cycle_input"."ref_id" is null and "cycle_input"."pick_kind" is null)),
	CONSTRAINT "cycle_input_ref_pair_check" CHECK (("cycle_input"."ref_kind" is null) = ("cycle_input"."ref_id" is null))
);
--> statement-breakpoint
CREATE TABLE "cycle_output" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'missing' NOT NULL,
	"report_template_key" text,
	"report_id" uuid,
	"file_key" text,
	"file_name" text,
	"file_mime" text,
	"file_size" integer,
	"note" text,
	"approver_user_id" uuid,
	"approver_unresolved" boolean DEFAULT false NOT NULL,
	"decision" text,
	"decision_comment" text,
	"finalised_by" uuid,
	"finalised_at" timestamp with time zone,
	CONSTRAINT "cycle_output_kind_check" CHECK ("cycle_output"."kind" in ('report', 'document', 'approval', 'note')),
	CONSTRAINT "cycle_output_state_check" CHECK ("cycle_output"."state" in ('missing', 'draft', 'final')),
	CONSTRAINT "cycle_output_key_check" CHECK ("cycle_output"."key" ~ '^[a-z][a-z0-9_]{0,47}$'),
	CONSTRAINT "cycle_output_decision_check" CHECK ("cycle_output"."decision" is null or "cycle_output"."decision" in ('approved', 'approved_with_conditions', 'returned')),
	CONSTRAINT "cycle_output_decision_kind_check" CHECK (("cycle_output"."decision" is null and "cycle_output"."decision_comment" is null) or "cycle_output"."kind" = 'approval'),
	CONSTRAINT "cycle_output_approver_kind_check" CHECK (("cycle_output"."approver_user_id" is null and not "cycle_output"."approver_unresolved") or "cycle_output"."kind" = 'approval'),
	CONSTRAINT "cycle_output_comment_check" CHECK ("cycle_output"."decision" is null or "cycle_output"."decision" = 'approved' or length(trim(coalesce("cycle_output"."decision_comment", ''))) > 0),
	CONSTRAINT "cycle_output_file_kind_check" CHECK ("cycle_output"."file_key" is null or "cycle_output"."kind" = 'document'),
	CONSTRAINT "cycle_output_note_kind_check" CHECK ("cycle_output"."note" is null or "cycle_output"."kind" = 'note'),
	CONSTRAINT "cycle_output_report_kind_check" CHECK (("cycle_output"."report_template_key" is null and "cycle_output"."report_id" is null) or "cycle_output"."kind" = 'report'),
	CONSTRAINT "cycle_output_final_check" CHECK ("cycle_output"."state" <> 'final' or case "cycle_output"."kind"
    when 'document' then "cycle_output"."file_key" is not null
    when 'note' then length(trim(coalesce("cycle_output"."note", ''))) > 0
    when 'approval' then "cycle_output"."decision" in ('approved', 'approved_with_conditions')
    else true end)
);
--> statement-breakpoint
CREATE TABLE "cycle_stage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"process" text DEFAULT '' NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"responsible_unit_id" uuid NOT NULL,
	"unit_unresolved" boolean DEFAULT false NOT NULL,
	"owner_user_id" uuid,
	"owner_unresolved" boolean DEFAULT false NOT NULL,
	"start_date" date,
	"end_date" date,
	"status" text DEFAULT 'not_started' NOT NULL,
	"skip_reason" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "cycle_stage_status_check" CHECK ("cycle_stage"."status" in ('not_started', 'in_progress', 'completed', 'skipped')),
	CONSTRAINT "cycle_stage_key_check" CHECK ("cycle_stage"."key" ~ '^[a-z][a-z0-9_]{0,47}$'),
	CONSTRAINT "cycle_stage_skip_reason_check" CHECK ("cycle_stage"."status" <> 'skipped' or length(trim(coalesce("cycle_stage"."skip_reason", ''))) > 0),
	CONSTRAINT "cycle_stage_dates_check" CHECK ("cycle_stage"."start_date" is null or "cycle_stage"."end_date" is null or "cycle_stage"."end_date" >= "cycle_stage"."start_date"),
	CONSTRAINT "cycle_stage_checklist_check" CHECK (jsonb_typeof("cycle_stage"."checklist") = 'array')
);
--> statement-breakpoint
CREATE TABLE "cycle_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"description" text,
	"anchor_kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	CONSTRAINT "cycle_template_key_check" CHECK ("cycle_template"."key" ~ '^[a-z][a-z0-9_]{0,47}$'),
	CONSTRAINT "cycle_template_status_check" CHECK ("cycle_template"."status" in ('draft', 'published', 'retired')),
	CONSTRAINT "cycle_template_origin_check" CHECK ("cycle_template"."origin" in ('default', 'manual', 'import')),
	CONSTRAINT "cycle_template_stages_check" CHECK (jsonb_typeof("cycle_template"."stages") = 'array'),
	CONSTRAINT "cycle_template_anchor_kinds_check" CHECK ("cycle_template"."anchor_kinds" <@ array['institution', 'org_unit', 'program', 'framework_version', 'requirement', 'evidence_item', 'engagement']::text[]),
	CONSTRAINT "cycle_template_version_check" CHECK ("cycle_template"."version" >= 0 and ("cycle_template"."status" = 'draft' or "cycle_template"."version" >= 1))
);
--> statement-breakpoint
ALTER TABLE "trash_item" DROP CONSTRAINT "trash_item_kind_check";
--> statement-breakpoint
ALTER TABLE "cycle" ADD CONSTRAINT "cycle_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle" ADD CONSTRAINT "cycle_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle" ADD CONSTRAINT "cycle_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle" ADD CONSTRAINT "cycle_template_id_cycle_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."cycle_template"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle" ADD CONSTRAINT "cycle_responsible_unit_id_org_unit_id_fk" FOREIGN KEY ("responsible_unit_id") REFERENCES "public"."org_unit"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle" ADD CONSTRAINT "cycle_lead_user_id_app_user_id_fk" FOREIGN KEY ("lead_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle" ADD CONSTRAINT "cycle_previous_cycle_id_cycle_id_fk" FOREIGN KEY ("previous_cycle_id") REFERENCES "public"."cycle"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle" ADD CONSTRAINT "cycle_parent_cycle_id_cycle_id_fk" FOREIGN KEY ("parent_cycle_id") REFERENCES "public"."cycle"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle" ADD CONSTRAINT "cycle_parent_stage_id_cycle_stage_id_fk" FOREIGN KEY ("parent_stage_id") REFERENCES "public"."cycle_stage"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_input" ADD CONSTRAINT "cycle_input_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_input" ADD CONSTRAINT "cycle_input_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_input" ADD CONSTRAINT "cycle_input_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_input" ADD CONSTRAINT "cycle_input_stage_id_cycle_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."cycle_stage"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_input" ADD CONSTRAINT "cycle_input_output_id_cycle_output_id_fk" FOREIGN KEY ("output_id") REFERENCES "public"."cycle_output"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_output" ADD CONSTRAINT "cycle_output_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_output" ADD CONSTRAINT "cycle_output_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_output" ADD CONSTRAINT "cycle_output_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_output" ADD CONSTRAINT "cycle_output_stage_id_cycle_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."cycle_stage"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_output" ADD CONSTRAINT "cycle_output_approver_user_id_app_user_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_output" ADD CONSTRAINT "cycle_output_finalised_by_app_user_id_fk" FOREIGN KEY ("finalised_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_stage" ADD CONSTRAINT "cycle_stage_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_stage" ADD CONSTRAINT "cycle_stage_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_stage" ADD CONSTRAINT "cycle_stage_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_stage" ADD CONSTRAINT "cycle_stage_cycle_id_cycle_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycle"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_stage" ADD CONSTRAINT "cycle_stage_responsible_unit_id_org_unit_id_fk" FOREIGN KEY ("responsible_unit_id") REFERENCES "public"."org_unit"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_stage" ADD CONSTRAINT "cycle_stage_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_template" ADD CONSTRAINT "cycle_template_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_template" ADD CONSTRAINT "cycle_template_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cycle_template" ADD CONSTRAINT "cycle_template_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cycle_anchor_idx" ON "cycle" USING btree ("institution_id","anchor_kind","anchor_id");
--> statement-breakpoint
CREATE INDEX "cycle_subject_idx" ON "cycle" USING btree ("institution_id","subject_kind","subject_id");
--> statement-breakpoint
CREATE INDEX "cycle_unit_idx" ON "cycle" USING btree ("responsible_unit_id");
--> statement-breakpoint
CREATE INDEX "cycle_lead_idx" ON "cycle" USING btree ("lead_user_id");
--> statement-breakpoint
CREATE INDEX "cycle_template_idx" ON "cycle" USING btree ("template_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "cycle_input_key_idx" ON "cycle_input" USING btree ("stage_id","key");
--> statement-breakpoint
CREATE INDEX "cycle_input_output_idx" ON "cycle_input" USING btree ("output_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "cycle_output_key_idx" ON "cycle_output" USING btree ("stage_id","key");
--> statement-breakpoint
CREATE INDEX "cycle_output_approver_idx" ON "cycle_output" USING btree ("approver_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "cycle_stage_key_idx" ON "cycle_stage" USING btree ("cycle_id","key");
--> statement-breakpoint
CREATE INDEX "cycle_stage_order_idx" ON "cycle_stage" USING btree ("cycle_id","display_order");
--> statement-breakpoint
CREATE INDEX "cycle_stage_owner_idx" ON "cycle_stage" USING btree ("owner_user_id");
--> statement-breakpoint
CREATE INDEX "cycle_stage_unit_idx" ON "cycle_stage" USING btree ("responsible_unit_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "cycle_template_key_idx" ON "cycle_template" USING btree ("institution_id","key");
--> statement-breakpoint
ALTER TABLE "trash_item" ADD CONSTRAINT "trash_item_kind_check" CHECK ("trash_item"."kind" in ('requirement', 'note', 'source_document', 'source_page', 'report_template', 'framework_version', 'framework', 'mapping', 'evidence_link', 'milestone', 'import_document', 'org_unit', 'cycle'));
--> statement-breakpoint

-- QUALITY MANAGEMENT CYCLES (TASK-078, DEC-029, docs/quality-management-plan.md).
--
-- Five tables: cycle_template (a reusable shape), cycle (one run, about an anchor, with a responsible unit and an owner), cycle_stage,
-- cycle_output (a slot a stage fills) and cycle_input (what a stage reads). Tenant RLS and the audit trigger as everywhere. The
-- application role writes them; the worker role may only read (nothing in the background changes a cycle, DEC-006).
--
-- The rules that must hold whatever the code does are triggers here:
--   * a cycle moves draft -> active -> completed, or is cancelled with a reason; it completes only when every stage is completed or
--     skipped; it goes back to draft only while nothing has started; its anchor, template and previous run never change;
--   * stages, outputs and inputs are added and removed only while the cycle is a draft (the shape is fixed once it starts); a
--     completed or cancelled cycle no longer changes; a draft is the only thing that can be deleted (to the Trash);
--   * a stage moves not_started -> in_progress -> completed (or skipped with a reason) and back by reopening; it is completed only
--     when every required output is final; its outputs are filled only while it is in progress;
--   * an approval is decided only by the named approver; a final output does not change (reopen it first); who finalised it and
--     when are stamped here, not trusted from the caller;
--   * every person and unit a row names belongs to the same institution (a foreign key does not see the tenant).
ALTER TABLE cycle_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cycle ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cycle_stage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cycle_output ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cycle_input ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON cycle_template USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY tenant ON cycle USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY tenant ON cycle_stage USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY tenant ON cycle_output USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY tenant ON cycle_input USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON cycle_template, cycle, cycle_stage, cycle_output, cycle_input TO ams_app;--> statement-breakpoint
GRANT SELECT ON cycle_template, cycle, cycle_stage, cycle_output, cycle_input TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON cycle_template FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON cycle FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON cycle_stage FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON cycle_output FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON cycle_input FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON cycle_template FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON cycle FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON cycle_stage FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON cycle_output FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON cycle_input FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint

-- Everything a row names belongs to the same institution.
CREATE FUNCTION cycle_refs_same_institution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'cycle' THEN
    IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.lead_user_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'the owner of a cycle must be a person of the same institution' USING ERRCODE = 'check_violation'; END IF;
    IF NOT EXISTS (SELECT 1 FROM org_unit WHERE id = NEW.responsible_unit_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'the responsible unit of a cycle must be a unit of the same institution' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cycle_template WHERE id = NEW.template_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'the template of a cycle must be one of the same institution' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.previous_cycle_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cycle WHERE id = NEW.previous_cycle_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'the previous cycle must be one of the same institution' USING ERRCODE = 'check_violation'; END IF;
  ELSIF TG_TABLE_NAME = 'cycle_stage' THEN
    IF NOT EXISTS (SELECT 1 FROM cycle WHERE id = NEW.cycle_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'a stage belongs to a cycle of the same institution' USING ERRCODE = 'check_violation'; END IF;
    IF NOT EXISTS (SELECT 1 FROM org_unit WHERE id = NEW.responsible_unit_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'the responsible unit of a stage must be a unit of the same institution' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.owner_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.owner_user_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'the owner of a stage must be a person of the same institution' USING ERRCODE = 'check_violation'; END IF;
  ELSIF TG_TABLE_NAME = 'cycle_output' THEN
    IF NOT EXISTS (SELECT 1 FROM cycle_stage WHERE id = NEW.stage_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'an output belongs to a stage of the same institution' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.approver_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.approver_user_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'the approver must be a person of the same institution' USING ERRCODE = 'check_violation'; END IF;
  ELSIF TG_TABLE_NAME = 'cycle_input' THEN
    IF NOT EXISTS (SELECT 1 FROM cycle_stage WHERE id = NEW.stage_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'an input belongs to a stage of the same institution' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.output_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cycle_output WHERE id = NEW.output_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'an input reads an output of the same institution' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_refs_same_institution BEFORE INSERT OR UPDATE ON cycle FOR EACH ROW EXECUTE FUNCTION cycle_refs_same_institution();--> statement-breakpoint
CREATE TRIGGER a_refs_same_institution BEFORE INSERT OR UPDATE ON cycle_stage FOR EACH ROW EXECUTE FUNCTION cycle_refs_same_institution();--> statement-breakpoint
CREATE TRIGGER a_refs_same_institution BEFORE INSERT OR UPDATE ON cycle_output FOR EACH ROW EXECUTE FUNCTION cycle_refs_same_institution();--> statement-breakpoint
CREATE TRIGGER a_refs_same_institution BEFORE INSERT OR UPDATE ON cycle_input FOR EACH ROW EXECUTE FUNCTION cycle_refs_same_institution();--> statement-breakpoint

-- The cycle: status moves, completion, what never changes, delete only as a draft.
CREATE FUNCTION cycle_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only a draft cycle can be deleted; cancel a cycle that has started' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a cycle starts as a draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.anchor_kind <> OLD.anchor_kind OR NEW.anchor_id <> OLD.anchor_id OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.template_version IS DISTINCT FROM OLD.template_version OR NEW.previous_cycle_id IS DISTINCT FROM OLD.previous_cycle_id THEN
    RAISE EXCEPTION 'the anchor, the template and the previous cycle of a cycle never change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'a cancelled cycle cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status IN ('active', 'cancelled'))
         OR (OLD.status = 'active' AND NEW.status IN ('draft', 'completed', 'cancelled'))
         OR (OLD.status = 'completed' AND NEW.status IN ('active', 'cancelled'))) THEN
      RAISE EXCEPTION 'a cycle cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO n FROM cycle_stage WHERE cycle_id = NEW.id;
    IF NEW.status = 'active' AND OLD.status = 'draft' AND n = 0 THEN
      RAISE EXCEPTION 'a cycle needs at least one stage before it can start' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'completed' THEN
      IF n = 0 OR EXISTS (SELECT 1 FROM cycle_stage WHERE cycle_id = NEW.id AND status IN ('not_started', 'in_progress')) THEN
        RAISE EXCEPTION 'a cycle is completed only when every stage is completed or skipped' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.status = 'draft' THEN
      IF EXISTS (SELECT 1 FROM cycle_stage WHERE cycle_id = NEW.id AND status <> 'not_started') THEN
        RAISE EXCEPTION 'a cycle goes back to draft only while no stage has started' USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM cycle WHERE previous_cycle_id = NEW.id OR parent_cycle_id = NEW.id) THEN
        RAISE EXCEPTION 'another cycle builds on this one, so it cannot go back to draft' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER b_rules BEFORE INSERT OR UPDATE OR DELETE ON cycle FOR EACH ROW EXECUTE FUNCTION cycle_rules();--> statement-breakpoint

-- The stage: added and removed only in a draft; status moves; completed only when the required outputs are final.
CREATE FUNCTION cycle_stage_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cyc text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO cyc FROM cycle WHERE id = OLD.cycle_id;
    IF cyc IS NOT NULL AND cyc <> 'draft' THEN
      RAISE EXCEPTION 'stages can be removed only while the cycle is a draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  SELECT status INTO cyc FROM cycle WHERE id = NEW.cycle_id;
  IF TG_OP = 'INSERT' THEN
    IF cyc <> 'draft' THEN
      RAISE EXCEPTION 'stages can be added only while the cycle is a draft' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'not_started' THEN
      RAISE EXCEPTION 'a stage starts as not started' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.cycle_id <> OLD.cycle_id OR NEW.key <> OLD.key THEN
    RAISE EXCEPTION 'the cycle and the key of a stage never change' USING ERRCODE = 'check_violation';
  END IF;
  IF cyc IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'the cycle is %; its stages can no longer change', cyc USING ERRCODE = 'check_violation';
  END IF;
  IF cyc <> 'draft' AND NEW.display_order <> OLD.display_order THEN
    RAISE EXCEPTION 'the order of stages is fixed once the cycle has started' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF cyc <> 'active' THEN
      RAISE EXCEPTION 'a stage moves only while the cycle is active' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ((OLD.status = 'not_started' AND NEW.status IN ('in_progress', 'skipped'))
         OR (OLD.status = 'in_progress' AND NEW.status IN ('completed', 'skipped', 'not_started'))
         OR (OLD.status = 'completed' AND NEW.status = 'in_progress')
         OR (OLD.status = 'skipped' AND NEW.status = 'not_started')) THEN
      RAISE EXCEPTION 'a stage cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'completed' AND EXISTS (SELECT 1 FROM cycle_output WHERE stage_id = NEW.id AND required AND state <> 'final') THEN
      RAISE EXCEPTION 'a stage is completed only when every required output is final' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'in_progress' AND NEW.started_at IS NULL THEN NEW.started_at := now(); END IF;
    IF NEW.status = 'not_started' THEN NEW.started_at := NULL; END IF;
    IF NEW.status = 'completed' THEN NEW.completed_at := now(); ELSE NEW.completed_at := NULL; END IF;
    IF NEW.status <> 'skipped' THEN NEW.skip_reason := NULL; END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER b_rules BEFORE INSERT OR UPDATE OR DELETE ON cycle_stage FOR EACH ROW EXECUTE FUNCTION cycle_stage_rules();--> statement-breakpoint

-- The output: shape fixed after the draft; filled only while its stage is in progress; a final output does not change; an
-- approval is decided only by the named approver; who finalised it and when are stamped here.
CREATE FUNCTION cycle_output_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cyc text; stg text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT c.status INTO cyc FROM cycle_stage s JOIN cycle c ON c.id = s.cycle_id WHERE s.id = OLD.stage_id;
    IF cyc IS NOT NULL AND cyc <> 'draft' THEN
      RAISE EXCEPTION 'outputs can be removed only while the cycle is a draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  SELECT c.status, s.status INTO cyc, stg FROM cycle_stage s JOIN cycle c ON c.id = s.cycle_id WHERE s.id = NEW.stage_id;
  IF TG_OP = 'INSERT' THEN
    IF cyc <> 'draft' THEN
      RAISE EXCEPTION 'outputs can be added only while the cycle is a draft' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state <> 'missing' OR NEW.decision IS NOT NULL OR NEW.finalised_by IS NOT NULL THEN
      RAISE EXCEPTION 'an output starts empty' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.stage_id <> OLD.stage_id OR NEW.key <> OLD.key OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'the stage, the key and the kind of an output never change' USING ERRCODE = 'check_violation';
  END IF;
  IF cyc IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'the cycle is %; its outputs can no longer change', cyc USING ERRCODE = 'check_violation';
  END IF;
  IF cyc <> 'draft' AND (NEW.required <> OLD.required OR NEW.name <> OLD.name OR NEW.report_template_key IS DISTINCT FROM OLD.report_template_key) THEN
    RAISE EXCEPTION 'the shape of an output is fixed once the cycle has started' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'final' AND NEW.approver_user_id IS DISTINCT FROM OLD.approver_user_id THEN
    RAISE EXCEPTION 'a signed-off approval cannot change its approver' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.state, NEW.note, NEW.file_key, NEW.file_name, NEW.file_mime, NEW.file_size, NEW.report_id, NEW.decision, NEW.decision_comment)
     IS DISTINCT FROM (OLD.state, OLD.note, OLD.file_key, OLD.file_name, OLD.file_mime, OLD.file_size, OLD.report_id, OLD.decision, OLD.decision_comment) THEN
    IF stg <> 'in_progress' THEN
      RAISE EXCEPTION 'start the stage before filling its outputs' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.state = 'final' AND NEW.state = 'final' THEN
      RAISE EXCEPTION 'a final output cannot change; reopen it first' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.decision IS DISTINCT FROM OLD.decision OR NEW.decision_comment IS DISTINCT FROM OLD.decision_comment THEN
      IF NEW.approver_user_id IS NULL OR app_user_id() IS DISTINCT FROM NEW.approver_user_id THEN
        RAISE EXCEPTION 'only the named approver can decide an approval' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.state = 'final' THEN
      NEW.finalised_by := app_user_id();
      NEW.finalised_at := now();
    ELSE
      NEW.finalised_by := NULL;
      NEW.finalised_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER b_rules BEFORE INSERT OR UPDATE OR DELETE ON cycle_output FOR EACH ROW EXECUTE FUNCTION cycle_output_rules();--> statement-breakpoint

-- The input: added and removed only in a draft; its wiring is fixed after that (only a pick can be filled).
CREATE FUNCTION cycle_input_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cyc text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT c.status INTO cyc FROM cycle_stage s JOIN cycle c ON c.id = s.cycle_id WHERE s.id = OLD.stage_id;
    IF cyc IS NOT NULL AND cyc <> 'draft' THEN
      RAISE EXCEPTION 'inputs can be removed only while the cycle is a draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  SELECT c.status INTO cyc FROM cycle_stage s JOIN cycle c ON c.id = s.cycle_id WHERE s.id = NEW.stage_id;
  IF TG_OP = 'INSERT' THEN
    IF cyc <> 'draft' THEN
      RAISE EXCEPTION 'inputs can be added only while the cycle is a draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.stage_id <> OLD.stage_id OR NEW.key <> OLD.key OR NEW.source <> OLD.source THEN
    RAISE EXCEPTION 'the stage, the key and the source of an input never change' USING ERRCODE = 'check_violation';
  END IF;
  IF cyc IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'the cycle is %; its inputs can no longer change', cyc USING ERRCODE = 'check_violation';
  END IF;
  IF cyc <> 'draft' AND (NEW.output_id IS DISTINCT FROM OLD.output_id OR NEW.required <> OLD.required OR NEW.pick_kind IS DISTINCT FROM OLD.pick_kind) THEN
    RAISE EXCEPTION 'the wiring of an input is fixed once the cycle has started' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER b_rules BEFORE INSERT OR UPDATE OR DELETE ON cycle_input FOR EACH ROW EXECUTE FUNCTION cycle_input_rules();--> statement-breakpoint

-- A template is published once it has a version; its key never changes; a published one does not change until it is revised.
CREATE FUNCTION cycle_template_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR OLD.version > 0 THEN
      RAISE EXCEPTION 'only a template that was never published can be deleted; retire it instead' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.key <> OLD.key THEN
    RAISE EXCEPTION 'the key of a template never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'the version of a template never goes down' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'retired' THEN
    RAISE EXCEPTION 'a draft is published before it is retired' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IN ('published', 'retired') AND OLD.status IN ('published', 'retired')
     AND (NEW.stages IS DISTINCT FROM OLD.stages OR NEW.anchor_kinds IS DISTINCT FROM OLD.anchor_kinds) THEN
    RAISE EXCEPTION 'a published template does not change; revise it into a draft first' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER b_rules BEFORE UPDATE OR DELETE ON cycle_template FOR EACH ROW EXECUTE FUNCTION cycle_template_rules();
