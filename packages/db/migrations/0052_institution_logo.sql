ALTER TABLE "institution" ADD COLUMN "logo_path" text;--> statement-breakpoint
ALTER TABLE "institution" ADD COLUMN "logo_mime" text;--> statement-breakpoint
ALTER TABLE "institution" ADD COLUMN "logo_updated_at" timestamp with time zone;--> statement-breakpoint

-- The sign-in page is shown before anyone is authenticated, so it needs the institution's name, accent colour and logo
-- without an identity. This one function is the only way the API reads institution rows without one, and it returns
-- exactly those fields: no id, country, locale-independent identifiers or anything else. A deployment serves one
-- institution; if there is none, or more than one, it returns nothing rather than guess which one is meant.
CREATE FUNCTION app_public_branding()
RETURNS TABLE (name_en text, name_ar text, default_locale text, accent_color text, logo_path text, logo_mime text, logo_updated_at timestamp with time zone)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT i.name_en, i.name_ar, i.default_locale, i.accent_color, i.logo_path, i.logo_mime, i.logo_updated_at
  FROM institution i
  WHERE (SELECT count(*) FROM institution) = 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_public_branding() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_public_branding() TO ams_app;
