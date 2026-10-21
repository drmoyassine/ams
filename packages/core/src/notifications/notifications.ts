// "My notifications": what people were told in the app about things they proposed (TASK-088). Each person reads, marks read and
// dismisses only their own (row-level security by user). Email comes with SMTP (TASK-061).
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { evidenceCollectionRun, evidenceItem, evidenceLink, notification } from '@ams/db';
import type { Notification } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { NotFoundError } from '../ctx.js';
import { describeLinks } from '../evidence/evidence.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';

/** My notifications, unread first, newest first within each; a link notice carries the link as it is now. */
export async function listMyNotifications(ctx: Ctx): Promise<Notification[]> {
  await assertPermitted(ctx, 'evidence:read', { type: 'any' });
  if (!ctx.caller.userId) return [];
  const rows = await ctx.tx.select().from(notification).where(eq(notification.userId, ctx.caller.userId))
    .orderBy(sql`${notification.readAt} is not null`, desc(notification.createdAt), asc(notification.id));
  const linkIds = [...new Set(rows.filter((r) => r.refKind === 'evidence_link' && r.refId).map((r) => r.refId!))];
  const links = linkIds.length ? await describeLinks(ctx, await ctx.tx.select().from(evidenceLink).where(inArray(evidenceLink.id, linkIds))) : [];
  const byId = new Map(links.map((l) => [l.id, l]));
  const runIds = [...new Set(rows.filter((r) => r.refKind === 'collection_run' && r.refId).map((r) => r.refId!))];
  const runs = new Map((runIds.length ? await ctx.tx.select({ id: evidenceCollectionRun.id, item: evidenceCollectionRun.evidenceItemId, title: evidenceItem.title, period: evidenceCollectionRun.periodLabel, status: evidenceCollectionRun.status })
    .from(evidenceCollectionRun).innerJoin(evidenceItem, eq(evidenceItem.id, evidenceCollectionRun.evidenceItemId)).where(inArray(evidenceCollectionRun.id, runIds)) : [])
    .map((x) => [x.id, { id: x.id, evidenceItemId: x.item, evidenceTitle: x.title, periodLabel: x.period, status: x.status }]));
  return rows.map((r) => ({
    id: r.id, kind: r.kind, title: r.title, body: r.body, refKind: r.refKind, refId: r.refId, readAt: r.readAt ? r.readAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(), link: r.refKind === 'evidence_link' && r.refId ? byId.get(r.refId) ?? null : null,
    run: r.refKind === 'collection_run' && r.refId ? runs.get(r.refId) ?? null : null,
  }));
}

export async function markNotificationRead(ctx: Ctx, id: string): Promise<void> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:read', { type: 'any' });
  const rows = await ctx.tx.update(notification).set({ readAt: new Date() })
    .where(and(eq(notification.id, id), eq(notification.userId, me(ctx, id)))).returning({ id: notification.id });
  if (!rows.length) throw new NotFoundError(`notification ${id}`);
}

export async function dismissNotification(ctx: Ctx, id: string): Promise<void> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:read', { type: 'any' });
  const rows = await ctx.tx.delete(notification)
    .where(and(eq(notification.id, id), eq(notification.userId, me(ctx, id)))).returning({ id: notification.id });
  if (!rows.length) throw new NotFoundError(`notification ${id}`);
}

/** The caller's id; a system identity has no notifications. */
function me(ctx: Ctx, id: string): string {
  if (!ctx.caller.userId) throw new NotFoundError(`notification ${id}`);
  return ctx.caller.userId;
}
