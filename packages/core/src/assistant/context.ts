// The "context chips" a message carries (where the person is) and how they are checked and described. A chip is only a hint
// about what the person is looking at: it is validated against the person's read permissions so a message can never be used
// to name something they cannot open, and it never grants anything.
import { and, eq, inArray } from 'drizzle-orm';
import { accreditor, engagement, framework, frameworkVersion, requirement } from '@ams/db';
import type { AssistantContext } from '@ams/shared';
import { AssistantContextSchema, ASSISTANT_MAX_SELECTED } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../ctx.js';
import { isPermitted } from '../permissions.js';
import { versionName } from './scope.js';

/** Parses and checks a context from a request. Returns the cleaned context (or null when there is none). */
export async function validateContext(ctx: Ctx, raw: unknown): Promise<AssistantContext | null> {
  if (raw === undefined || raw === null) return null;
  const parsed = AssistantContextSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('the context is not valid', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const c = parsed.data;
  if (c.versionId) {
    if (!(await isPermitted(ctx.tx, 'framework:read', { type: 'any' }))) throw new ForbiddenError('you cannot open standards, so the assistant cannot be pointed at one');
    const [v] = await ctx.tx.select({ id: frameworkVersion.id }).from(frameworkVersion).where(eq(frameworkVersion.id, c.versionId));
    if (!v) throw new NotFoundError('that version does not exist');
  }
  if (c.engagementId) {
    const [e] = await ctx.tx.select({ id: engagement.id }).from(engagement).where(eq(engagement.id, c.engagementId));
    if (!e) throw new NotFoundError('that engagement does not exist');
    if (!(await isPermitted(ctx.tx, 'engagement:read', { type: 'engagement', id: c.engagementId }))) throw new ForbiddenError('you cannot open that engagement');
  }
  if (c.selectedIds?.length) {
    if (!c.versionId) throw new ValidationError('selected items need the version they belong to');
    const ids = [...new Set(c.selectedIds)];
    if (ids.length > ASSISTANT_MAX_SELECTED) throw new ValidationError(`at most ${ASSISTANT_MAX_SELECTED} selected items can be shared`);
    const found = await ctx.tx.select({ id: requirement.id }).from(requirement).where(and(inArray(requirement.id, ids), eq(requirement.frameworkVersionId, c.versionId)));
    if (found.length !== ids.length) throw new ValidationError('some selected items are not in that version');
    c.selectedIds = ids;
  }
  return c;
}

/**
 * The context as the model reads it: where the person is, with the ids the tools take. Labelled as the person's screen state;
 * titles inside it come from the standards and are data.
 */
export async function describeContext(ctx: Ctx, context: AssistantContext | null | undefined): Promise<string> {
  if (!context) return 'The person\'s screen: no context was shared.';
  const lines: string[] = ['The person\'s screen (context chips they can remove; the ids are for your tools):'];
  if (context.versionId) {
    const [v] = await ctx.tx.select({ id: frameworkVersion.id, edition: frameworkVersion.edition, status: frameworkVersion.status, short: accreditor.shortName, fw: framework.name })
      .from(frameworkVersion).innerJoin(framework, eq(framework.id, frameworkVersion.frameworkId)).innerJoin(accreditor, eq(accreditor.id, framework.accreditorId))
      .where(eq(frameworkVersion.id, context.versionId));
    if (v) lines.push(`- version: ${versionName(v.short, v.edition)} (${v.status}) of ${v.fw}; versionId ${v.id}`);
  }
  if (context.engagementId) {
    const [e] = await ctx.tx.select({ id: engagement.id, title: engagement.title }).from(engagement).where(eq(engagement.id, context.engagementId));
    if (e) lines.push(`- engagement: ${e.title}; engagementId ${e.id}`);
  }
  if (context.tab) lines.push(`- tab: ${context.tab}`);
  if (context.route) lines.push(`- page: ${context.route}`);
  if (context.selectedIds?.length && context.versionId) {
    const rows = await ctx.tx.select({ id: requirement.id, code: requirement.code, title: requirement.title }).from(requirement)
      .where(and(inArray(requirement.id, context.selectedIds), eq(requirement.frameworkVersionId, context.versionId)));
    lines.push(`- ${rows.length} selected item${rows.length === 1 ? '' : 's'}:`);
    for (const r of rows.slice(0, 20)) lines.push(`  · ${r.code} ${r.title.replace(/\s+/g, ' ').slice(0, 120)} (requirementId ${r.id})`);
    if (rows.length > 20) lines.push(`  · and ${rows.length - 20} more`);
  }
  return lines.length === 1 ? 'The person\'s screen: no context was shared.' : lines.join('\n');
}
