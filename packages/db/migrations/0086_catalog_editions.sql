-- CATALOG EDITIONS AND VERSIONS (DEC-046, step 4). An edition is one academic year's catalog ("2026-27"); it has numbered versions, each a
-- frozen snapshot of everything the catalog prints (programs, requirements, study plans, courses with their approved content, requisites),
-- published by Academic Affairs. The structure being edited (the live data) is the working draft of the one edition that is `working`; a
-- new version is the draft frozen. A published version never changes (trigger), so a catalog year stays citable; each version lists what
-- changed against the one before it. Approval of a version is a separate workflow (a later module); until then a version is published.
CREATE TABLE catalog_edition (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	label text NOT NULL,
	status text DEFAULT 'working' NOT NULL,
	CONSTRAINT catalog_edition_label_check CHECK (length(trim(label)) > 0),
	CONSTRAINT catalog_edition_status_check CHECK (status IN ('working', 'closed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX catalog_edition_label_idx ON catalog_edition (institution_id, lower(label));--> statement-breakpoint
-- One edition at a time is the one being worked on.
CREATE UNIQUE INDEX catalog_edition_working_idx ON catalog_edition (institution_id) WHERE status = 'working';--> statement-breakpoint
CREATE TABLE catalog_version (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	edition_id uuid NOT NULL REFERENCES catalog_edition(id),
	version_no integer NOT NULL,
	note text,
	snapshot jsonb NOT NULL,
	changes jsonb DEFAULT '[]'::jsonb NOT NULL,
	published_at timestamp with time zone DEFAULT now() NOT NULL,
	published_by uuid REFERENCES app_user(id),
	CONSTRAINT catalog_version_no_check CHECK (version_no >= 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX catalog_version_idx ON catalog_version (edition_id, version_no);--> statement-breakpoint
CREATE FUNCTION catalog_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a published catalog version cannot be changed or deleted; publish a new version' USING ERRCODE = 'integrity_constraint_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER a_immutable BEFORE UPDATE OR DELETE ON catalog_version FOR EACH ROW EXECUTE FUNCTION catalog_version_immutable();--> statement-breakpoint
-- An edition is never deleted; once it has a version, only its status may change (working -> closed).
CREATE FUNCTION catalog_edition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a catalog edition cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.label IS DISTINCT FROM OLD.label AND EXISTS (SELECT 1 FROM catalog_version WHERE edition_id = OLD.id) THEN
    RAISE EXCEPTION 'an edition with published versions cannot be renamed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'closed' AND NEW.status = 'working' THEN RAISE EXCEPTION 'a closed edition is not reopened' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER a_guard BEFORE UPDATE OR DELETE ON catalog_edition FOR EACH ROW EXECUTE FUNCTION catalog_edition_guard();--> statement-breakpoint
ALTER TABLE catalog_edition ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON catalog_edition USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
ALTER TABLE catalog_version ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant ON catalog_version USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON catalog_edition TO ams_app;--> statement-breakpoint
GRANT SELECT, INSERT ON catalog_version TO ams_app;--> statement-breakpoint
GRANT SELECT ON catalog_edition, catalog_version TO ams_worker;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON catalog_edition FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON catalog_version FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON catalog_edition FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT ON catalog_version FOR EACH ROW EXECUTE FUNCTION audit_row();
