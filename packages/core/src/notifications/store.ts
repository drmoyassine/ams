// In-app notifications (TASK-088): the rows and the internal way to create one. Row-level security shows a person only their
// own rows, so reading, marking read and dismissing need no extra filter here, only the caller's id for a clear "not found".
import { and, eq } from 'drizzle-orm';
import { notification } from '@ams/db';
import type { Ctx } from '../ctx.js';

export type NotificationKind = typeof notification.$inferInsert['kind'];
export interface NewNotification { userId: string; kind: NotificationKind; title: string; body: string; refKind?: string; refId?: string }

/**
 * Internal: services notify the person a decision is about. There is no route that creates a notification. The row is not read
 * back (row-level security lets a person read only their own, and this one is usually for someone else).
 */
export async function createNotification(ctx: Ctx, n: NewNotification): Promise<string> {
  const id = crypto.randomUUID();
  await ctx.tx.insert(notification).values({
    id, institutionId: ctx.caller.institutionId, userId: n.userId, kind: n.kind, title: n.title, body: n.body, refKind: n.refKind ?? null, refId: n.refId ?? null,
  });
  return id;
}

/** Removes the caller's own notices about one thing (a link that was resubmitted needs no "rejected" notice any more). */
export async function dismissFor(ctx: Ctx, refKind: string, refId: string): Promise<void> {
  if (!ctx.caller.userId) return;
  await ctx.tx.delete(notification).where(and(eq(notification.refKind, refKind), eq(notification.refId, refId), eq(notification.userId, ctx.caller.userId)));
}
