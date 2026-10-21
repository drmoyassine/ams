// Evidence collection runs for people (TASK-090): list them, "Run now", skip a period with a reason, retry a failed one, mark one supplied by
// choosing an existing version. The scheduler's own work is in execute.ts and tick.ts. Reading needs evidence:read; every change needs
// evidence:write and a person (the worker cannot skip, and the AMS never lets a system identity decide that a period does not count).
import { timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { appUser, evidenceCollectionRun, evidenceItem, evidenceRequest, evidenceVersion } from '@ams/db';
import {
  SkipRunSchema, SupplyRunSchema, type CollectionConfig, type CollectionRun, type CollectionRunsQuery, type CollectionRunStatus, type Schedule, type SkipRun, type SupplyRun,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../ctx.js';
import { calendarEntries } from '../cycles/calendar.js';
import { plusDays } from '../cycles/recurrence.js';
import { getItem } from '../evidence/evidence.js';
import { localDate, nextOccurrences, startOfLocalDay, type Occurrence } from '../evidence/schedule.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import type { BiRuntime } from './bi-client.js';
import { dueDay, executeRun, hashCallbackToken, lockRun, scheduleOf, supplyRunFromBody, type RunRow } from './execute.js';
import { markRunSupplied } from './hook.js';

const any = { type: 'any' } as const;
const DAY = 86_400_000;
export interface CollectDeps { bi: BiRuntime; now?: () => Date }
const clock = (d?: CollectDeps) => (d?.now ?? (() => new Date()))();

const noBi: BiRuntime = { config: { baseUrl: null, apiKey: null, endpoints: {}, publicUrl: null, production: false }, client: null };

/** What the server can tell the screens about the BI (never a secret). */
export function collectionConfig(bi: BiRuntime | undefined): CollectionConfig {
  const c = (bi ?? noBi).config;
  return { bi: { configured: !!c.baseUrl && !!(bi ?? noBi).client, endpointKeys: Object.keys(c.endpoints).sort(), callbackConfigured: !!c.publicUrl } };
}

// ---- Reading ---------------------------------------------------------------------------------------------------------------------------

async function describeRuns(ctx: Ctx, rows: RunRow[]): Promise<CollectionRun[]> {
  if (!rows.length) return [];
  const items = new Map((await ctx.tx.select().from(evidenceItem).where(inArray(evidenceItem.id, [...new Set(rows.map((r) => r.evidenceItemId))]))).map((i) => [i.id, i]));
  const ownerIds = [...new Set([...items.values()].map((i) => i.ownerUserId).filter((x): x is string => !!x))];
  const owners = new Map((ownerIds.length ? await ctx.tx.select({ id: appUser.id, name: appUser.fullName }).from(appUser).where(inArray(appUser.id, ownerIds)) : []).map((u) => [u.id, u.name]));
  const versionIds = rows.map((r) => r.versionId).filter((x): x is string => !!x);
  const versions = new Map((versionIds.length ? await ctx.tx.select({ id: evidenceVersion.id, n: evidenceVersion.versionNo }).from(evidenceVersion).where(inArray(evidenceVersion.id, versionIds)) : []).map((v) => [v.id, v.n]));
  const requests = new Map<string, { id: string; account: boolean }>();
  for (const r of await ctx.tx.select({ id: evidenceRequest.id, run: evidenceRequest.collectionRunId, user: evidenceRequest.assigneeUserId }).from(evidenceRequest)
    .where(inArray(evidenceRequest.collectionRunId, rows.map((r) => r.id))).orderBy(asc(evidenceRequest.createdAt))) {
    if (r.run) requests.set(r.run, { id: r.id, account: !!r.user });
  }
  return rows.flatMap((r) => {
    const item = items.get(r.evidenceItemId);
    if (!item) return [];
    const req = requests.get(r.id);
    return [{
      id: r.id, evidenceItemId: r.evidenceItemId, evidenceTitle: item.title, evidenceType: item.type, method: item.method,
      ownerUserId: item.ownerUserId, ownerName: item.ownerUserId ? owners.get(item.ownerUserId) ?? null : null,
      periodLabel: r.periodLabel, periodStart: r.scheduledFor, periodEnd: r.periodEnd, dueAt: r.dueAt.toISOString(), dueDate: dueDay(r, item), status: r.status, trigger: r.trigger,
      versionId: r.versionId, versionNo: r.versionId ? versions.get(r.versionId) ?? null : null,
      requestedAt: r.requestedAt?.toISOString() ?? null, respondedAt: r.respondedAt?.toISOString() ?? null, attempts: r.attempts, lastError: r.lastError,
      skipReason: r.skipReason, nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null, requestId: req?.id ?? null, requestHasAccount: req ? req.account : null,
      createdAt: r.createdAt.toISOString(),
    }];
  });
}

async function describeOne(ctx: Ctx, id: string): Promise<CollectionRun> {
  const [row] = await ctx.tx.select().from(evidenceCollectionRun).where(eq(evidenceCollectionRun.id, id));
  if (!row) throw new NotFoundError(`collection run ${id}`);
  return (await describeRuns(ctx, [row]))[0]!;
}

/** Runs the caller may see, filtered; open and late ones first, then newest period first. */
export async function listCollectionRuns(ctx: Ctx, q: CollectionRunsQuery = {}): Promise<CollectionRun[]> {
  await assertPermitted(ctx, 'evidence:read', any);
  const statuses = q.status ? q.status.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const bad = statuses.filter((s) => !['pending', 'requested', 'supplied', 'late', 'failed', 'skipped'].includes(s));
  if (bad.length) throw new ValidationError(`unknown status ${bad.join(', ')}`);
  if (q.dueBefore && Number.isNaN(Date.parse(q.dueBefore))) throw new ValidationError('dueBefore is a date and time');
  const mine = q.mine === 'true';
  if (mine && !ctx.caller.userId) return [];
  const rows = await ctx.tx.select({ run: evidenceCollectionRun }).from(evidenceCollectionRun)
    .innerJoin(evidenceItem, eq(evidenceItem.id, evidenceCollectionRun.evidenceItemId))
    .where(and(
      statuses.length ? inArray(evidenceCollectionRun.status, statuses as CollectionRunStatus[]) : undefined,
      q.itemId ? eq(evidenceCollectionRun.evidenceItemId, q.itemId) : undefined,
      q.ownerId ? eq(evidenceItem.ownerUserId, q.ownerId) : undefined,
      mine ? eq(evidenceItem.ownerUserId, ctx.caller.userId!) : undefined,
      q.dueBefore ? lte(evidenceCollectionRun.dueAt, new Date(q.dueBefore)) : undefined,
    ))
    .orderBy(sql`${evidenceCollectionRun.status} in ('supplied', 'skipped')`, desc(evidenceCollectionRun.scheduledFor), desc(evidenceCollectionRun.createdAt))
    .limit(q.limit ?? 200);
  return describeRuns(ctx, rows.map((r) => r.run));
}

/** The runs of one evidence item, newest period first. */
export async function runsOfItem(ctx: Ctx, itemId: string): Promise<CollectionRun[]> {
  await assertPermitted(ctx, 'evidence:read', any);
  await getItem(ctx, itemId);
  const rows = await ctx.tx.select().from(evidenceCollectionRun).where(eq(evidenceCollectionRun.evidenceItemId, itemId)).orderBy(desc(evidenceCollectionRun.scheduledFor));
  return describeRuns(ctx, rows);
}

// ---- Changing -------------------------------------------------------------------------------------------------------------------------

/** The period "Run now" makes a run for: the latest period of the schedule that has begun, else today. */
async function currentPeriod(ctx: Ctx, schedule: Schedule | null, now: Date) {
  const tz = schedule?.timezone ?? 'UTC';
  const today = localDate(now, tz);
  if (schedule) {
    const terms = schedule.every === 'semester' ? await calendarEntries(ctx) : [];
    const from = new Date(now.getTime() - (schedule.every === 'semester' ? 800 : 400) * DAY);
    const started = nextOccurrences(schedule, from, 500, terms).occurrences.filter((o: Occurrence) => Date.parse(o.at) <= now.getTime());
    const occ = started[started.length - 1];
    if (occ) return { scheduledFor: occ.date, label: occ.label, dueAt: new Date(occ.dueAt), periodEnd: null as string | null };
  }
  return { scheduledFor: today, label: today, dueAt: startOfLocalDay(plusDays(today, 1), tz), periodEnd: today };
}

/**
 * "Run now": makes the run for today's period (the schedule's current one, or today when there is none or it has not begun) and carries it out
 * at once. If that period already has a run: a failed one is tried again; any other is refused, saying what it is.
 */
export async function runNow(ctx: Ctx, itemId: string, deps: CollectDeps): Promise<CollectionRun> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  const item = await getItem(ctx, itemId);
  if (item.status !== 'active') throw new ConflictError('this evidence is archived');
  if (item.method === 'survey') throw new ValidationError('collecting by survey is not available yet');
  const now = clock(deps);
  const period = await currentPeriod(ctx, scheduleOf(item), now);
  const [existing] = await ctx.tx.select().from(evidenceCollectionRun).where(and(eq(evidenceCollectionRun.evidenceItemId, itemId), eq(evidenceCollectionRun.scheduledFor, period.scheduledFor)));
  if (existing) {
    if (existing.status !== 'failed') throw new ConflictError(`There is already a run for ${existing.periodLabel}: it is ${existing.status}.`);
    await executeRun(ctx, existing.id, now, deps.bi);
    return describeOne(ctx, existing.id);
  }
  const [row] = await guardIntegrity(() => ctx.tx.insert(evidenceCollectionRun).values({
    institutionId: ctx.caller.institutionId, evidenceItemId: itemId, periodLabel: period.label, scheduledFor: period.scheduledFor, periodEnd: period.periodEnd,
    dueAt: period.dueAt, trigger: 'manual',
  }).returning());
  await executeRun(ctx, row!.id, now, deps.bi);
  return describeOne(ctx, row!.id);
}

async function openRun(ctx: Ctx, id: string) {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  const [row] = await ctx.tx.select().from(evidenceCollectionRun).where(eq(evidenceCollectionRun.id, id));
  if (!row) throw new NotFoundError(`collection run ${id}`);
  return row;
}

/** Skip a period, with the reason; its open request (if it sent one) is cancelled. A supplied or skipped run is final. */
export async function skipRun(ctx: Ctx, id: string, input: SkipRun): Promise<CollectionRun> {
  const row = await openRun(ctx, id);
  const d = SkipRunSchema.parse(input);
  if (row.status === 'supplied' || row.status === 'skipped') throw new ConflictError(`this period is already ${row.status}`);
  await guardIntegrity(() => ctx.tx.update(evidenceCollectionRun).set({ status: 'skipped', skipReason: d.reason, respondedAt: new Date(), nextAttemptAt: null }).where(eq(evidenceCollectionRun.id, id)));
  await ctx.tx.update(evidenceRequest).set({ status: 'cancelled', tokenHash: null }).where(and(eq(evidenceRequest.collectionRunId, id), eq(evidenceRequest.status, 'open')));
  return describeOne(ctx, id);
}

/** Try a failed run again, now (the attempts counted so far stay; a person may retry after the automatic attempts are used up). */
export async function retryRun(ctx: Ctx, id: string, deps: CollectDeps): Promise<CollectionRun> {
  const row = await openRun(ctx, id);
  if (row.status !== 'failed') throw new ConflictError('only a failed period can be tried again');
  await executeRun(ctx, id, clock(deps), deps.bi);
  return describeOne(ctx, id);
}

/** Mark a run supplied by an existing version of the same evidence item (its own upload, say, or one a colleague added). */
export async function supplyRunWithVersion(ctx: Ctx, id: string, input: SupplyRun): Promise<CollectionRun> {
  const row = await openRun(ctx, id);
  const d = SupplyRunSchema.parse(input);
  if (row.status === 'supplied' || row.status === 'skipped') throw new ConflictError(`this period is already ${row.status}`);
  const [v] = await ctx.tx.select({ item: evidenceVersion.evidenceItemId }).from(evidenceVersion).where(eq(evidenceVersion.id, d.versionId));
  if (!v || v.item !== row.evidenceItemId) throw new ValidationError('choose a version of this evidence item');
  await guardIntegrity(() => markRunSupplied(ctx, id, d.versionId, new Date(), { source: 'chosen' }));
  return describeOne(ctx, id);
}

// ---- The BI's callback -----------------------------------------------------------------------------------------------------------------

/**
 * Checks a callback token against what a run stored: the hashes are compared in constant time, and the token must not have expired. Used by
 * the callback route before anything else; it says only yes or no (the route answers 401 to every no, so nothing is learnt from the reason).
 */
export function callbackTokenValid(stored: { tokenHash: string | null; expiresAt: Date | null }, token: string, now: Date): boolean {
  if (!stored.tokenHash || !stored.expiresAt || stored.expiresAt.getTime() <= now.getTime() || !token) return false;
  const a = Buffer.from(hashCallbackToken(token), 'hex');
  const b = Buffer.from(stored.tokenHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The BI supplies a run through its callback (`POST /api/bi/v0/runs/{id}/supply`, authenticated by the run's one-time token and nothing
 * else). The token is checked again inside the transaction against the locked row, so two calls at once cannot both succeed: the first
 * supplies the run (which clears the token), the second finds none. A body that does not fit the item is a ValidationError (the route
 * answers 422 with the issues) and changes nothing, and the token stays valid for another try.
 */
export async function supplyByCallback(ctx: Ctx, runId: string, token: string, body: unknown, now: Date = new Date()): Promise<CollectionRun> {
  const run = await lockRun(ctx, runId).catch(() => { throw new NotFoundError(`collection run ${runId}`); });
  if (!callbackTokenValid({ tokenHash: run.callbackTokenHash, expiresAt: run.callbackExpiresAt }, token, now)) throw new ForbiddenError('this token has been used, has expired or is not valid');
  if (run.status !== 'requested' && run.status !== 'late') throw new ConflictError(`this period is ${run.status}; it is not waiting for a supply`);
  await supplyRunFromBody(ctx, run, body, 'callback', now);
  return describeOne(ctx, runId);
}

