-- Engagement members are role assignments scoped to the engagement (PRD 4, 6.1). Until now only an admin could write
-- role_assignment. These policies let an engagement's lead and co-lead manage its members, and let whoever creates an
-- engagement set its lead, without opening role_assignment to anyone else.

-- A person holds at most one role in a given engagement.
CREATE UNIQUE INDEX role_assignment_engagement_member_idx ON role_assignment (user_id, scope_id) WHERE scope_type = 'engagement';
--> statement-breakpoint

-- Who may add, change or remove an engagement-scoped role: an admin; the engagement's lead; its co-lead (but only
-- roles other than engagement_lead, so a co-lead cannot reassign the lead); or the person creating the engagement,
-- in that same transaction (created_at is the transaction start), so they can set its lead.
CREATE FUNCTION app_can_manage_engagement_roles(p_engagement uuid, p_role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM engagement e
    WHERE e.id = p_engagement AND e.institution_id = app_institution_id()
      AND (
        app_is_admin()
        OR (e.created_by = app_user_id() AND e.created_at = now())
        OR EXISTS (
          SELECT 1 FROM role_assignment ra
          WHERE ra.user_id = app_user_id() AND ra.scope_type = 'engagement' AND ra.scope_id = e.id
            AND (ra.role = 'engagement_lead' OR (ra.role = 'co_lead' AND p_role <> 'engagement_lead')))))
$$;
--> statement-breakpoint
CREATE POLICY engagement_members_read ON role_assignment FOR SELECT
  USING (institution_id = app_institution_id() AND scope_type = 'engagement' AND app_can_access_engagement_id(scope_id));
--> statement-breakpoint
CREATE POLICY engagement_members_write ON role_assignment FOR ALL
  USING (institution_id = app_institution_id() AND scope_type = 'engagement' AND app_can_manage_engagement_roles(scope_id, role))
  WITH CHECK (institution_id = app_institution_id() AND scope_type = 'engagement' AND app_can_manage_engagement_roles(scope_id, role));
