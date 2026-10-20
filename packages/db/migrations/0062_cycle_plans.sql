-- ACADEMIC CALENDAR AND CYCLE PLANS (TASK-081, docs/quality-management-plan.md "Worked examples", DEC-029).
--
--   academic_term     the institution's years and terms (Settings -> Organization -> Institution -> Academic calendar); active ones of a
--                     kind never overlap;
--   cycle_plan        a template and a recurrence attached to an anchor (institution, unit, program, a whole standard, a requirement,
--                     an evidence item). Outside the immutable framework tables, so it works on published versions. A requirement is
--                     named by (framework_id, code) like scope and champion, so a plan carries over to the next version;
--   cycle_plan_skip   "Skip this period": a run a person chose not to launch, with the reason, so it is not proposed again;
--   cycle.plan_id / cycle.period_start   the plan that produced a run and the start of the period it covers.
-- Plans only PROPOSE runs (DEC-029); the worker may read them and never write.
CREATE TABLE "academic_term" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"kind" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "academic_term_kind_check" CHECK ("academic_term"."kind" in ('term', 'year')),
	CONSTRAINT "academic_term_dates_check" CHECK ("academic_term"."end_date" >= "academic_term"."start_date"),
	CONSTRAINT "academic_term_name_check" CHECK (length(trim("academic_term"."name")) > 0)
);--> statement-breakpoint
CREATE TABLE "cycle_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"anchor_kind" text NOT NULL,
	"anchor_id" uuid,
	"anchor_framework_id" uuid,
	"anchor_code" text,
	"template_id" uuid NOT NULL,
	"responsible_unit_id" uuid,
	"owner_user_id" uuid,
	"recurrence" jsonb,
	"first_start" date,
	"applies_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mode" text DEFAULT 'own' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "cycle_plan_anchor_kind_check" CHECK ("cycle_plan"."anchor_kind" in ('institution', 'org_unit', 'program', 'framework', 'requirement', 'evidence_item')),
	CONSTRAINT "cycle_plan_mode_check" CHECK ("cycle_plan"."mode" in ('own', 'opt_out')),
	CONSTRAINT "cycle_plan_anchor_check" CHECK (
		("cycle_plan"."anchor_kind" = 'requirement' and "cycle_plan"."anchor_id" is null and "cycle_plan"."anchor_framework_id" is not null and "cycle_plan"."anchor_code" is not null)
		or ("cycle_plan"."anchor_kind" = 'framework' and "cycle_plan"."anchor_id" is null and "cycle_plan"."anchor_framework_id" is not null and "cycle_plan"."anchor_code" is null)
		or ("cycle_plan"."anchor_kind" not in ('requirement', 'framework') and "cycle_plan"."anchor_id" is not null and "cycle_plan"."anchor_framework_id" is null and "cycle_plan"."anchor_code" is null)),
	CONSTRAINT "cycle_plan_own_check" CHECK ("cycle_plan"."mode" = 'opt_out' or ("cycle_plan"."recurrence" is not null and "cycle_plan"."first_start" is not null))
);--> statement-breakpoint
CREATE TABLE "cycle_plan_skip" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"subject_kind" text,
	"subject_id" uuid,
	"period_start" date NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "cycle_plan_skip_subject_kind_check" CHECK ("cycle_plan_skip"."subject_kind" is null or "cycle_plan_skip"."subject_kind" in ('institution', 'org_unit', 'program')),
	CONSTRAINT "cycle_plan_skip_subject_pair_check" CHECK (("cycle_plan_skip"."subject_kind" is null) = ("cycle_plan_skip"."subject_id" is null)),
	CONSTRAINT "cycle_plan_skip_reason_check" CHECK (length(trim("cycle_plan_skip"."reason")) > 0)
);--> statement-breakpoint
ALTER TABLE "cycle" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "cycle" ADD COLUMN "period_start" date;--> statement-breakpoint
ALTER TABLE "academic_term" ADD CONSTRAINT "academic_term_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_term" ADD CONSTRAINT "academic_term_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_term" ADD CONSTRAINT "academic_term_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_plan" ADD CONSTRAINT "cycle_plan_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_plan" ADD CONSTRAINT "cycle_plan_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_plan" ADD CONSTRAINT "cycle_plan_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_plan" ADD CONSTRAINT "cycle_plan_anchor_framework_id_framework_id_fk" FOREIGN KEY ("anchor_framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_plan" ADD CONSTRAINT "cycle_plan_template_id_cycle_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."cycle_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_plan" ADD CONSTRAINT "cycle_plan_responsible_unit_id_org_unit_id_fk" FOREIGN KEY ("responsible_unit_id") REFERENCES "public"."org_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_plan" ADD CONSTRAINT "cycle_plan_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_plan_skip" ADD CONSTRAINT "cycle_plan_skip_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_plan_skip" ADD CONSTRAINT "cycle_plan_skip_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_plan_skip" ADD CONSTRAINT "cycle_plan_skip_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_plan_skip" ADD CONSTRAINT "cycle_plan_skip_plan_id_cycle_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."cycle_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle" ADD CONSTRAINT "cycle_plan_id_cycle_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."cycle_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle" ADD CONSTRAINT "cycle_plan_period_check" CHECK ("cycle"."plan_id" is null or "cycle"."period_start" is not null);--> statement-breakpoint
CREATE INDEX "academic_term_idx" ON "academic_term" USING btree ("institution_id","kind","start_date");--> statement-breakpoint
-- One plan (or opt-out) per anchor and template; the same standard can have several plans with different templates.
CREATE UNIQUE INDEX "cycle_plan_anchor_idx" ON "cycle_plan" USING btree ("institution_id","anchor_kind",coalesce("anchor_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("anchor_framework_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("anchor_code", ''),"template_id");--> statement-breakpoint
CREATE INDEX "cycle_plan_framework_idx" ON "cycle_plan" USING btree ("anchor_framework_id","anchor_code");--> statement-breakpoint
CREATE INDEX "cycle_plan_template_idx" ON "cycle_plan" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cycle_plan_skip_idx" ON "cycle_plan_skip" USING btree ("plan_id",coalesce("subject_kind", ''),coalesce("subject_id", '00000000-0000-0000-0000-000000000000'::uuid),"period_start");--> statement-breakpoint
CREATE INDEX "cycle_plan_run_idx" ON "cycle" USING btree ("plan_id","period_start");--> statement-breakpoint

ALTER TABLE academic_term ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cycle_plan ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cycle_plan_skip ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON academic_term USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY tenant ON cycle_plan USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY tenant ON cycle_plan_skip USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON academic_term, cycle_plan, cycle_plan_skip TO ams_app;--> statement-breakpoint
GRANT SELECT ON academic_term, cycle_plan, cycle_plan_skip TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON academic_term FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON cycle_plan FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON cycle_plan_skip FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON academic_term FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON cycle_plan FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON cycle_plan_skip FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint

-- Active terms (and active years) of an institution never overlap: a date belongs to one term and one year.
CREATE FUNCTION academic_term_checks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active AND EXISTS (
    SELECT 1 FROM academic_term t WHERE t.institution_id = NEW.institution_id AND t.kind = NEW.kind AND t.active AND t.id <> NEW.id
      AND t.start_date <= NEW.end_date AND NEW.start_date <= t.end_date) THEN
    RAISE EXCEPTION 'this % overlaps another one in the academic calendar', NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_no_overlap BEFORE INSERT OR UPDATE ON academic_term FOR EACH ROW EXECUTE FUNCTION academic_term_checks();--> statement-breakpoint

-- Everything a plan names belongs to the same institution: the template, the unit and owner, the anchor (per kind) and the
-- units and programs of an explicit "applies to" list. A run's plan belongs to the run's institution as well.
CREATE FUNCTION cycle_plan_checks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inst uuid := NEW.institution_id;
  ids uuid[];
BEGIN
  IF TG_TABLE_NAME = 'cycle_plan_skip' THEN
    IF NOT EXISTS (SELECT 1 FROM cycle_plan WHERE id = NEW.plan_id AND institution_id = inst) THEN
      RAISE EXCEPTION 'the plan must be one of the same institution' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cycle_template WHERE id = NEW.template_id AND institution_id = inst) THEN
    RAISE EXCEPTION 'the template must be one of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.responsible_unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM org_unit WHERE id = NEW.responsible_unit_id AND institution_id = inst) THEN
    RAISE EXCEPTION 'the responsible unit must be a unit of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.owner_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.owner_user_id AND institution_id = inst) THEN
    RAISE EXCEPTION 'the owner must be a person of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.anchor_framework_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM framework WHERE id = NEW.anchor_framework_id AND institution_id = inst) THEN
    RAISE EXCEPTION 'the standard must be one of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.anchor_kind = 'institution' AND NEW.anchor_id <> inst THEN
    RAISE EXCEPTION 'the anchor must be the institution itself' USING ERRCODE = 'check_violation';
  ELSIF NEW.anchor_kind = 'org_unit' AND NOT EXISTS (SELECT 1 FROM org_unit WHERE id = NEW.anchor_id AND institution_id = inst) THEN
    RAISE EXCEPTION 'the anchor must be a unit of the same institution' USING ERRCODE = 'check_violation';
  ELSIF NEW.anchor_kind = 'program' AND NOT EXISTS (SELECT 1 FROM program WHERE id = NEW.anchor_id AND institution_id = inst) THEN
    RAISE EXCEPTION 'the anchor must be a program of the same institution' USING ERRCODE = 'check_violation';
  ELSIF NEW.anchor_kind = 'evidence_item' AND NOT EXISTS (SELECT 1 FROM evidence_item WHERE id = NEW.anchor_id AND institution_id = inst) THEN
    RAISE EXCEPTION 'the anchor must be an evidence item of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW.applies_to -> 'ids') = 'array' THEN
    SELECT array_agg(x::uuid) INTO ids FROM jsonb_array_elements_text(NEW.applies_to -> 'ids') AS x;
    IF ids IS NOT NULL AND EXISTS (
      SELECT 1 FROM unnest(ids) AS i(id)
      WHERE NOT EXISTS (SELECT 1 FROM org_unit u WHERE u.id = i.id AND u.institution_id = inst)
        AND NOT EXISTS (SELECT 1 FROM program p WHERE p.id = i.id AND p.institution_id = inst)) THEN
      RAISE EXCEPTION 'a plan can apply only to units and programs of the same institution' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_same_institution BEFORE INSERT OR UPDATE ON cycle_plan FOR EACH ROW EXECUTE FUNCTION cycle_plan_checks();--> statement-breakpoint
CREATE TRIGGER a_same_institution BEFORE INSERT OR UPDATE ON cycle_plan_skip FOR EACH ROW EXECUTE FUNCTION cycle_plan_checks();--> statement-breakpoint
CREATE FUNCTION cycle_plan_run_checks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cycle_plan WHERE id = NEW.plan_id AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'the plan must be one of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER b_plan_same_institution BEFORE INSERT OR UPDATE OF plan_id ON cycle FOR EACH ROW EXECUTE FUNCTION cycle_plan_run_checks();
