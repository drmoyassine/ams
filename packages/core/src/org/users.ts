import { asc, eq } from 'drizzle-orm';
import { appUser } from '@ams/db';
import type { UserSummary } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { assertPermitted } from '../permissions.js';

/** Active people of the institution, for choosing a lead, member, owner or reviewer. */
export async function listUsers(ctx: Ctx): Promise<UserSummary[]> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const rows = await ctx.tx.select({ id: appUser.id, fullName: appUser.fullName, email: appUser.email }).from(appUser).where(eq(appUser.active, true)).orderBy(asc(appUser.fullName));
  return rows;
}
