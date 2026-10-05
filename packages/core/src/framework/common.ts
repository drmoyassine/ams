import { eq } from 'drizzle-orm';
import { frameworkVersion, requirement, sourceDocument } from '@ams/db';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError } from '../ctx.js';
import { assertPermitted } from '../permissions.js';
import type { Permission } from '@ams/shared';

export const institutionScope = { type: 'institution' } as const;
/**
 * Writing framework content needs the permission across the institution. Reading it needs the permission anywhere: the
 * library is shared reference material, and a program coordinator creating an engagement must be able to choose a
 * published framework version (row-level security still limits everything to their institution).
 */
export const require_ = (ctx: Ctx, permission: Permission) =>
  assertPermitted(ctx, permission, permission === 'framework:read' ? { type: 'any' } : institutionScope);

/** The caller must be a person: the AI never writes, promotes or approves framework content (PRD 6.3, 6.9 #7). */
export function assertHuman(ctx: Ctx): void {
  if (ctx.caller.actorType === 'ai' || ctx.caller.userId === null) {
    throw new ConflictError('only a signed-in person can do this');
  }
}

export async function getVersion(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(frameworkVersion).where(eq(frameworkVersion.id, id));
  if (!row) throw new NotFoundError(`framework version ${id}`);
  return row;
}

/** A version that can still be edited: friendlier than waiting for the database trigger to refuse. */
export async function getDraftVersion(ctx: Ctx, id: string) {
  const v = await getVersion(ctx, id);
  if (v.status === 'published' || v.status === 'retired') {
    throw new ConflictError(`framework version is ${v.status} and immutable; create a new version`);
  }
  return v;
}

export async function getRequirement(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(requirement).where(eq(requirement.id, id));
  if (!row) throw new NotFoundError(`requirement ${id}`);
  return row;
}

export async function getSourceDocument(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(sourceDocument).where(eq(sourceDocument.id, id));
  if (!row) throw new NotFoundError(`source document ${id}`);
  return row;
}

/** Any edit to approved content returns it to review. */
export const unreviewed = { reviewStatus: 'pending' as const, reviewedBy: null, reviewedAt: null };
