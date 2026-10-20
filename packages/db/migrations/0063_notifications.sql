-- IN-APP NOTIFICATIONS (TASK-088). A person is told in the app when something they proposed was decided: today a link of evidence
-- to a standard that a reviewer rejected (with the reason) or approved. One row per person and event; a person sees, reads and
-- dismisses only their OWN rows (row-level security by user), while any signed-in action of the institution may create one for
-- someone else (a reviewer notifying the proposer). The worker may read them (a future email job, TASK-061) and never write.
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"ref_kind" text,
	"ref_id" uuid,
	"read_at" timestamp with time zone,
	CONSTRAINT "notification_kind_check" CHECK ("notification"."kind" in ('link_rejected', 'link_approved')),
	CONSTRAINT "notification_title_check" CHECK (length(trim("notification"."title")) > 0),
	CONSTRAINT "notification_ref_pair_check" CHECK (("notification"."ref_kind" is null) = ("notification"."ref_id" is null))
);--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "notification" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "notification_ref_idx" ON "notification" USING btree ("ref_kind","ref_id");--> statement-breakpoint

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Own rows only: nobody reads, marks read or dismisses another person's notifications, administrators included.
CREATE POLICY own_read ON notification FOR SELECT TO ams_app USING (institution_id = app_institution_id() AND user_id = app_user_id());--> statement-breakpoint
CREATE POLICY own_update ON notification FOR UPDATE TO ams_app USING (institution_id = app_institution_id() AND user_id = app_user_id()) WITH CHECK (institution_id = app_institution_id() AND user_id = app_user_id());--> statement-breakpoint
CREATE POLICY own_delete ON notification FOR DELETE TO ams_app USING (institution_id = app_institution_id() AND user_id = app_user_id());--> statement-breakpoint
-- Anyone acting in the institution may notify another person of the same institution (the recipient is checked by a trigger).
CREATE POLICY notify ON notification FOR INSERT TO ams_app WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
CREATE POLICY worker_read ON notification FOR SELECT TO ams_worker USING (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON notification TO ams_app;--> statement-breakpoint
GRANT SELECT ON notification TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON notification FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON notification FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint

CREATE FUNCTION notification_checks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.user_id AND institution_id = NEW.institution_id) THEN
    RAISE EXCEPTION 'a notification goes to a person of the same institution' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind OR NEW.title <> OLD.title OR NEW.body <> OLD.body
      OR NEW.ref_kind IS DISTINCT FROM OLD.ref_kind OR NEW.ref_id IS DISTINCT FROM OLD.ref_id) THEN
    RAISE EXCEPTION 'a notification can only be marked read' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_notification_checks BEFORE INSERT OR UPDATE ON notification FOR EACH ROW EXECUTE FUNCTION notification_checks();
