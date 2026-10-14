CREATE TABLE "org_unit_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "org_unit_type_key_check" CHECK ("org_unit_type"."key" ~ '^[a-z][a-z0-9_]{0,47}$')
);
--> statement-breakpoint
ALTER TABLE "org_unit" DROP CONSTRAINT "org_unit_type_check";--> statement-breakpoint
ALTER TABLE "trash_item" DROP CONSTRAINT "trash_item_kind_check";--> statement-breakpoint
ALTER TABLE "org_unit" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "org_unit" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_unit" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org_unit" ADD COLUMN "display_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_unit" ADD COLUMN "head_user_id" uuid;--> statement-breakpoint
ALTER TABLE "org_unit" ADD COLUMN "head_name" text;--> statement-breakpoint
ALTER TABLE "org_unit" ADD COLUMN "edited_by_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org_unit_type" ADD CONSTRAINT "org_unit_type_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_unit_type" ADD CONSTRAINT "org_unit_type_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_unit_type" ADD CONSTRAINT "org_unit_type_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_unit_type_key_idx" ON "org_unit_type" USING btree ("institution_id","key");--> statement-breakpoint
ALTER TABLE "org_unit" ADD CONSTRAINT "org_unit_head_user_id_app_user_id_fk" FOREIGN KEY ("head_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_unit" ADD CONSTRAINT "org_unit_source_check" CHECK ("org_unit"."source" in ('manual', 'image', 'directory'));--> statement-breakpoint
ALTER TABLE "org_unit" ADD CONSTRAINT "org_unit_head_check" CHECK ("org_unit"."head_user_id" is null or "org_unit"."head_name" is null);--> statement-breakpoint
ALTER TABLE "trash_item" ADD CONSTRAINT "trash_item_kind_check" CHECK ("trash_item"."kind" in ('requirement', 'note', 'source_document', 'source_page', 'report_template', 'framework_version', 'framework', 'mapping', 'evidence_link', 'milestone', 'import_document', 'org_unit'));--> statement-breakpoint

-- ORG CHART BUILDER (TASK-072, docs/organization-plan.md E.1).
--
-- 1. Unit types become data. Each institution has its own small list (org_unit_type: key, English and Arabic label, order),
--    seeded with the five types the application had as a fixed list. org_unit.type is the key of one of them (a composite
--    foreign key, so a type that is in use cannot be removed and a unit cannot name a type that does not exist). A new
--    institution gets the five by a trigger; existing ones get them here, together with every key their units already use.
ALTER TABLE org_unit_type ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON org_unit_type USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON org_unit_type TO ams_app;--> statement-breakpoint
GRANT SELECT ON org_unit_type TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON org_unit_type FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON org_unit_type FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint

CREATE FUNCTION seed_org_unit_types(p_institution uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO org_unit_type (institution_id, key, label_en, label_ar, display_order)
  SELECT p_institution, v.key, v.label_en, v.label_ar, v.ord
  FROM (VALUES
    ('college', 'College', 'كلية', 0),
    ('school', 'School', 'مدرسة', 1),
    ('department', 'Department', 'قسم', 2),
    ('admin_unit', 'Administrative unit', 'وحدة إدارية', 3),
    ('other', 'Other', 'أخرى', 4)
  ) AS v(key, label_en, label_ar, ord)
  ON CONFLICT (institution_id, key) DO NOTHING
$$;--> statement-breakpoint
-- Seeding is for the trigger below and for the owner (migrations, setup); the application roles may not call it for a tenant.
REVOKE ALL ON FUNCTION seed_org_unit_types(uuid) FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION institution_seed_org_unit_types() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seed_org_unit_types(NEW.id);
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER seed_org_unit_types AFTER INSERT ON institution FOR EACH ROW EXECUTE FUNCTION institution_seed_org_unit_types();--> statement-breakpoint
SELECT seed_org_unit_types(id) FROM institution;--> statement-breakpoint
ALTER TABLE "org_unit" ADD CONSTRAINT "org_unit_type_fk" FOREIGN KEY ("institution_id","type") REFERENCES "public"."org_unit_type"("institution_id","key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_unit_type_idx" ON "org_unit" USING btree ("institution_id","type");--> statement-breakpoint

-- 2. Order among siblings, gap-free per parent (like requirement.display_order): existing units are numbered by name.
UPDATE org_unit u SET display_order = n.ord
FROM (SELECT id, (row_number() OVER (PARTITION BY institution_id, parent_id ORDER BY lower(name_en), id) - 1)::int AS ord FROM org_unit) n
WHERE u.id = n.id;--> statement-breakpoint

-- 3. A person's edit marks the unit (like requirement.edited_by_person, migration 0039): an import or a directory sync
--    skips marked and locked units. The worker's own updates leave the mark as it is. mark_person_edit() is shared.
CREATE TRIGGER b_mark_person_edit BEFORE UPDATE ON org_unit FOR EACH ROW EXECUTE FUNCTION mark_person_edit();--> statement-breakpoint

-- 4. The head is a person of the same institution (the foreign key does not see the tenant).
CREATE FUNCTION org_unit_head_same_institution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.head_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.head_user_id AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'the head of a unit must be a person of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_head_same_institution BEFORE INSERT OR UPDATE OF head_user_id ON org_unit FOR EACH ROW EXECUTE FUNCTION org_unit_head_same_institution();--> statement-breakpoint
