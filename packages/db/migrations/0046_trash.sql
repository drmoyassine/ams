CREATE TABLE "trash_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"context" text,
	"payload" jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_by" uuid,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"restored_at" timestamp with time zone,
	CONSTRAINT "trash_item_kind_check" CHECK ("trash_item"."kind" in ('requirement', 'note', 'source_document', 'source_page', 'report_template', 'framework_version', 'framework', 'mapping', 'evidence_link', 'milestone')),
	CONSTRAINT "trash_item_counts_check" CHECK (jsonb_typeof("trash_item"."counts") = 'object')
);
--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_type_check";--> statement-breakpoint
ALTER TABLE "trash_item" ADD CONSTRAINT "trash_item_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_item" ADD CONSTRAINT "trash_item_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_item" ADD CONSTRAINT "trash_item_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_item" ADD CONSTRAINT "trash_item_deleted_by_app_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trash_item_group_idx" ON "trash_item" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "trash_item_institution_idx" ON "trash_item" USING btree ("institution_id","deleted_at");--> statement-breakpoint
CREATE INDEX "trash_item_expires_idx" ON "trash_item" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_type_check" CHECK ("job"."type" in ('extract_text', 'ocr', 'ai_extract', 'export', 'notify', 'analyse', 'purge_trash'));
--> statement-breakpoint
-- TRASH (DEC-026): deleted items stay for 30 days as snapshots and can be restored with their original ids.
--
-- trash_item is a tenant table (RLS on institution_id). The app reads, writes and deletes its rows (delete = "Delete
-- forever"). The worker's ONLY write anywhere is the daily purge: it may delete trash_item rows that have expired, in its
-- own tenant, and nothing else (it has no grant on any other table that it did not already have). Rows that were restored
-- stay until they expire, with their payload emptied by the service.
--
-- The audit trail: the real rows keep their own audit_row events (the delete and, on restore, the re-insert, attributed to
-- the person). trash_item has its own, lighter event that leaves the payload out, so the trail says who deleted what and
-- who restored or purged it without storing every deleted row a second time.
ALTER TABLE trash_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON trash_item TO ams_app USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());
--> statement-breakpoint
CREATE POLICY worker_read ON trash_item FOR SELECT TO ams_worker USING (institution_id = app_institution_id());
--> statement-breakpoint
CREATE POLICY worker_purge ON trash_item FOR DELETE TO ams_worker USING (institution_id = app_institution_id() AND expires_at <= now());
--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON trash_item FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint
CREATE FUNCTION audit_trash_item() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  actor uuid := app_user_id();
  atype text := coalesce(nullif(current_setting('app.actor_type', true), ''), CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END);
BEGIN
  INSERT INTO audit_event (institution_id, actor_id, actor_type, action, target_type, target_id, before, after, created_by, updated_by)
  VALUES (r.institution_id, actor, atype, lower(TG_OP), 'trash_item', r.id,
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) - 'payload' END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) - 'payload' END, actor, actor);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON trash_item FOR EACH ROW EXECUTE FUNCTION audit_trash_item();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON trash_item TO ams_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON trash_item TO ams_worker;
--> statement-breakpoint

-- Which tenants have expired Trash? The purge tick has no tenant of its own (RLS shows it nothing), so it asks this one
-- narrow question, then purges each tenant in a transaction under a system identity for that tenant.
CREATE FUNCTION trash_expired_institutions() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT DISTINCT institution_id FROM trash_item WHERE expires_at <= now() $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION trash_expired_institutions() FROM PUBLIC, ams_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION trash_expired_institutions() TO ams_worker;
--> statement-breakpoint

-- The analysis remembers what a person deleted (analysis_dismissal, 0041) so a new run does not add it back. That table is
-- append-only for the app, so two narrow functions do the only two removals Trash needs, both inside the caller's tenant:
--  * forget_ai_dismissal: a requirement or note that a restore puts back is no longer dismissed (trigger below).
--  * trash_drop_dismissals: deleting a whole draft version takes its dismissals with it (they belong to the version).
CREATE FUNCTION forget_ai_dismissal(p_version uuid, p_kind text, p_code text, p_note_text text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM analysis_dismissal
   WHERE institution_id = app_institution_id() AND framework_version_id = p_version AND kind = p_kind AND code = p_code
     AND (p_kind = 'requirement' OR note_text = p_note_text)
$$;
--> statement-breakpoint
CREATE FUNCTION trash_drop_dismissals(p_version uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM framework_version WHERE id = p_version AND institution_id = app_institution_id() AND status IN ('draft', 'in_review')) THEN
    RAISE EXCEPTION 'dismissals can be dropped only with a draft version of your own institution' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  DELETE FROM analysis_dismissal WHERE framework_version_id = p_version AND institution_id = app_institution_id();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION forget_ai_dismissal(uuid, text, text, text), trash_drop_dismissals(uuid) FROM PUBLIC, ams_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION forget_ai_dismissal(uuid, text, text, text), trash_drop_dismissals(uuid) TO ams_app;
--> statement-breakpoint

-- An AI-made requirement or note that comes back (restored from Trash) is visible to the analysis again. The worker's own
-- inserts never clear a dismissal (it checks them before it writes), so only a person's insert does.
CREATE FUNCTION clear_ai_dismissal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v uuid;
  c text;
BEGIN
  IF current_user = 'ams_worker' OR NEW.origin <> 'ai' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'requirement' THEN
    PERFORM forget_ai_dismissal(NEW.framework_version_id, 'requirement', NEW.code, NULL);
  ELSE
    SELECT framework_version_id, code INTO v, c FROM requirement WHERE id = NEW.requirement_id;
    IF v IS NOT NULL THEN PERFORM forget_ai_dismissal(v, 'note', c, NEW.text); END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER e_clear_ai_dismissal AFTER INSERT ON requirement FOR EACH ROW EXECUTE FUNCTION clear_ai_dismissal();
--> statement-breakpoint
CREATE TRIGGER e_clear_ai_dismissal AFTER INSERT ON requirement_note FOR EACH ROW EXECUTE FUNCTION clear_ai_dismissal();
