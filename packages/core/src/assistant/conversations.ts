// Conversations of the in-app assistant: kept per person, deletable by that person (DEC-027). The API only stores messages and
// queues the `assistant` job; the model is called by the job (assistant/turn.ts), never here.
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { assistantConversation, assistantMessage, job } from '@ams/db';
import {
  ASSISTANT_TURNS_PER_HOUR, AssistantContextSchema, AssistantUsageSchema, parseParts,
  type AssistantContext, type AssistantConversation, type AssistantMessage, type AssistantStatus,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, RateLimitError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assistantReadiness } from '../ai/settings.js';
import { enqueueJob } from '../jobs/jobs.js';
import { validateContext } from './context.js';

type ConversationRow = typeof assistantConversation.$inferSelect;
type MessageRow = typeof assistantMessage.$inferSelect;

export const DEFAULT_TITLE = 'New chat';
/** A turn that has not moved for this long is treated as dead (a crashed worker), so it no longer blocks a new message. */
export const STALE_TURN_MS = 10 * 60 * 1000;

const parseContext = (raw: unknown): AssistantContext | null => {
  const r = AssistantContextSchema.safeParse(raw);
  return r.success ? r.data : null;
};

export const conversationDto = (r: ConversationRow): AssistantConversation => ({
  id: r.id, title: r.title, context: parseContext(r.context), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  archivedAt: r.archivedAt?.toISOString() ?? null,
});

export const messageDto = (r: MessageRow): AssistantMessage => {
  const usage = AssistantUsageSchema.safeParse(r.usage);
  return {
    id: r.id, conversationId: r.conversationId, role: r.role as AssistantMessage['role'], parts: parseParts(r.parts),
    status: r.status as AssistantMessage['status'], error: r.error, usage: usage.success ? usage.data : null,
    context: parseContext(r.context), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
};

/** The first words of the first message, as the title: one line, at a word boundary, at most 60 characters. */
export function autoTitle(text: string): string {
  const line = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!line) return DEFAULT_TITLE;
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

async function ownConversation(ctx: Ctx, id: string): Promise<ConversationRow> {
  // Row-level security keeps this to the person's own conversations: someone else's id is simply not found.
  const [row] = await ctx.tx.select().from(assistantConversation).where(eq(assistantConversation.id, id));
  if (!row) throw new NotFoundError('that conversation does not exist');
  return row;
}

/** Whether the assistant can be used now and why not, for the panel. Any signed-in person may ask; it reads settings only. */
export async function getAssistantStatus(ctx: Ctx): Promise<AssistantStatus> {
  const r = await assistantReadiness(ctx);
  return r.ok
    ? { available: true, reason: null, message: null, turnsPerHour: ASSISTANT_TURNS_PER_HOUR }
    : { available: false, reason: r.reason, message: r.message, turnsPerHour: ASSISTANT_TURNS_PER_HOUR };
}

export async function listConversations(ctx: Ctx): Promise<AssistantConversation[]> {
  const rows = await ctx.tx.select().from(assistantConversation).where(isNull(assistantConversation.archivedAt))
    .orderBy(desc(assistantConversation.updatedAt)).limit(200);
  return rows.map(conversationDto);
}

export async function getConversation(ctx: Ctx, id: string): Promise<AssistantConversation & { messages: AssistantMessage[] }> {
  const row = await ownConversation(ctx, id);
  const msgs = await ctx.tx.select().from(assistantMessage).where(eq(assistantMessage.conversationId, id)).orderBy(asc(assistantMessage.createdAt), asc(assistantMessage.id));
  return { ...conversationDto(row), messages: msgs.map(messageDto) };
}

export async function renameConversation(ctx: Ctx, id: string, title: string): Promise<AssistantConversation> {
  assertHuman(ctx);
  await ownConversation(ctx, id);
  const [row] = await ctx.tx.update(assistantConversation).set({ title: title.trim() }).where(eq(assistantConversation.id, id)).returning();
  return conversationDto(row!);
}

/** Deletes the person's own conversation and, with it, every message. Memory they confirmed from it stays (it is theirs). */
export async function deleteConversation(ctx: Ctx, id: string): Promise<void> {
  assertHuman(ctx);
  await ownConversation(ctx, id);
  await ctx.tx.delete(assistantConversation).where(eq(assistantConversation.id, id));
}

/** Messages changed after a moment, for the panel's polling while a turn runs. `cursor` is the newest change seen. */
export async function messagesSince(ctx: Ctx, conversationId: string, after?: string): Promise<{ messages: AssistantMessage[]; cursor: string | null }> {
  await ownConversation(ctx, conversationId);
  const rows = await ctx.tx.select().from(assistantMessage).where(and(
    eq(assistantMessage.conversationId, conversationId),
    // The cursor is in milliseconds; the column has microseconds, so compare at the cursor's precision.
    after ? sql`date_trunc('milliseconds', ${assistantMessage.updatedAt}) > ${new Date(after).toISOString()}::timestamptz` : undefined,
  )).orderBy(asc(assistantMessage.createdAt), asc(assistantMessage.id));
  const newest = rows.reduce<number>((n, r) => Math.max(n, r.updatedAt.getTime()), after ? new Date(after).getTime() : 0);
  return { messages: rows.map(messageDto), cursor: newest ? new Date(newest).toISOString() : null };
}

/** How many assistant turns the person started in the last hour (the job rows outlive a deleted conversation). */
export async function turnsInLastHour(ctx: Ctx, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 60 * 60 * 1000);
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(job)
    .where(and(eq(job.type, 'assistant'), eq(job.createdBy, ctx.caller.userId ?? '00000000-0000-0000-0000-000000000000'), gt(job.createdAt, since)));
  return r?.n ?? 0;
}

export interface SentTurn { conversation: AssistantConversation; userMessage: AssistantMessage; assistantMessage: AssistantMessage }

/**
 * A person's message: stores it with its context chips (checked against what they may read), adds the assistant's placeholder
 * (queued) and queues the `assistant` job. Refused when the assistant is off or not set up, when a turn of this conversation is
 * still running, or when the person has used their turns for the hour.
 */
export async function sendMessage(ctx: Ctx, conversationId: string, input: { text: string; context?: unknown }): Promise<SentTurn> {
  assertHuman(ctx);
  const conv = await ownConversation(ctx, conversationId);
  const ready = await assistantReadiness(ctx);
  if (!ready.ok) throw new ConflictError(ready.message, { reason: ready.reason });
  const text = input.text.normalize('NFC').trim();
  const used = await turnsInLastHour(ctx);
  if (used >= ASSISTANT_TURNS_PER_HOUR) {
    throw new RateLimitError(`You have reached ${ASSISTANT_TURNS_PER_HOUR} assistant questions for this hour. Try again a little later.`);
  }
  const running = await ctx.tx.select({ id: assistantMessage.id, updatedAt: assistantMessage.updatedAt }).from(assistantMessage)
    .where(and(eq(assistantMessage.conversationId, conversationId), inArray(assistantMessage.status, ['queued', 'running'])));
  if (running.some((m) => Date.now() - m.updatedAt.getTime() < STALE_TURN_MS)) {
    throw new ConflictError('The assistant is still answering the last question. Wait for it, or press Stop.');
  }
  const context = await validateContext(ctx, input.context);
  const [userRow] = await ctx.tx.insert(assistantMessage).values({
    institutionId: ctx.caller.institutionId, conversationId, role: 'user', parts: [{ id: crypto.randomUUID(), type: 'text', text }], context,
  }).returning();
  const [asstRow] = await ctx.tx.insert(assistantMessage).values({
    institutionId: ctx.caller.institutionId, conversationId, role: 'assistant', status: 'queued', parts: [],
    // One transaction gives both rows the same timestamp; the reply is stamped just after the question so the order is stable.
    createdAt: new Date(userRow!.createdAt.getTime() + 1),
  }).returning();
  const [convRow] = await ctx.tx.update(assistantConversation).set({
    updatedAt: new Date(), ...(conv.title === DEFAULT_TITLE ? { title: autoTitle(text) } : {}), ...(context ? { context } : {}),
  }).where(eq(assistantConversation.id, conversationId)).returning();
  await enqueueJob(ctx, { type: 'assistant', payload: { conversationId, userMessageId: userRow!.id, assistantMessageId: asstRow!.id } });
  return { conversation: conversationDto(convRow!), userMessage: messageDto(userRow!), assistantMessage: messageDto(asstRow!) };
}

/** Starts a conversation, with its first turn when a first message comes with it. */
export async function createConversation(ctx: Ctx, input: { title?: string; text?: string; context?: unknown } = {}): Promise<{
  conversation: AssistantConversation; userMessage: AssistantMessage | null; assistantMessage: AssistantMessage | null;
}> {
  assertHuman(ctx);
  const context = await validateContext(ctx, input.context);
  const [row] = await ctx.tx.insert(assistantConversation).values({
    institutionId: ctx.caller.institutionId, userId: ctx.caller.userId!, title: input.title?.trim() || DEFAULT_TITLE, context,
  }).returning();
  if (!input.text) return { conversation: conversationDto(row!), userMessage: null, assistantMessage: null };
  const turn = await sendMessage(ctx, row!.id, { text: input.text, ...(context ? { context } : {}) });
  return turn;
}

/**
 * Stops a turn that is queued or running (best effort: the job checks between steps). What was written so far stays. Only the
 * conversation's owner can, and only while the turn is going.
 */
export async function cancelMessage(ctx: Ctx, messageId: string): Promise<AssistantMessage> {
  assertHuman(ctx);
  const [msg] = await ctx.tx.select().from(assistantMessage).where(eq(assistantMessage.id, messageId));
  if (!msg || msg.role !== 'assistant') throw new NotFoundError('that message does not exist');
  if (msg.status !== 'queued' && msg.status !== 'running') return messageDto(msg);
  const [row] = await ctx.tx.update(assistantMessage).set({ status: 'cancelled' })
    .where(and(eq(assistantMessage.id, messageId), inArray(assistantMessage.status, ['queued', 'running']))).returning();
  return messageDto(row ?? msg);
}

// ---- The audited administrator path --------------------------------------------------------------------------------------
type AuditConversationRow = { id: string; user_id: string; title: string; context: unknown; created_at: Date; updated_at: Date; archived_at: Date | null };

/**
 * Conversations of other people, for audit. Administrators only (the database function checks the role itself), and every call
 * is recorded in the audit trail. The normal list never includes other people's conversations.
 */
export async function auditListConversations(ctx: Ctx, opts: { userId?: string; limit?: number } = {}) {
  const res = await ctx.tx.execute<AuditConversationRow>(sql`select * from assistant_audit_conversations(${opts.userId ?? null}::uuid, ${opts.limit ?? 100}::int)`);
  const names = new Map<string, string>();
  if (res.rows.length) {
    const users = await ctx.tx.execute<{ id: string; full_name: string }>(sql`select id, full_name from app_user where id in (${sql.join([...new Set(res.rows.map((r) => r.user_id))].map((u) => sql`${u}::uuid`), sql`, `)})`);
    for (const u of users.rows) names.set(u.id, u.full_name);
  }
  return res.rows.map((r) => ({
    id: r.id, userId: r.user_id, userName: names.get(r.user_id) ?? null, title: r.title, context: parseContext(r.context),
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
  }));
}

type AuditMessageRow = {
  id: string; conversation_id: string; role: string; parts: unknown; status: string | null; error: string | null; usage: unknown; context: unknown; created_at: Date; updated_at: Date;
};
export async function auditReadMessages(ctx: Ctx, conversationId: string): Promise<AssistantMessage[]> {
  const res = await ctx.tx.execute<AuditMessageRow>(sql`select * from assistant_audit_messages(${conversationId}::uuid)`);
  return res.rows.map((r) => messageDto({
    id: r.id, conversationId: r.conversation_id, role: r.role, parts: r.parts, status: r.status, error: r.error, usage: r.usage, context: r.context,
    createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at), institutionId: ctx.caller.institutionId, createdBy: null, updatedBy: null,
  } as MessageRow));
}
