-- The history of an engagement's rows (the requirement workspace's "History", the roadmap's change log) is readable by
-- anyone who can see that engagement. audit_event stays append-only and admin-wide-readable otherwise (PRD 6.9 #8).
-- The engagement a row belongs to is the row itself, or the engagement_id inside its before/after image.
CREATE FUNCTION app_can_read_audit_of(p_target_type text, p_target_id uuid, p_before jsonb, p_after jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_target_type = 'engagement' THEN app_can_access_engagement_id(p_target_id)
    WHEN p_target_type IN ('milestone', 'engagement_requirement')
      THEN app_can_access_engagement_id((coalesce(p_after, p_before) ->> 'engagement_id')::uuid)
    ELSE false
  END
$$;
--> statement-breakpoint
CREATE POLICY engagement_history_read ON audit_event FOR SELECT
  USING (institution_id = app_institution_id() AND app_can_read_audit_of(target_type, target_id, before, after));
