-- API keys (DEC-040): another system calls the API with `Authorization: Bearer <key>`. An administrator issues a key with a name and a
-- role; the key acts as a service user of its own (an app_user with that role across the institution), so every permission check and the
-- row-level security apply to it unchanged, and the audit trail names it. Only the SHA-256 of the secret is stored; the key is shown once.
-- A key can expire and is revoked (never deleted: the audit trail refers to its user), which also deactivates its user.
CREATE TABLE api_key (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	created_by uuid REFERENCES app_user(id),
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_by uuid REFERENCES app_user(id),
	institution_id uuid NOT NULL REFERENCES institution(id),
	name text NOT NULL,
	user_id uuid NOT NULL REFERENCES app_user(id),
	role text NOT NULL,
	token_hash text NOT NULL,
	hint text NOT NULL,
	last_used_at timestamp with time zone,
	expires_at timestamp with time zone,
	revoked_at timestamp with time zone,
	CONSTRAINT api_key_name_check CHECK (length(trim(name)) > 0),
	CONSTRAINT api_key_role_check CHECK (role IN ('admin', 'lead', 'contributor', 'reviewer', 'viewer'))
);--> statement-breakpoint
CREATE UNIQUE INDEX api_key_user_idx ON api_key (user_id);--> statement-breakpoint
ALTER TABLE api_key ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY admin_only ON api_key USING (institution_id = app_institution_id() AND app_is_admin()) WITH CHECK (institution_id = app_institution_id() AND app_is_admin());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON api_key TO ams_app;--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON api_key FOR EACH ROW EXECUTE FUNCTION stamp_actor();--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON api_key FOR EACH ROW EXECUTE FUNCTION audit_row();--> statement-breakpoint

-- Before any institution is known, the API finds a key by its id (the first part of the key) and compares the secret's hash in constant
-- time itself. It answers only for a key that is not revoked, not expired and whose user is active.
CREATE FUNCTION app_resolve_api_key(p_id uuid) RETURNS TABLE (institution_id uuid, user_id uuid, token_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ams, pg_temp
AS $$
  SELECT k.institution_id, k.user_id, k.token_hash FROM api_key k JOIN app_user u ON u.id = k.user_id
   WHERE k.id = p_id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) AND u.active
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_resolve_api_key(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_resolve_api_key(uuid) TO ams_app;--> statement-breakpoint
-- When a key was last used, at most once an hour (each touch is an audited update).
CREATE FUNCTION app_touch_api_key(p_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ams, pg_temp
AS $$ UPDATE api_key SET last_used_at = now() WHERE id = p_id AND (last_used_at IS NULL OR last_used_at < now() - interval '1 hour') $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_touch_api_key(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_touch_api_key(uuid) TO ams_app;
