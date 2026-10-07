-- Evidence requests (DEC-018): tenant isolation, audit, privileges, and the one-time link lookup.

ALTER TABLE evidence_request ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON evidence_request TO ams_worker;
--> statement-breakpoint
-- Requests are cancelled, never deleted.
GRANT SELECT, INSERT, UPDATE ON evidence_request TO ams_app;
--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON evidence_request FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON evidence_request FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
CREATE POLICY scoped ON evidence_request
  USING (institution_id = app_institution_id())
  WITH CHECK (institution_id = app_institution_id());
--> statement-breakpoint

-- A request asks for evidence on an item of the institution's own framework; its target never changes, and a request
-- that was answered or cancelled stays that way.
CREATE FUNCTION evidence_request_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM framework WHERE id = NEW.internal_framework_id AND internal) THEN
    RAISE EXCEPTION 'evidence is requested for items of the internal quality framework' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.internal_framework_id <> OLD.internal_framework_id OR NEW.internal_code <> OLD.internal_code THEN
      RAISE EXCEPTION 'a request''s target cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'open' AND (NEW.status <> OLD.status OR NEW.token_hash IS NOT NULL) THEN
      RAISE EXCEPTION 'this request is closed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_evidence_request_rules BEFORE INSERT OR UPDATE ON evidence_request FOR EACH ROW EXECUTE FUNCTION evidence_request_rules();
--> statement-breakpoint

-- The one-time link: finds the open, unexpired request whose link hashes to p_hash, before any institution is known.
-- Returns nothing for a used, expired, cancelled or unknown link.
CREATE FUNCTION app_resolve_request_link(p_hash text) RETURNS TABLE (request_id uuid, institution_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT r.id, r.institution_id FROM evidence_request r
  WHERE r.token_hash = p_hash AND r.status = 'open' AND r.token_expires_at > now()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_resolve_request_link(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_resolve_request_link(text) TO ams_app;
