-- Settings -> AI can use more than Anthropic (DEC-012: switching provider is configuration). `openai_compatible` is any
-- server that speaks the OpenAI chat API at a Base URL (OpenRouter, Ollama, vLLM, LM Studio, Azure ...), so the row
-- gets a nullable base_url that only that provider may set. Forward-only: existing rows are 'anthropic' and stay valid.
ALTER TABLE "ai_setting" DROP CONSTRAINT "ai_setting_provider_check";--> statement-breakpoint
ALTER TABLE "ai_setting" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD CONSTRAINT "ai_setting_provider_check" CHECK ("ai_setting"."provider" in ('anthropic', 'openai', 'google', 'openai_compatible'));--> statement-breakpoint
ALTER TABLE "ai_setting" ADD CONSTRAINT "ai_setting_base_url_check" CHECK ("ai_setting"."base_url" is null or "ai_setting"."provider" = 'openai_compatible');
