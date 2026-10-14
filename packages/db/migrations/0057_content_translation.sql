-- Content translation (TASK-071, docs/organization-plan.md section D, DEC-028): the IQF and the external standards in the
-- institution's secondary language.
--
-- content_translation: one row per (entity, field, language): the text of a requirement's title or statement, or of a note,
--   in the secondary language, beside the English which stays where it is (requirement, requirement_note) and is never
--   replaced. `source_hash` is the hash of the English the text came from, so a later English edit shows it out of date.
--   kind 'iqf' = an item of the institution's own quality framework; 'standard' = a requirement of an external standard, whose
--   translation is UNOFFICIAL (DEC-028): the application labels it so wherever it is shown and never uses it for quote
--   matching or exports as the official text.
--   entity_id is the requirement or note id; framework_version_id says which version it belongs to. Neither is a foreign key:
--   the translation lives in its own table, so it can be added to a PUBLISHED or retired version (the frozen-version triggers
--   guard requirement, requirement_note and the other version tables, not this one), and it survives a version or requirement
--   being moved to the Trash and comes back with it on restore. Readers join to the live requirement and ignore the rest.
-- translation_run.kind: also 'iqf' and 'standard' (scope_id = the framework version).
-- The worker may only add unreviewed AI rows and change the text of an unreviewed AI row, as for ui_translation.

ALTER TABLE "translation_run" DROP CONSTRAINT "translation_run_kind_check";--> statement-breakpoint
ALTER TABLE "translation_run" ADD CONSTRAINT "translation_run_kind_check" CHECK ("kind" in ('ui', 'iqf', 'standard'));--> statement-breakpoint

CREATE TABLE "content_translation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"field" text NOT NULL,
	"language" text NOT NULL,
	"source_hash" text NOT NULL,
	"text" text NOT NULL,
	"origin" text NOT NULL,
	"reviewed" boolean DEFAULT false NOT NULL,
	"run_id" uuid,
	CONSTRAINT "content_translation_kind_check" CHECK ("kind" in ('iqf', 'standard')),
	CONSTRAINT "content_translation_field_check" CHECK ("field" in ('title', 'statement', 'note')),
	CONSTRAINT "content_translation_origin_check" CHECK ("origin" in ('ai', 'person')),
	CONSTRAINT "content_translation_language_check" CHECK ("language" <> 'en')
);--> statement-breakpoint
ALTER TABLE "content_translation" ADD CONSTRAINT "content_translation_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id");--> statement-breakpoint
ALTER TABLE "content_translation" ADD CONSTRAINT "content_translation_updated_by_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id");--> statement-breakpoint
ALTER TABLE "content_translation" ADD CONSTRAINT "content_translation_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id");--> statement-breakpoint
ALTER TABLE "content_translation" ADD CONSTRAINT "content_translation_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."translation_run"("id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_translation_entity_idx" ON "content_translation" USING btree ("institution_id","language","entity_id","field");--> statement-breakpoint
CREATE INDEX "content_translation_version_idx" ON "content_translation" USING btree ("institution_id","framework_version_id","language");--> statement-breakpoint

-- ---- Tenant isolation, actor stamping, audit -----------------------------------------------------------------------------
ALTER TABLE content_translation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON content_translation USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON content_translation FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON content_translation FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint

-- ---- Privileges ----------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON content_translation TO ams_app;--> statement-breakpoint
-- The worker proposes: it writes AI translations. It can never set reviewed, never change a row a person wrote or reviewed,
-- and cannot delete.
GRANT SELECT, INSERT ON content_translation TO ams_worker;--> statement-breakpoint
GRANT UPDATE (text, source_hash, run_id) ON content_translation TO ams_worker;--> statement-breakpoint

CREATE FUNCTION content_translation_worker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'ams_worker' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.origin <> 'ai' OR NEW.reviewed THEN
      RAISE EXCEPTION 'the worker adds only unreviewed AI translations' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF OLD.origin <> 'ai' OR OLD.reviewed THEN
      RAISE EXCEPTION 'a person wrote or reviewed this translation; the worker cannot change it' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.origin <> 'ai' OR NEW.reviewed THEN
      RAISE EXCEPTION 'the worker cannot mark a translation reviewed or as a person''s' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER c_worker_guard BEFORE INSERT OR UPDATE ON content_translation FOR EACH ROW EXECUTE FUNCTION content_translation_worker_guard();
