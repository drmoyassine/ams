-- The in-app assistant (DEC-027, docs/assistant-plan.md): tenant isolation, ownership, audit and what the worker may do.
--
-- assistant_conversation / assistant_message: a person sees ONLY their own conversations (the policy keys on user_id, not only
--   on the tenant). The worker runs a turn as the person who sent the message (the job carries their identity), so the same
--   policy lets it read that person's conversation and nobody else's. Administrators with ai:manage can read others' only
--   through the two audited functions at the end (each read writes an audit_event row).
-- memory_item: tenant-wide for workspace rows, author-only for private rows (a private note is invisible to everyone else,
--   including the worker acting for someone else). Whether a person may READ a workspace row's scope is checked by the core
--   service at read time. The worker has SELECT and nothing else: only a person's confirm call (an API request) writes memory.
-- Audit: conversations and memory are audited as METADATA ONLY (ids, scope, flags), never the words, so the audit trail does
--   not keep what a person asked the assistant or what they asked it to remember after they delete it. Messages are not
--   audited row by row, for the same reason (they are the words).

-- ---- Row-level security ---------------------------------------------------------------------------------------------
ALTER TABLE assistant_conversation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own ON assistant_conversation
  USING (institution_id = app_institution_id() AND user_id = app_user_id())
  WITH CHECK (institution_id = app_institution_id() AND user_id = app_user_id());
--> statement-breakpoint
ALTER TABLE assistant_message ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own ON assistant_message
  USING (institution_id = app_institution_id()
    AND EXISTS (SELECT 1 FROM assistant_conversation c WHERE c.id = assistant_message.conversation_id AND c.user_id = app_user_id()))
  WITH CHECK (institution_id = app_institution_id()
    AND EXISTS (SELECT 1 FROM assistant_conversation c WHERE c.id = assistant_message.conversation_id AND c.user_id = app_user_id()));
--> statement-breakpoint
ALTER TABLE memory_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY visible ON memory_item
  USING (institution_id = app_institution_id() AND (visibility = 'workspace' OR created_by = app_user_id()))
  WITH CHECK (institution_id = app_institution_id() AND (visibility = 'workspace' OR created_by = app_user_id()));
--> statement-breakpoint

-- ---- Actor stamping and audit ---------------------------------------------------------------------------------------
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON assistant_conversation FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON assistant_message FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint
CREATE TRIGGER stamp_actor BEFORE INSERT OR UPDATE ON memory_item FOR EACH ROW EXECUTE FUNCTION stamp_actor();
--> statement-breakpoint

CREATE FUNCTION assistant_audit_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  actor uuid := app_user_id();
  atype text := coalesce(nullif(current_setting('app.actor_type', true), ''), CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END);
  b jsonb;
  a jsonb;
BEGIN
  -- Metadata only: the words (title, context, text) are left out.
  IF TG_OP <> 'INSERT' THEN
    b := CASE TG_TABLE_NAME WHEN 'memory_item' THEN to_jsonb(OLD) - 'text' ELSE to_jsonb(OLD) - 'title' - 'context' END;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    a := CASE TG_TABLE_NAME WHEN 'memory_item' THEN to_jsonb(NEW) - 'text' ELSE to_jsonb(NEW) - 'title' - 'context' END;
  END IF;
  INSERT INTO audit_event (institution_id, actor_id, actor_type, action, target_type, target_id, before, after, created_by, updated_by)
  VALUES (r.institution_id, actor, atype, lower(TG_OP), TG_TABLE_NAME, r.id, b, a, actor, actor);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON assistant_conversation FOR EACH ROW EXECUTE FUNCTION assistant_audit_row();
--> statement-breakpoint
CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON memory_item FOR EACH ROW EXECUTE FUNCTION assistant_audit_row();
--> statement-breakpoint

-- ---- Privileges -----------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON assistant_conversation, assistant_message, memory_item TO ams_app;
--> statement-breakpoint
-- The worker reads a person's conversation, adds and updates the assistant's own message in it (never a person's message,
-- never the conversation), and reads memory. It cannot write memory_item at all.
GRANT SELECT ON assistant_conversation, memory_item TO ams_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON assistant_message TO ams_worker;
--> statement-breakpoint
GRANT UPDATE (parts, status, error, usage) ON assistant_message TO ams_worker;
--> statement-breakpoint

-- ---- Rules ----------------------------------------------------------------------------------------------------------
-- The worker writes only assistant messages, and only while the turn is still going: a turn that ended (done, failed, or
-- cancelled by the person) stays as it is. It cannot cancel a turn (that is the person's button).
CREATE FUNCTION assistant_message_worker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'ams_worker' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.role <> 'assistant' THEN
      RAISE EXCEPTION 'the worker adds only assistant messages' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF OLD.role <> 'assistant' THEN
      RAISE EXCEPTION 'the worker changes only assistant messages' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status IN ('done', 'failed', 'cancelled') THEN
      RAISE EXCEPTION 'this assistant turn has ended (%); the worker cannot change it', OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status = 'cancelled' THEN
      RAISE EXCEPTION 'only the person can cancel a turn' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER c_worker_guard BEFORE INSERT OR UPDATE ON assistant_message FOR EACH ROW EXECUTE FUNCTION assistant_message_worker_guard();
--> statement-breakpoint

-- Nothing may store empty text as memory (the limit of length is a CHECK constraint).
CREATE FUNCTION memory_item_text_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.text IS NULL OR btrim(NEW.text, E' \t\r\n') = '' THEN
    RAISE EXCEPTION 'a memory cannot be empty' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER b_text_guard BEFORE INSERT OR UPDATE ON memory_item FOR EACH ROW EXECUTE FUNCTION memory_item_text_guard();
--> statement-breakpoint

-- Deleting a standard, a version or an engagement archives the memory written about it instead of leaving it orphaned.
CREATE FUNCTION memory_archive_scope() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE memory_item SET archived_at = now() WHERE scope_id = OLD.id AND archived_at IS NULL;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER memory_archive AFTER DELETE ON framework FOR EACH ROW EXECUTE FUNCTION memory_archive_scope();
--> statement-breakpoint
CREATE TRIGGER memory_archive AFTER DELETE ON framework_version FOR EACH ROW EXECUTE FUNCTION memory_archive_scope();
--> statement-breakpoint
CREATE TRIGGER memory_archive AFTER DELETE ON engagement FOR EACH ROW EXECUTE FUNCTION memory_archive_scope();
--> statement-breakpoint

-- (New functions are executable by default; the restricted ones of migration 0046 must stay restricted, so no blanket GRANT here.)

-- ---- The audited administrator path ---------------------------------------------------------------------------------
-- An administrator (ai:manage is held by the admin role) may read other people's conversations for audit, and ONLY through
-- these two functions, which check the role, stay inside the tenant, and write an audit_event row for every read. The
-- normal list never includes other people's conversations.
CREATE FUNCTION assistant_audit_conversations(p_user uuid DEFAULT NULL, p_limit integer DEFAULT 100)
RETURNS SETOF assistant_conversation LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_admin() THEN
    RAISE EXCEPTION 'only an administrator can read other people''s conversations' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO audit_event (institution_id, actor_id, actor_type, action, target_type, target_id, before, after, created_by, updated_by)
  VALUES (app_institution_id(), app_user_id(), 'user', 'assistant_audit_list', 'assistant_conversation', p_user, NULL,
          jsonb_build_object('user_id', p_user), app_user_id(), app_user_id());
  RETURN QUERY SELECT * FROM assistant_conversation c
    WHERE c.institution_id = app_institution_id() AND (p_user IS NULL OR c.user_id = p_user)
    ORDER BY c.updated_at DESC LIMIT least(greatest(p_limit, 1), 500);
END $$;
--> statement-breakpoint
CREATE FUNCTION assistant_audit_messages(p_conversation uuid)
RETURNS SETOF assistant_message LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_admin() THEN
    RAISE EXCEPTION 'only an administrator can read other people''s conversations' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM assistant_conversation c WHERE c.id = p_conversation AND c.institution_id = app_institution_id()) THEN
    RAISE EXCEPTION 'conversation not found' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO audit_event (institution_id, actor_id, actor_type, action, target_type, target_id, before, after, created_by, updated_by)
  VALUES (app_institution_id(), app_user_id(), 'user', 'assistant_audit_read', 'assistant_conversation', p_conversation, NULL,
          jsonb_build_object('conversation_id', p_conversation), app_user_id(), app_user_id());
  RETURN QUERY SELECT * FROM assistant_message m WHERE m.conversation_id = p_conversation AND m.institution_id = app_institution_id()
    ORDER BY m.created_at;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION assistant_audit_conversations(uuid, integer), assistant_audit_messages(uuid) FROM PUBLIC, ams_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION assistant_audit_conversations(uuid, integer), assistant_audit_messages(uuid) TO ams_app;
