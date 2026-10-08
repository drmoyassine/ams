CREATE TABLE "ai_setting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"provider" text DEFAULT 'anthropic' NOT NULL,
	"model" text,
	"api_key_enc" text,
	"api_key_last4" text,
	"max_tokens_per_run" integer,
	"max_cost_usd_per_run" numeric(12, 4),
	"input_usd_per_mtok" numeric(12, 4),
	"output_usd_per_mtok" numeric(12, 4),
	"enabled" boolean DEFAULT false NOT NULL,
	"embed_enabled" boolean DEFAULT false NOT NULL,
	"embed_base_url" text,
	"embed_model" text,
	"embed_api_key_enc" text,
	"embed_api_key_last4" text,
	"embed_dimension" integer,
	CONSTRAINT "ai_setting_provider_check" CHECK ("ai_setting"."provider" in ('anthropic')),
	CONSTRAINT "ai_setting_limits_check" CHECK (("ai_setting"."max_tokens_per_run" is null or "ai_setting"."max_tokens_per_run" > 0) and ("ai_setting"."max_cost_usd_per_run" is null or "ai_setting"."max_cost_usd_per_run" > 0))
);
--> statement-breakpoint
CREATE TABLE "embedding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"model" text NOT NULL,
	"dimension" integer NOT NULL,
	"text_hash" text NOT NULL,
	"vector" real[] NOT NULL,
	CONSTRAINT "embedding_owner_type_check" CHECK ("embedding"."owner_type" in ('requirement')),
	CONSTRAINT "embedding_dimension_check" CHECK ("embedding"."dimension" > 0 and cardinality("embedding"."vector") = "embedding"."dimension")
);
--> statement-breakpoint
ALTER TABLE "ai_setting" ADD CONSTRAINT "ai_setting_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD CONSTRAINT "ai_setting_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_setting" ADD CONSTRAINT "ai_setting_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding" ADD CONSTRAINT "embedding_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding" ADD CONSTRAINT "embedding_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding" ADD CONSTRAINT "embedding_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_setting_institution_idx" ON "ai_setting" USING btree ("institution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_owner_model_idx" ON "embedding" USING btree ("owner_type","owner_id","model");--> statement-breakpoint
CREATE INDEX "embedding_institution_idx" ON "embedding" USING btree ("institution_id");