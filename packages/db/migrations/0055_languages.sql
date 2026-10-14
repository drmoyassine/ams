-- Languages (TASK-070, docs/organization-plan.md section D, DEC-028).
--
-- institution.secondary_language: the ONE secondary language (a registry code in packages/shared; English is always the
--   primary and is never stored here). institution.default_locale keeps its column but now means "the interface language
--   for people who have not chosen one": it must be 'en' or the secondary language. Existing 'ar' defaults become Arabic as
--   the secondary language (the only other value the old setting allowed), so nothing changes for anyone.
-- app_user.ui_locale: the person's own interface language (null = the institution's default); 'en' or the secondary language.
-- ui_translation: the secondary language's interface catalogue, one row per English key (kept when the language changes).
-- translation_run: a run of the generic `translate` job (kind 'ui' now; content kinds in TASK-071).

ALTER TABLE "institution" ADD COLUMN "secondary_language" text;--> statement-breakpoint
UPDATE "institution" SET "secondary_language" = 'ar' WHERE "default_locale" = 'ar';--> statement-breakpoint
UPDATE "institution" SET "default_locale" = 'en' WHERE "default_locale" IS DISTINCT FROM 'ar';--> statement-breakpoint
ALTER TABLE "institution" ADD CONSTRAINT "institution_secondary_language_check" CHECK ("secondary_language" IS NULL OR ("secondary_language" <> 'en' AND "secondary_language" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'));--> statement-breakpoint
ALTER TABLE "institution" ADD CONSTRAINT "institution_default_locale_check" CHECK ("default_locale" = 'en' OR ("secondary_language" IS NOT NULL AND "default_locale" = "secondary_language"));--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "ui_locale" text;--> statement-breakpoint

-- A person's language must be English or the institution's secondary language.
CREATE FUNCTION app_user_ui_locale_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE sec text;
BEGIN
  IF NEW.ui_locale IS NULL OR NEW.ui_locale = 'en' THEN RETURN NEW; END IF;
  SELECT secondary_language INTO sec FROM institution WHERE id = NEW.institution_id;
  IF sec IS DISTINCT FROM NEW.ui_locale THEN
    RAISE EXCEPTION 'the interface language must be English or the institution''s secondary language' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER app_user_ui_locale_check BEFORE INSERT OR UPDATE OF ui_locale ON app_user FOR EACH ROW EXECUTE FUNCTION app_user_ui_locale_check();--> statement-breakpoint

-- Changing the secondary language: the default falls back to English when it no longer fits, and people whose own choice
-- was the old language go back to the default. Translations already made are kept.
CREATE FUNCTION institution_secondary_language_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.default_locale <> 'en' AND NEW.default_locale IS DISTINCT FROM NEW.secondary_language THEN NEW.default_locale := 'en'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_secondary_language_change BEFORE UPDATE OF secondary_language ON institution FOR EACH ROW EXECUTE FUNCTION institution_secondary_language_change();--> statement-breakpoint
CREATE FUNCTION institution_secondary_language_people() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.secondary_language IS DISTINCT FROM OLD.secondary_language THEN
    UPDATE app_user SET ui_locale = NULL WHERE institution_id = NEW.id AND ui_locale IS NOT NULL AND ui_locale <> 'en' AND ui_locale IS DISTINCT FROM NEW.secondary_language;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER b_secondary_language_people AFTER UPDATE OF secondary_language ON institution FOR EACH ROW EXECUTE FUNCTION institution_secondary_language_people();--> statement-breakpoint

CREATE TABLE "translation_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"language" text NOT NULL,
	"scope_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress" jsonb DEFAULT '{"total":0,"done":0,"flagged":0,"batches":0,"cursor":0}'::jsonb NOT NULL,
	"model" text,
	"prompt_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage" jsonb DEFAULT '{"inputTokens":0,"outputTokens":0,"costUsd":null,"calls":0}'::jsonb NOT NULL,
	"error" text,
	"started_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "translation_run_status_check" CHECK ("status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'stopped')),
	CONSTRAINT "translation_run_kind_check" CHECK ("kind" in ('ui'))
);--> statement-breakpoint
ALTER TABLE "translation_run" ADD CONSTRAINT "translation_run_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id");--> statement-breakpoint
ALTER TABLE "translation_run" ADD CONSTRAINT "translation_run_updated_by_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id");--> statement-breakpoint
ALTER TABLE "translation_run" ADD CONSTRAINT "translation_run_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id");--> statement-breakpoint
ALTER TABLE "translation_run" ADD CONSTRAINT "translation_run_started_by_fk" FOREIGN KEY ("started_by") REFERENCES "public"."app_user"("id");--> statement-breakpoint
CREATE INDEX "translation_run_idx" ON "translation_run" USING btree ("institution_id","kind","language","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "translation_run_one_active_idx" ON "translation_run" USING btree ("institution_id","kind","language",coalesce("scope_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "status" in ('queued', 'running');--> statement-breakpoint

CREATE TABLE "ui_translation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"language" text NOT NULL,
	"key" text NOT NULL,
	"source_hash" text NOT NULL,
	"text" text NOT NULL,
	"origin" text NOT NULL,
	"reviewed" boolean DEFAULT false NOT NULL,
	"run_id" uuid,
	CONSTRAINT "ui_translation_origin_check" CHECK ("origin" in ('ai', 'person')),
	CONSTRAINT "ui_translation_language_check" CHECK ("language" <> 'en')
);--> statement-breakpoint
ALTER TABLE "ui_translation" ADD CONSTRAINT "ui_translation_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id");--> statement-breakpoint
ALTER TABLE "ui_translation" ADD CONSTRAINT "ui_translation_updated_by_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id");--> statement-breakpoint
ALTER TABLE "ui_translation" ADD CONSTRAINT "ui_translation_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id");--> statement-breakpoint
ALTER TABLE "ui_translation" ADD CONSTRAINT "ui_translation_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."translation_run"("id");--> statement-breakpoint
CREATE UNIQUE INDEX "ui_translation_key_idx" ON "ui_translation" USING btree ("institution_id","language","key");--> statement-breakpoint

ALTER TABLE "job" DROP CONSTRAINT "job_type_check";--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_type_check" CHECK ("job"."type" in ('extract_text', 'ocr', 'ai_extract', 'export', 'notify', 'analyse', 'purge_trash', 'assistant', 'translate'));--> statement-breakpoint

-- ---- Tenant isolation, actor stamping, audit -----------------------------------------------------------------------------
ALTER TABLE translation_run ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON translation_run USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON translation_run FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON translation_run FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
ALTER TABLE ui_translation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON ui_translation USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON ui_translation FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON ui_translation FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint

-- ---- Privileges ----------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ui_translation TO ams_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON translation_run TO ams_app;--> statement-breakpoint
-- The worker proposes: it reads the run, records its progress, and writes AI translations. It can never set reviewed, never
-- change a row a person wrote or reviewed, and cannot delete.
GRANT SELECT ON translation_run TO ams_worker;--> statement-breakpoint
GRANT UPDATE (status, progress, model, prompt_versions, usage, error, started_at, finished_at, report) ON translation_run TO ams_worker;--> statement-breakpoint
GRANT SELECT, INSERT ON ui_translation TO ams_worker;--> statement-breakpoint
GRANT UPDATE (text, source_hash, run_id) ON ui_translation TO ams_worker;--> statement-breakpoint

CREATE FUNCTION translation_run_worker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'ams_worker' AND OLD.status IN ('succeeded', 'failed', 'cancelled', 'stopped') THEN
    RAISE EXCEPTION 'translation run % has ended (%); the worker cannot change it', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER c_worker_guard BEFORE UPDATE ON translation_run FOR EACH ROW EXECUTE FUNCTION translation_run_worker_guard();--> statement-breakpoint

CREATE FUNCTION ui_translation_worker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER c_worker_guard BEFORE INSERT OR UPDATE ON ui_translation FOR EACH ROW EXECUTE FUNCTION ui_translation_worker_guard();--> statement-breakpoint

-- ---- The sign-in page's language (public, narrow) ---------------------------------------------------------------------------
-- Like app_public_branding(): a deployment serves one institution, and with none or several nothing is returned. These two
-- functions are the only way the API reads language data without an identity: the default and secondary language codes, and
-- the text of exactly the keys the caller names (the API passes the fixed list of sign-in keys, never anything else).
CREATE FUNCTION app_public_languages()
RETURNS TABLE (default_locale text, secondary_language text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT i.default_locale, i.secondary_language FROM institution i WHERE (SELECT count(*) FROM institution) = 1
$$;--> statement-breakpoint
CREATE FUNCTION app_public_ui_strings(p_keys text[])
RETURNS TABLE (key text, text text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT t.key, t.text FROM ui_translation t JOIN institution i ON i.id = t.institution_id
  WHERE (SELECT count(*) FROM institution) = 1 AND t.language = i.secondary_language AND t.key = ANY (p_keys)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_public_languages() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_public_ui_strings(text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_public_languages() TO ams_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_public_ui_strings(text[]) TO ams_app;
