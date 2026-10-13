CREATE TABLE "assistant_change_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"message_id" uuid,
	"part_id" text,
	"version_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"change_set_hash" text NOT NULL,
	"operations" jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"inverse" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'applied' NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	CONSTRAINT "assistant_change_set_state_check" CHECK ("assistant_change_set"."state" in ('applied', 'undone')),
	CONSTRAINT "assistant_change_set_counts_check" CHECK (jsonb_typeof("assistant_change_set"."counts") = 'object')
);
--> statement-breakpoint
CREATE TABLE "assistant_confirmation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"part_id" text NOT NULL,
	"change_set_hash" text NOT NULL,
	"plan_hash" text NOT NULL,
	"token_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_result" text,
	CONSTRAINT "assistant_confirmation_result_check" CHECK ("assistant_confirmation"."consumed_result" is null or "assistant_confirmation"."consumed_result" in ('consuming', 'applied', 'failed', 'stale', 'superseded', 'refused'))
);
--> statement-breakpoint
CREATE TABLE "assistant_written_text" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"institution_id" uuid NOT NULL,
	"change_set_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"field" text NOT NULL,
	"text" text NOT NULL,
	"previous" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "assistant_written_text_state_check" CHECK ("assistant_written_text"."state" in ('pending', 'kept', 'reverted')),
	CONSTRAINT "assistant_written_text_field_check" CHECK ("assistant_written_text"."field" in ('title', 'officialText', 'translationEn'))
);
--> statement-breakpoint
ALTER TABLE "assistant_change_set" ADD CONSTRAINT "assistant_change_set_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_change_set" ADD CONSTRAINT "assistant_change_set_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_change_set" ADD CONSTRAINT "assistant_change_set_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_change_set" ADD CONSTRAINT "assistant_change_set_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_change_set" ADD CONSTRAINT "assistant_change_set_message_id_assistant_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."assistant_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_confirmation" ADD CONSTRAINT "assistant_confirmation_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_confirmation" ADD CONSTRAINT "assistant_confirmation_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_confirmation" ADD CONSTRAINT "assistant_confirmation_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_confirmation" ADD CONSTRAINT "assistant_confirmation_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_confirmation" ADD CONSTRAINT "assistant_confirmation_message_id_assistant_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."assistant_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_written_text" ADD CONSTRAINT "assistant_written_text_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_written_text" ADD CONSTRAINT "assistant_written_text_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_written_text" ADD CONSTRAINT "assistant_written_text_institution_id_institution_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_written_text" ADD CONSTRAINT "assistant_written_text_change_set_id_assistant_change_set_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."assistant_change_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_written_text" ADD CONSTRAINT "assistant_written_text_decided_by_app_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_change_set_user_idx" ON "assistant_change_set" USING btree ("user_id","applied_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_confirmation_token_idx" ON "assistant_confirmation" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "assistant_confirmation_part_idx" ON "assistant_confirmation" USING btree ("message_id","part_id");--> statement-breakpoint
CREATE INDEX "assistant_written_text_version_idx" ON "assistant_written_text" USING btree ("version_id","state");--> statement-breakpoint
CREATE INDEX "assistant_written_text_requirement_idx" ON "assistant_written_text" USING btree ("requirement_id");--> statement-breakpoint

-- The assistant's bulk edits (DEC-027, Phase 2): the one-time confirmation, the applied change sets, the texts it wrote.
--
-- assistant_confirmation: a person's "Do it" press. Written ONLY by the API's confirm endpoint: the worker's role (the job in
--   which the model runs) has no grant on it at all, so a model can neither issue nor consume a confirmation. A row is tied to
--   the person, the message part and the hashes of the exact change set; ten minutes; consumed once (atomic UPDATE ... WHERE
--   consumed_at IS NULL in the apply request). Only the token's SHA-256 is stored.
-- assistant_change_set: one row per applied change set, with the ordered undo descriptors the services reported (the inverse).
--   Own rows only (a person undoes their own changes). The audit trail records COUNTS, never the words.
-- assistant_written_text: texts the assistant wrote and the person confirmed, until the person keeps or reverts them. Tenant
--   wide (it is about the standard, not the chat).
ALTER TABLE assistant_confirmation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own ON assistant_confirmation TO ams_app
  USING (institution_id = app_institution_id() AND user_id = app_user_id())
  WITH CHECK (institution_id = app_institution_id() AND user_id = app_user_id());
--> statement-breakpoint
ALTER TABLE assistant_change_set ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own ON assistant_change_set TO ams_app
  USING (institution_id = app_institution_id() AND user_id = app_user_id())
  WITH CHECK (institution_id = app_institution_id() AND user_id = app_user_id());
--> statement-breakpoint
ALTER TABLE assistant_written_text ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON assistant_written_text TO ams_app USING (institution_id = app_institution_id()) WITH CHECK (institution_id = app_institution_id());
--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON assistant_confirmation FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON assistant_change_set FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON assistant_written_text FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint

-- A confirmation is issued to a signed-in person (never to the AI or a system identity), for themselves, for at most ten
-- minutes; afterwards only its consumption can change, once, and it can never be un-consumed.
CREATE FUNCTION assistant_confirmation_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF coalesce(nullif(current_setting('app.actor_type', true), ''), 'user') <> 'user' OR app_user_id() IS NULL OR NEW.user_id <> app_user_id() THEN
      RAISE EXCEPTION 'a confirmation is issued only to the signed-in person it is for' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.expires_at <= now() OR NEW.expires_at > now() + interval '10 minutes 5 seconds' THEN
      RAISE EXCEPTION 'a confirmation is valid for at most ten minutes' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new confirmation is not consumed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.consumed_at IS NOT NULL THEN
    -- Consumed once. The only change afterwards: the apply request that consumed it ('consuming') records how it ended.
    IF OLD.consumed_result IS DISTINCT FROM 'consuming' OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR NEW.consumed_result IS NOT DISTINCT FROM 'consuming' THEN
      RAISE EXCEPTION 'this confirmation was already used' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.message_id IS DISTINCT FROM OLD.message_id OR NEW.part_id IS DISTINCT FROM OLD.part_id
     OR NEW.change_set_hash IS DISTINCT FROM OLD.change_set_hash OR NEW.plan_hash IS DISTINCT FROM OLD.plan_hash OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'only the use of a confirmation can change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_rules BEFORE INSERT OR UPDATE ON assistant_confirmation FOR EACH ROW EXECUTE FUNCTION assistant_confirmation_rules();
--> statement-breakpoint

-- What was applied does not change afterwards except its state, its counts and the undo/redo list.
CREATE FUNCTION assistant_change_set_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.version_id IS DISTINCT FROM OLD.version_id OR NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.change_set_hash IS DISTINCT FROM OLD.change_set_hash OR NEW.operations IS DISTINCT FROM OLD.operations OR NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
    RAISE EXCEPTION 'an applied change set cannot be rewritten' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_rules BEFORE UPDATE ON assistant_change_set FOR EACH ROW EXECUTE FUNCTION assistant_change_set_rules();
--> statement-breakpoint

-- Audit: who, when, how many; never the words (summary, operations, the undo list, the texts). The requirement rows the change
-- set touched have their own audit events under the person's name, as for any edit.
CREATE FUNCTION assistant_change_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  actor uuid := app_user_id();
  atype text := coalesce(nullif(current_setting('app.actor_type', true), ''), CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END);
  b jsonb;
  a jsonb;
BEGIN
  IF TG_TABLE_NAME = 'assistant_change_set' THEN
    IF TG_OP = 'UPDATE' THEN
      b := jsonb_build_object('state', OLD.state);
    END IF;
    a := jsonb_build_object('proposed_by', 'assistant', 'applied_by', NEW.user_id, 'state', NEW.state, 'counts', NEW.counts,
                            'version_id', NEW.version_id, 'message_id', NEW.message_id, 'change_set_hash', NEW.change_set_hash);
    INSERT INTO audit_event (institution_id, actor_id, actor_type, action, target_type, target_id, before, after, created_by, updated_by)
    VALUES (NEW.institution_id, actor, atype, CASE WHEN TG_OP = 'INSERT' THEN 'assistant_change_applied' WHEN NEW.state = 'undone' THEN 'assistant_change_undone' ELSE 'assistant_change_redone' END,
            'assistant_change_set', NEW.id, b, a, actor, actor);
  ELSE
    INSERT INTO audit_event (institution_id, actor_id, actor_type, action, target_type, target_id, before, after, created_by, updated_by)
    VALUES (NEW.institution_id, actor, atype, CASE WHEN TG_OP = 'INSERT' THEN 'assistant_confirmation_issued' ELSE 'assistant_confirmation_used' END,
            'assistant_confirmation', NEW.id, NULL,
            jsonb_build_object('user_id', NEW.user_id, 'message_id', NEW.message_id, 'part_id', NEW.part_id, 'change_set_hash', NEW.change_set_hash,
                               'expires_at', NEW.expires_at, 'consumed_result', NEW.consumed_result), actor, actor);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON assistant_change_set FOR EACH ROW EXECUTE FUNCTION assistant_change_audit();
--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON assistant_confirmation FOR EACH ROW EXECUTE FUNCTION assistant_change_audit();
--> statement-breakpoint

-- Privileges: the API's role only. The worker (the model's job) gets NOTHING on these three tables.
GRANT SELECT, INSERT, UPDATE ON assistant_confirmation, assistant_change_set, assistant_written_text TO ams_app;
