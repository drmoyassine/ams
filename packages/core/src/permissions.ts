import { sql } from 'drizzle-orm';
import { ROLE_PERMISSIONS, type Permission, type Role, type Scope } from '@ams/shared';
import type { Tx } from '@ams/db';
import { ForbiddenError, type Ctx } from './ctx.js';

type Grant = {
  role: Role;
  scope_type: 'institution' | 'org_unit' | 'program' | 'engagement';
  scope_id: string;
};

async function activeGrants(tx: Tx): Promise<Grant[]> {
  const res = await tx.execute<Grant>(sql`
    select role, scope_type, scope_id from role_assignment
    where user_id = app_user_id() and (expires_at is null or expires_at > now())`);
  return res.rows;
}

/** Ids of an org unit and all its ancestors. */
async function orgUnitChain(tx: Tx, orgUnitId: string): Promise<string[]> {
  const res = await tx.execute<{ id: string }>(sql`
    with recursive up as (
      select id, parent_id from org_unit where id = ${orgUnitId}
      union all
      select o.id, o.parent_id from org_unit o join up on o.id = up.parent_id)
    select id from up`);
  return res.rows.map((r) => r.id);
}

/** Does the caller hold `permission` for `scope`? A grant covers its own scope and everything beneath it. */
export async function isPermitted(tx: Tx, permission: Permission, scope: Scope): Promise<boolean> {
  const grants = (await activeGrants(tx)).filter((g) => ROLE_PERMISSIONS[g.role].includes(permission));
  if (grants.length === 0) return false;
  if (scope.type === 'any') return true;
  if (grants.some((g) => g.scope_type === 'institution')) return true;
  if (scope.type === 'institution') return false;

  let orgUnitId: string | undefined;
  if (scope.type === 'engagement') {
    if (grants.some((g) => g.scope_type === 'engagement' && g.scope_id === scope.id)) return true;
    // A program-scoped (or org-unit) grant covers the engagements run for that program.
    const res = await tx.execute<{ subject_type: string; subject_id: string }>(sql`select subject_type, subject_id from engagement where id = ${scope.id}`);
    const subject = res.rows[0];
    if (!subject || subject.subject_type !== 'program') return false;
    return isPermitted(tx, permission, { type: 'program', id: subject.subject_id });
  }
  if (scope.type === 'program') {
    if (grants.some((g) => g.scope_type === 'program' && g.scope_id === scope.id)) return true;
    const res = await tx.execute<{ org_unit_id: string }>(sql`select org_unit_id from program where id = ${scope.id}`);
    orgUnitId = res.rows[0]?.org_unit_id;
  } else {
    orgUnitId = scope.id;
  }
  if (!orgUnitId) return false;
  const chain = new Set(await orgUnitChain(tx, orgUnitId));
  return grants.some((g) => g.scope_type === 'org_unit' && chain.has(g.scope_id));
}

/** For services whose scope comes from the request body, after the chain's coarse check. */
export async function assertPermitted(ctx: Ctx, permission: Permission, scope: Scope): Promise<void> {
  if (!(await isPermitted(ctx.tx, permission, scope))) throw new ForbiddenError(`Missing permission ${permission}`);
}

/** Roles held by the caller (not expired), and the permissions they add up to, for the SPA to show or hide actions. */
export async function myAccess(ctx: Ctx): Promise<{ userId: string | null; institutionId: string; roles: Role[]; permissions: Permission[] }> {
  const grants = await activeGrants(ctx.tx);
  const roles = [...new Set(grants.map((g) => g.role))];
  const permissions = [...new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r]))];
  return { userId: ctx.caller.userId, institutionId: ctx.caller.institutionId, roles, permissions };
}
