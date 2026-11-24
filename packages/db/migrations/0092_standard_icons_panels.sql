-- ICONS FOR STANDARDS AND SIDE PANELS (the owner, 2026-11-24).
--   requirement_icon          the icon a standard shows in Quality Management and its side panel (a lucide icon name), by framework +
--                             code like the other things attached to a standard, so it follows the standard when it is renumbered;
--   app_user.panels_collapsed which side panels (Settings, Quality Management …) a person keeps collapsed to icons, by panel key.
CREATE TABLE requirement_icon (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL, created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL, updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	framework_id uuid NOT NULL REFERENCES framework(id),
	code text NOT NULL,
	icon text NOT NULL,
	CONSTRAINT requirement_icon_name_check CHECK (icon ~ '^[A-Za-z][A-Za-z0-9]{0,39}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX requirement_icon_idx ON requirement_icon (institution_id, framework_id, code);--> statement-breakpoint
ALTER TABLE requirement_icon ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON requirement_icon USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON requirement_icon TO ams_app;--> statement-breakpoint
GRANT SELECT ON requirement_icon TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON requirement_icon FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON requirement_icon FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
ALTER TABLE app_user ADD COLUMN panels_collapsed jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_panels_collapsed_check CHECK (jsonb_typeof(panels_collapsed) = 'object');
