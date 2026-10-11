CREATE TABLE "ai_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text,
	"api_key_enc" text,
	"api_key_last4" text,
	CONSTRAINT "ai_account_provider_check" CHECK ("ai_account"."provider" in ('anthropic', 'openai', 'google', 'openrouter', 'openai_compatible')),
	CONSTRAINT "ai_account_base_url_check" CHECK ("ai_account"."base_url" is null or "ai_account"."provider" = 'openai_compatible')
);
--> statement-breakpoint
ALTER TABLE "ai_setting" ADD COLUMN "analysis_account_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD COLUMN "cap_unit" text DEFAULT 'tokens' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD COLUMN "vision_account_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD COLUMN "vision_model" text;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD COLUMN "ocr_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD COLUMN "ocr_max_pages" integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD COLUMN "ocr_language" text;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD COLUMN "embed_account_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_account" ADD CONSTRAINT "ai_account_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_account" ADD CONSTRAINT "ai_account_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_account" ADD CONSTRAINT "ai_account_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_account_name_idx" ON "ai_account" USING btree ("institution_id",lower("name"));--> statement-breakpoint
CREATE INDEX "ai_account_institution_idx" ON "ai_account" USING btree ("institution_id");--> statement-breakpoint
ALTER TABLE "ai_setting" ADD CONSTRAINT "ai_setting_analysis_account_id_ai_account_id_fk" FOREIGN KEY ("analysis_account_id") REFERENCES "public"."ai_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD CONSTRAINT "ai_setting_vision_account_id_ai_account_id_fk" FOREIGN KEY ("vision_account_id") REFERENCES "public"."ai_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD CONSTRAINT "ai_setting_embed_account_id_ai_account_id_fk" FOREIGN KEY ("embed_account_id") REFERENCES "public"."ai_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD CONSTRAINT "ai_setting_cap_unit_check" CHECK ("ai_setting"."cap_unit" in ('tokens', 'usd'));--> statement-breakpoint
ALTER TABLE "ai_setting" ADD CONSTRAINT "ai_setting_ocr_max_pages_check" CHECK ("ai_setting"."ocr_max_pages" between 1 and 5000);--> statement-breakpoint

-- Settings -> AI becomes saved ACCOUNTS (connections) plus ASSIGNMENTS (which account and model does what) (DEC-025).
-- ai_account: tenant RLS, actor stamping and audit like the other institution tables. Changing an account needs the
-- ai:manage permission (admin), checked in the service. The worker reads accounts to open its connections and can never
-- change them. Keys are stored encrypted; the audit trail therefore holds ciphertext, never a key.
ALTER TABLE ai_account ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON ai_account USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());
--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON ai_account FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON ai_account FOR EACH ROW EXECUTE FUNCTION audit_row();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_account TO ams_app;
--> statement-breakpoint
GRANT SELECT ON ai_account TO ams_worker;
--> statement-breakpoint

-- Existing saved settings become accounts (forward-only, same transaction). The key ciphertext is copied as it is:
-- same APP_SECRET, no re-encryption, so nothing has to be typed again. Then the legacy secrets are cleared so no key is
-- kept twice. The legacy columns themselves stay (unused, documented in schema.ts) so a rolling deploy never meets a
-- missing column; a later migration can drop them.
--   * an analysis account is made when the row has a key, a model, a non-default provider or a Base URL (a row with only
--     limits keeps using the server environment, as before); an account without a key uses the environment's key;
--   * embeddings with a Base URL become an OpenAI-compatible account of their own ("Embeddings (OpenAI-compatible)");
--   * the cap becomes one: tokens when a token limit was set, else USD when a cost limit and both prices were set.
--     A row that had both keeps the token cap only (the cost limit is cleared; the two prices stay as the model's price).
DO $$
DECLARE
  r record;
  acc uuid;
  emb uuid;
  label text;
BEGIN
  FOR r IN SELECT * FROM ai_setting LOOP
    acc := NULL;
    emb := NULL;
    IF r.api_key_enc IS NOT NULL OR r.model IS NOT NULL OR r.provider <> 'anthropic' OR r.base_url IS NOT NULL THEN
      label := CASE r.provider WHEN 'anthropic' THEN 'Anthropic' WHEN 'openai' THEN 'OpenAI' WHEN 'google' THEN 'Google (Gemini)' ELSE 'OpenAI-compatible' END;
      INSERT INTO ai_account (institution_id, name, provider, base_url, api_key_enc, api_key_last4)
      VALUES (r.institution_id, label, r.provider, r.base_url, r.api_key_enc, r.api_key_last4) RETURNING id INTO acc;
    END IF;
    IF r.embed_base_url IS NOT NULL THEN
      INSERT INTO ai_account (institution_id, name, provider, base_url, api_key_enc, api_key_last4)
      VALUES (r.institution_id, 'Embeddings (OpenAI-compatible)', 'openai_compatible', r.embed_base_url, r.embed_api_key_enc, r.embed_api_key_last4)
      RETURNING id INTO emb;
    END IF;
    UPDATE ai_setting SET
      analysis_account_id = acc,
      embed_account_id = emb,
      -- embeddings without a usable endpoint cannot stay switched on
      embed_enabled = CASE WHEN emb IS NULL THEN false ELSE embed_enabled END,
      cap_unit = CASE
        WHEN max_tokens_per_run IS NOT NULL THEN 'tokens'
        WHEN max_cost_usd_per_run IS NOT NULL AND input_usd_per_mtok IS NOT NULL AND output_usd_per_mtok IS NOT NULL THEN 'usd'
        ELSE 'tokens' END,
      max_cost_usd_per_run = CASE
        WHEN max_tokens_per_run IS NOT NULL THEN NULL
        WHEN max_cost_usd_per_run IS NOT NULL AND input_usd_per_mtok IS NOT NULL AND output_usd_per_mtok IS NOT NULL THEN max_cost_usd_per_run
        ELSE NULL END,
      api_key_enc = NULL, api_key_last4 = NULL,
      embed_api_key_enc = NULL, embed_api_key_last4 = NULL
    WHERE id = r.id;
  END LOOP;
END $$;