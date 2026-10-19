-- SCOPE AND CHAMPION OF A STANDARD (TASK-086, docs/quality-management-plan.md "Standards in operation", DEC-029).
--
-- Three tables that sit OUTSIDE the immutable framework tables, so they can change on a published version:
--   scope_level          the short list of levels a scope can be at (Institution, Unit, Program, Course, plus custom ones);
--   requirement_scope    where a requirement applies: a level and, optionally, a list of items at that level (empty = all);
--   requirement_champion who answers for a requirement: overall (no scope item) or for one scoped item.
-- A requirement is named by (framework_id, code), like requirement_mapping and evidence_link, so a scope or champion carries
-- over to the next version of the standard without being copied. Resolution (own, else the parent's, else through mappings)
-- lives in packages/core/src/scope; these tables hold only what a person set.
CREATE TABLE "scope_level" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text,
	"kind" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "scope_level_key_check" CHECK ("scope_level"."key" ~ '^[a-z][a-z0-9_]{0,47}$'),
	CONSTRAINT "scope_level_kind_check" CHECK ("scope_level"."kind" in ('institution', 'org_unit', 'program', 'course', 'custom'))
);--> statement-breakpoint
CREATE TABLE "requirement_scope" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"framework_id" uuid NOT NULL,
	"code" text NOT NULL,
	"level_key" text NOT NULL,
	"item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL
);--> statement-breakpoint
CREATE TABLE "requirement_champion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"framework_id" uuid NOT NULL,
	"code" text NOT NULL,
	"scope_item_kind" text,
	"scope_item_id" uuid,
	"user_id" uuid NOT NULL,
	CONSTRAINT "requirement_champion_item_kind_check" CHECK ("requirement_champion"."scope_item_kind" is null or "requirement_champion"."scope_item_kind" in ('org_unit', 'program')),
	CONSTRAINT "requirement_champion_item_check" CHECK (("requirement_champion"."scope_item_kind" is null) = ("requirement_champion"."scope_item_id" is null))
);--> statement-breakpoint
ALTER TABLE "scope_level" ADD CONSTRAINT "scope_level_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_level" ADD CONSTRAINT "scope_level_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_level" ADD CONSTRAINT "scope_level_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_scope" ADD CONSTRAINT "requirement_scope_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_scope" ADD CONSTRAINT "requirement_scope_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_scope" ADD CONSTRAINT "requirement_scope_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_scope" ADD CONSTRAINT "requirement_scope_framework_id_framework_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_champion" ADD CONSTRAINT "requirement_champion_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_champion" ADD CONSTRAINT "requirement_champion_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_champion" ADD CONSTRAINT "requirement_champion_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_champion" ADD CONSTRAINT "requirement_champion_framework_id_framework_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."framework"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_champion" ADD CONSTRAINT "requirement_champion_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scope_level_key_idx" ON "scope_level" USING btree ("institution_id","key");--> statement-breakpoint
-- A scope names a level of the same institution (levels are deactivated, never deleted, so one in use stays).
ALTER TABLE "requirement_scope" ADD CONSTRAINT "requirement_scope_level_fk" FOREIGN KEY ("institution_id","level_key") REFERENCES "public"."scope_level"("institution_id","key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_scope_unique_idx" ON "requirement_scope" USING btree ("institution_id","framework_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_champion_unique_idx" ON "requirement_champion" USING btree ("institution_id","framework_id","code",coalesce("scope_item_kind", ''),coalesce("scope_item_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "requirement_champion_framework_idx" ON "requirement_champion" USING btree ("framework_id","code");--> statement-breakpoint
CREATE INDEX "requirement_champion_user_idx" ON "requirement_champion" USING btree ("user_id");--> statement-breakpoint

-- Tenant isolation, the stamp and audit triggers, as on every table. The worker may read, never write: AI does not assign.
ALTER TABLE scope_level ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE requirement_scope ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE requirement_champion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON scope_level USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY tenant ON requirement_scope USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY tenant ON requirement_champion USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON scope_level, requirement_scope, requirement_champion TO ams_app;--> statement-breakpoint
GRANT SELECT ON scope_level, requirement_scope, requirement_champion TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON scope_level FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON requirement_scope FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON requirement_champion FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON scope_level FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON requirement_scope FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON requirement_champion FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint

-- Seeded levels: every institution starts with Institution, Unit, Program and Course (Course is a placeholder until course
-- records exist: it can be chosen, its list is empty). A trigger gives a new institution the same four.
CREATE FUNCTION seed_scope_levels(p_institution uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO scope_level (institution_id, key, label_en, label_ar, kind, display_order)
  SELECT p_institution, v.key, v.label_en, v.label_ar, v.kind, v.ord
  FROM (VALUES
    ('institution', 'Institution', 'المؤسسة', 'institution', 0),
    ('unit', 'Unit', 'وحدة', 'org_unit', 1),
    ('program', 'Program', 'برنامج', 'program', 2),
    ('course', 'Course', 'مقرر', 'course', 3)
  ) AS v(key, label_en, label_ar, kind, ord)
  ON CONFLICT (institution_id, key) DO NOTHING
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION seed_scope_levels(uuid) FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION institution_seed_scope_levels() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seed_scope_levels(NEW.id);
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER seed_scope_levels AFTER INSERT ON institution FOR EACH ROW EXECUTE FUNCTION institution_seed_scope_levels();--> statement-breakpoint
SELECT seed_scope_levels(id) FROM institution;--> statement-breakpoint

-- Everything a row names belongs to the same institution: the framework, the people, and the units or programs of a scope.
-- A scope's items must be units (level kind org_unit) or programs (program); the other kinds hold no list (empty = all).
CREATE FUNCTION requirement_assignment_checks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM framework WHERE id = NEW.framework_id AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'the standard must be one of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'requirement_scope' THEN
    SELECT kind INTO k FROM scope_level WHERE institution_id = NEW.institution_id AND key = NEW.level_key;
    IF cardinality(NEW.item_ids) > 0 THEN
      IF k = 'org_unit' THEN
        IF EXISTS (SELECT 1 FROM unnest(NEW.item_ids) AS i(id) WHERE NOT EXISTS (SELECT 1 FROM org_unit u WHERE u.id = i.id AND u.institution_id = NEW.institution_id)) THEN
          RAISE EXCEPTION 'a scope can list only units of the same institution' USING ERRCODE = 'check_violation';
        END IF;
      ELSIF k = 'program' THEN
        IF EXISTS (SELECT 1 FROM unnest(NEW.item_ids) AS i(id) WHERE NOT EXISTS (SELECT 1 FROM program p WHERE p.id = i.id AND p.institution_id = NEW.institution_id)) THEN
          RAISE EXCEPTION 'a scope can list only programs of the same institution' USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        RAISE EXCEPTION 'this level has no list of items to choose from' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.user_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'a champion must be a person of the same institution' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.scope_item_kind = 'org_unit' AND NOT EXISTS (SELECT 1 FROM org_unit WHERE id = NEW.scope_item_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'the unit of a champion must be a unit of the same institution' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.scope_item_kind = 'program' AND NOT EXISTS (SELECT 1 FROM program WHERE id = NEW.scope_item_id AND institution_id = NEW.institution_id) THEN
      RAISE EXCEPTION 'the program of a champion must be a program of the same institution' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_same_institution BEFORE INSERT OR UPDATE ON requirement_scope FOR EACH ROW EXECUTE FUNCTION requirement_assignment_checks();--> statement-breakpoint
CREATE TRIGGER a_same_institution BEFORE INSERT OR UPDATE ON requirement_champion FOR EACH ROW EXECUTE FUNCTION requirement_assignment_checks();
