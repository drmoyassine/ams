// Making and carrying out evidence collection runs (TASK-090, DEC-031). Everything here is internal: no permission check, because the callers
// are the scheduler (a system identity with the worker's database role) and the services of runs.ts, which check who may ask. Every function
// takes `(ctx, ...)` and is safe to run twice: a period has one run (a unique key), a run that has begun is not begun again, and a
// notice is sent once (a flag in the run's details).
//
// A run's life:  pending -> requested (the BI was asked, the request sent, the form opened) -> supplied | late | failed | skipped.
//   bi       asks the BI over HTTP (bi-client.ts). 200: the answer is the supply. 202: wait for its callback with the run's one-time token.
//            An error or timeout fails the run; the scheduler tries again with a growing delay, five attempts in all, then the owner is told.
//   request  sends the evidence request (DEC-018) for this run; its answer is a new version of the item.
//   form     opens the dataset's online form; adding responses to the data (a new version) supplies the run.
//   manual   tells the owner (My work); their next new version of the item supplies the run.
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { appUser, datasetSpec, evidenceCollectionRun, evidenceItem, evidenceRequest, evidenceVersion } from '@ams/db';
import {
  BI_CALLBACK_DAYS, BI_DEFAULT_TIMEOUT_SECONDS, BI_NOT_CONFIGURED, BiSupplyBodySchema, MAX_COLLECTION_ATTEMPTS, ScheduleSchema, nextAttemptAfter, validateRows,
  type BiCollectRequest, type BiQuery, type BiSupplyBody, type DataColumn, type Schedule,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ValidationError } from '../ctx.js';
import { plusDays } from '../cycles/recurrence.js';
import { calendarEntries } from '../cycles/calendar.js';
import { MAX_UPLOAD_BYTES, storeFileVersion } from '../evidence/evidence.js';
import { insertDataVersion } from '../evidence/dataset.js';
import { nextDue, nextOccurrences, type CalendarTerm, type Occurrence } from '../evidence/schedule.js';
import { createNotification } from '../notifications/store.js';
import { BiCallError, resolveBiUrl, type BiCall, type BiRuntime } from './bi-client.js';
import { markRunSupplied } from './hook.js';

export type RunRow = typeof evidenceCollectionRun.$inferSelect;
type ItemRow = typeof evidenceItem.$inferSelect;
const DAY = 86_400_000;

/** The SHA-256 (hex) of a callback token: the only form in which it is stored. */
export const hashCallbackToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

export const scheduleOf = (item: Pick<ItemRow, 'schedule'>): Schedule | null => {
  if (item.schedule == null) return null;
  const p = ScheduleSchema.safeParse(item.schedule);
  return p.success ? p.data : null;
};

const iso = (d: Date) => d.toISOString();
const patchDetails = (patch: Record<string, unknown>) => sql`${evidenceCollectionRun.details} || ${JSON.stringify(patch)}::jsonb`;
const detailsOf = (run: Pick<RunRow, 'details'>) => (run.details ?? {}) as Record<string, unknown>;

// ---- Making the runs ---------------------------------------------------------------------------------------------------------------

/**
 * The occurrences of a schedule that have started by `now` and have no run yet as far as `lastRunAt` knows. The first time (no last run)
 * only the period that is current is made: a schedule that began years ago never creates years of runs. After that, every period that
 * began since the last time. A period is never made before the schedule's start date, and a semester the academic calendar does not define
 * makes nothing (the gap stays visible on the item).
 */
export function startedOccurrences(schedule: Schedule, lastRunAt: Date | null, now: Date, terms: readonly CalendarTerm[]): Occurrence[] {
  const lookbackDays = schedule.every === 'semester' ? 800 : 400;
  const from = lastRunAt ? new Date(lastRunAt.getTime() + 1) : new Date(now.getTime() - lookbackDays * DAY);
  const count = Math.min(500, Math.ceil((now.getTime() - from.getTime()) / DAY) + 2);
  const started = nextOccurrences(schedule, from, count, terms).occurrences.filter((o) => Date.parse(o.at) <= now.getTime());
  return lastRunAt ? started : started.slice(-1);
}

/** The last day of the period that begins with `occ`: the day before the next one, or the end of the calendar term. */
function periodEndOf(schedule: Schedule, occ: Occurrence, terms: readonly CalendarTerm[]): string | null {
  if (schedule.every === 'semester') return terms.find((t) => t.kind === 'term' && t.start === occ.date)?.end ?? null;
  const next = nextOccurrences(schedule, new Date(Date.parse(occ.at) + 1), 1, terms).occurrences[0];
  return next ? plusDays(next.date, -1) : null;
}

/**
 * Makes the runs of every active scheduled item that are due as of `now` (one per item and period; the unique key makes a second tick
 * a no-op), and keeps each item's `last_run_at` and `next_due_at` current. A calendar that changed moves a semester item's next due time
 * here too. Items a person cannot see (restricted) are not seen by the system identity and so are not collected by the scheduler.
 */
export async function createDueRuns(ctx: Ctx, now: Date): Promise<{ created: number; items: number }> {
  const items = await ctx.tx.select().from(evidenceItem)
    .where(and(eq(evidenceItem.status, 'active'), isNotNull(evidenceItem.schedule), ne(evidenceItem.method, 'survey')));
  const scheduled = items.map((item) => ({ item, schedule: scheduleOf(item) })).filter((x): x is { item: ItemRow; schedule: Schedule } => !!x.schedule);
  const terms: CalendarTerm[] = scheduled.some((x) => x.schedule.every === 'semester') ? await calendarEntries(ctx) : [];
  let created = 0;
  for (const { item, schedule } of scheduled) {
    const started = startedOccurrences(schedule, item.lastRunAt, now, terms);
    for (const occ of started) {
      const rows = await ctx.tx.insert(evidenceCollectionRun).values({
        institutionId: item.institutionId, evidenceItemId: item.id, periodLabel: occ.label, scheduledFor: occ.date, periodEnd: periodEndOf(schedule, occ, terms),
        dueAt: new Date(occ.dueAt), trigger: 'schedule',
      }).onConflictDoNothing().returning({ id: evidenceCollectionRun.id });
      created += rows.length;
    }
    const due = nextDue(schedule, now, terms).dueAt;
    const nextDueAt = due ? new Date(due) : null;
    const changed = (nextDueAt?.getTime() ?? null) !== (item.nextDueAt?.getTime() ?? null);
    if (started.length || changed) {
      await ctx.tx.update(evidenceItem).set({ ...(started.length ? { lastRunAt: now } : {}), nextDueAt }).where(eq(evidenceItem.id, item.id));
    }
  }
  return { created, items: scheduled.length };
}

/** A run that is past its due time and not supplied becomes `late`, and its owner is told once. */
export async function markLateRuns(ctx: Ctx, now: Date): Promise<number> {
  const runs = await ctx.tx.select().from(evidenceCollectionRun)
    .where(and(inArray(evidenceCollectionRun.status, ['pending', 'requested']), lte(evidenceCollectionRun.dueAt, now)))
    .orderBy(asc(evidenceCollectionRun.dueAt)).for('update');
  for (const run of runs) {
    await ctx.tx.update(evidenceCollectionRun).set({ status: 'late', details: patchDetails({ notifiedLate: iso(now) }) }).where(eq(evidenceCollectionRun.id, run.id));
    if (!detailsOf(run).notifiedLate) {
      const item = await itemOf(ctx, run.evidenceItemId);
      await tell(ctx, item, run, 'collection_late', `${item.title} is late for ${run.periodLabel}`, `"${item.title}" was due for ${run.periodLabel} and has not been supplied.`);
    }
  }
  return runs.length;
}

/** Runs that are ready to be carried out: new ones, and failed ones whose next attempt has come. */
export async function executableRunIds(ctx: Ctx, now: Date): Promise<string[]> {
  const rows = await ctx.tx.select({ id: evidenceCollectionRun.id }).from(evidenceCollectionRun).where(or(
    and(eq(evidenceCollectionRun.status, 'pending'), isNull(sql`${evidenceCollectionRun.details} ->> 'startedAt'`)),
    and(eq(evidenceCollectionRun.status, 'failed'), isNotNull(evidenceCollectionRun.nextAttemptAt), lte(evidenceCollectionRun.nextAttemptAt, now), sql`${evidenceCollectionRun.attempts} < ${MAX_COLLECTION_ATTEMPTS}`),
  )).orderBy(asc(evidenceCollectionRun.scheduledFor), asc(evidenceCollectionRun.createdAt));
  return rows.map((r) => r.id);
}

// ---- Carrying a run out ------------------------------------------------------------------------------------------------------------

async function itemOf(ctx: Ctx, id: string): Promise<ItemRow> {
  const [item] = await ctx.tx.select().from(evidenceItem).where(eq(evidenceItem.id, id));
  if (!item) throw new Error(`evidence item ${id} is not visible`);
  return item;
}
export async function lockRun(ctx: Ctx, id: string): Promise<RunRow> {
  const [run] = await ctx.tx.select().from(evidenceCollectionRun).where(eq(evidenceCollectionRun.id, id)).for('update');
  if (!run) throw new Error(`collection run ${id} is not visible`);
  return run;
}

/** Tells a person (the item's owner, else whoever added it) about a run; one notice per call, the caller guards repeats. */
async function tell(ctx: Ctx, item: ItemRow, run: RunRow, kind: 'collection_due' | 'collection_late' | 'collection_failed', title: string, body: string, userId?: string | null) {
  const to = userId ?? item.ownerUserId ?? item.createdBy;
  if (!to) return;
  await createNotification(ctx, { userId: to, kind, title, body, refKind: 'collection_run', refId: run.id });
}

/** The day a run is due as a person in the item's time zone reads it (the due instant is the end of that day). */
export const dueDay = (run: Pick<RunRow, 'dueAt'>, item: Pick<ItemRow, 'schedule'>) => {
  const tz = scheduleOf(item)?.timezone ?? 'UTC';
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(run.dueAt.getTime() - 1)); } catch { return run.dueAt.toISOString().slice(0, 10); }
};

/** What `beginRun` found to do outside the database: nothing, or a call to the BI. */
export type Plan = { kind: 'none' } | { kind: 'bi'; call: BiCall };
export type Outcome = { kind: 'supplied'; body: unknown } | { kind: 'accepted' } | { kind: 'error'; message: string; retryable: boolean };

/**
 * Fails a run: the reason is kept, the attempts counted, and (for a BI call that may be tried again) the next attempt scheduled with a growing
 * delay. When there is no next attempt the owner is told, once.
 */
export async function failRun(ctx: Ctx, runId: string, message: string, retryable: boolean, now: Date): Promise<void> {
  const run = await lockRun(ctx, runId);
  if (run.status === 'supplied' || run.status === 'skipped') return;
  const attempts = run.attempts + 1;
  const next = retryable ? nextAttemptAfter(attempts, now) : null;
  const text = message.slice(0, 1000);
  await ctx.tx.update(evidenceCollectionRun).set({
    status: 'failed', attempts, lastError: text, nextAttemptAt: next, respondedAt: now,
    ...(!next ? { details: patchDetails({ notifiedFailed: iso(now) }) } : {}),
  }).where(eq(evidenceCollectionRun.id, runId));
  if (!next && !detailsOf(run).notifiedFailed) {
    const item = await itemOf(ctx, run.evidenceItemId);
    await tell(ctx, item, run, 'collection_failed', `Collecting ${item.title} for ${run.periodLabel} failed`, `${text} Open the evidence item to retry or skip this period.`);
  }
}

/**
 * Starts a run: does everything the method needs that is a database matter, and for the BI returns the call to make. A run that is not
 * waiting to start (already begun, supplied, skipped) returns `none` and changes nothing, so a second tick or a double click does nothing.
 * `human` is a person's retry: it may start a failed run whose attempts are used up.
 */
export async function beginRun(ctx: Ctx, runId: string, now: Date, bi: BiRuntime): Promise<Plan> {
  const run = await lockRun(ctx, runId);
  const fresh = run.status === 'pending' && !detailsOf(run).startedAt;
  if (!fresh && run.status !== 'failed') return { kind: 'none' };
  const item = await itemOf(ctx, run.evidenceItemId);
  if (item.status !== 'active') return { kind: 'none' };
  const started = { startedAt: iso(now) };
  const fail = async (message: string, retryable: boolean): Promise<Plan> => { await failRun(ctx, runId, message, retryable, now); return { kind: 'none' }; };

  switch (item.method) {
    case 'manual': {
      // The owner is told once and the run waits for their next version (the hook in the version services supplies it).
      await ctx.tx.update(evidenceCollectionRun).set({ details: patchDetails({ ...started, notifiedDue: iso(now) }) }).where(eq(evidenceCollectionRun.id, runId));
      const cfg = item.methodConfig as { instructions?: string; expectedFormat?: string };
      await tell(ctx, item, run, 'collection_due', `Supply ${item.title} for ${run.periodLabel}`,
        `"${item.title}" is due for ${run.periodLabel} (${dueDay(run, item)}).${cfg.instructions ? ` ${cfg.instructions}` : ''}${cfg.expectedFormat ? ` Expected format: ${cfg.expectedFormat}.` : ''}`);
      return { kind: 'none' };
    }
    case 'form': {
      const [spec] = await ctx.tx.select().from(datasetSpec).where(eq(datasetSpec.evidenceItemId, item.id));
      if (!spec || !((spec.columns as unknown[]) ?? []).length) return fail('The dataset has no columns yet: they are the questions of the online form. Define them, then retry.', false);
      if (!spec.formOpen) await ctx.tx.update(datasetSpec).set({ formOpen: true }).where(eq(datasetSpec.id, spec.id));
      await ctx.tx.update(evidenceCollectionRun).set({ status: 'requested', requestedAt: now, lastError: null, nextAttemptAt: null, details: patchDetails({ ...started, notifiedDue: iso(now) }) }).where(eq(evidenceCollectionRun.id, runId));
      await tell(ctx, item, run, 'collection_due', `Fill in ${item.title} for ${run.periodLabel}`,
        `The online form of "${item.title}" is open for ${run.periodLabel} (due ${dueDay(run, item)}). Add the responses to the data when they are in.`);
      return { kind: 'none' };
    }
    case 'request': {
      const cfg = item.methodConfig as { assigneeUserId?: string; assigneeEmail?: string; note?: string };
      let assignee: { id: string | null; email: string } | null = null;
      if (cfg.assigneeUserId) {
        const [u] = await ctx.tx.select({ id: appUser.id, email: appUser.email }).from(appUser).where(and(eq(appUser.id, cfg.assigneeUserId), eq(appUser.active, true)));
        assignee = u ? { id: u.id, email: u.email.toLowerCase() } : null;
        if (!assignee) return fail('The person this item asks is not an active person of the institution any more. Choose someone else in the item.', false);
      } else if (cfg.assigneeEmail) {
        const email = cfg.assigneeEmail.toLowerCase();
        const [u] = await ctx.tx.select({ id: appUser.id }).from(appUser).where(and(sql`lower(${appUser.email}) = ${email}`, eq(appUser.active, true)));
        assignee = { id: u?.id ?? null, email };
      }
      if (!assignee) return fail('The item names nobody to ask. Choose a person or an email address in the item.', false);
      // A dataset is asked for through its form (the answers join the data when someone adds them); a document by a file.
      let dataItemId: string | null = null;
      if (item.type === 'dataset') {
        const [spec] = await ctx.tx.select({ columns: datasetSpec.columns }).from(datasetSpec).where(eq(datasetSpec.evidenceItemId, item.id));
        if (!spec || !((spec.columns as unknown[]) ?? []).length) return fail('The dataset has no columns yet: they are the questions of the request. Define them, then retry.', false);
        dataItemId = item.id;
      }
      const message = [cfg.note, item.definition].filter((x): x is string => !!x).join('\n\n') || null;
      const [req] = await ctx.tx.insert(evidenceRequest).values({
        institutionId: item.institutionId, collectionRunId: run.id, dataItemId, title: `${item.title} · ${run.periodLabel}`, message, assigneeEmail: assignee.email,
        assigneeUserId: assignee.id, dueDate: dueDay(run, item), requestedBy: ctx.caller.userId ?? null,
      }).returning({ id: evidenceRequest.id });
      await ctx.tx.update(evidenceCollectionRun).set({ status: 'requested', requestedAt: now, lastError: null, nextAttemptAt: null, details: patchDetails({ ...started, requestId: req!.id, notifiedDue: iso(now) }) }).where(eq(evidenceCollectionRun.id, runId));
      if (assignee.id && assignee.id !== (item.ownerUserId ?? item.createdBy)) {
        await tell(ctx, item, run, 'collection_due', `Please supply ${item.title} for ${run.periodLabel}`, `You were asked for "${item.title}" for ${run.periodLabel} (due ${dueDay(run, item)}). Answer from your requests.`, assignee.id);
      }
      await tell(ctx, item, run, 'collection_due', `Asked for ${item.title} for ${run.periodLabel}`,
        assignee.id ? `The request was sent to ${assignee.email}, who answers in the AMS.`
          : `The request is waiting for ${assignee.email}, who has no account here. Email is not sent yet: open the request and copy its link to send it yourself.`);
      return { kind: 'none' };
    }
    case 'bi': {
      const cfg = item.methodConfig as { endpointKey?: string; query?: BiQuery; period?: Schedule['every']; timeoutSeconds?: number };
      let url: string;
      try { url = resolveBiUrl(bi.config, cfg.endpointKey); } catch (e) {
        return fail(e instanceof BiCallError ? e.message : BI_NOT_CONFIGURED, e instanceof BiCallError ? e.retryable : false);
      }
      if (!bi.client) return fail(BI_NOT_CONFIGURED, false);
      if (!bi.config.publicUrl) return fail('APP_PUBLIC_URL is not set, so the BI would not know where to call back.', false);
      let columns: DataColumn[] | undefined;
      if (item.type === 'dataset') {
        const [spec] = await ctx.tx.select({ columns: datasetSpec.columns }).from(datasetSpec).where(eq(datasetSpec.evidenceItemId, item.id));
        columns = ((spec?.columns ?? []) as DataColumn[]);
        if (!columns.length) return fail('The dataset has no columns yet: the BI\'s answer is checked against them. Define them, then retry.', false);
      }
      const token = newToken();
      const body: BiCollectRequest = {
        runId: run.id, ...(cfg.endpointKey ? { endpoint: cfg.endpointKey } : {}),
        evidence: { id: item.id, title: item.title, type: item.type, definition: item.definition, ...(columns ? { columns } : {}) },
        period: { label: run.periodLabel, start: run.scheduledFor, end: run.periodEnd },
        query: cfg.query ? { metric: cfg.query.metric, ...(cfg.query.dimensions ? { dimensions: cfg.query.dimensions } : {}), ...(cfg.query.filters ? { filters: cfg.query.filters } : {}), ...(cfg.period ? { grain: cfg.period } : {}) } : null,
        callbackUrl: `${bi.config.publicUrl.replace(/\/+$/, '')}/api/bi/v0/runs/${run.id}/supply`, callbackToken: token,
      };
      await ctx.tx.update(evidenceCollectionRun).set({
        status: 'requested', requestedAt: now, lastError: null, nextAttemptAt: null, callbackTokenHash: hashCallbackToken(token),
        callbackExpiresAt: new Date(now.getTime() + BI_CALLBACK_DAYS * DAY), details: patchDetails({ ...started, accepted: false }),
      }).where(eq(evidenceCollectionRun.id, runId));
      return { kind: 'bi', call: { url, apiKey: bi.config.apiKey, body, timeoutMs: (cfg.timeoutSeconds ?? BI_DEFAULT_TIMEOUT_SECONDS) * 1000 } };
    }
    default:
      // survey: reserved, makes no run (and a run made by a person's mistake is simply left alone).
      return fail('This way of collecting is not available yet.', false);
  }
}

/** Makes the call the plan asks for. Never throws: a refusal, an error or a timeout is the outcome. Holds no database transaction. */
export async function callBi(plan: Extract<Plan, { kind: 'bi' }>, bi: BiRuntime): Promise<Outcome> {
  try {
    if (!bi.client) throw new BiCallError(BI_NOT_CONFIGURED, false);
    const r = await bi.client.collect(plan.call);
    return r.status === 202 ? { kind: 'accepted' } : { kind: 'supplied', body: r.body };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e), retryable: e instanceof BiCallError ? e.retryable : true };
  }
}

/** Records what the BI answered. A run supplied or skipped in the meantime (the callback may have come first) is left alone. */
export async function finishRun(ctx: Ctx, runId: string, outcome: Outcome, now: Date): Promise<void> {
  const run = await lockRun(ctx, runId);
  if (run.status !== 'requested' && run.status !== 'late') return;
  if (outcome.kind === 'error') return failRun(ctx, runId, outcome.message, outcome.retryable, now);
  if (outcome.kind === 'accepted') {
    await ctx.tx.update(evidenceCollectionRun).set({ details: patchDetails({ accepted: true }) }).where(eq(evidenceCollectionRun.id, runId));
    return;
  }
  try {
    await supplyRunFromBody(ctx, run, outcome.body, 'bi', now);
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    const first = e.issues[0];
    await failRun(ctx, runId, `The BI's answer was refused: ${e.message}${first ? ` (${first.path}: ${first.message})` : ''}`, true, now);
  }
}

/** Begin, call and finish in the caller's transaction (a person's "Run now" and "Retry" use this; the scheduler splits the three). */
export async function executeRun(ctx: Ctx, runId: string, now: Date, bi: BiRuntime): Promise<void> {
  const plan = await beginRun(ctx, runId, now, bi);
  if (plan.kind === 'bi') await finishRun(ctx, runId, await callBi(plan, bi), now);
}

// ---- The supply --------------------------------------------------------------------------------------------------------------------

/**
 * Turns the BI's answer (the body of its 200, or of its callback) into the run's evidence version and marks the run supplied. The answer is
 * checked first and nothing is written unless it fits: a dataset's rows against the item's columns, a file against the size limit, an
 * address against https. The version records the origin `bi`, the date it is true as of and the BI's own lineage; the BI's words never
 * overwrite the AMS's (they sit under `lineage.bi`).
 */
export async function supplyRunFromBody(ctx: Ctx, run: RunRow, rawBody: unknown, source: 'bi' | 'callback', now: Date): Promise<void> {
  const parsed = BiSupplyBodySchema.safeParse(rawBody);
  if (!parsed.success) throw new ValidationError('the supply does not fit', parsed.error.issues.map((i) => ({ path: i.path.join('.') || 'body', message: i.message })));
  const d: BiSupplyBody = parsed.data;
  const item = await itemOf(ctx, run.evidenceItemId);
  const asOfDate = d.asOf.slice(0, 10);
  const lineage = { origin: 'bi', source_kind: 'bi', run_id: run.id, via: source, supplied_by: null, saved_at: iso(now), as_of: d.asOf, ...(d.lineage ? { bi: d.lineage } : {}) };
  let versionId: string;
  if (item.type === 'dataset') {
    if (!d.rows) throw new ValidationError('the supply does not fit', [{ path: 'rows', message: 'this evidence is a dataset: send its rows' }]);
    const [spec] = await ctx.tx.select({ columns: datasetSpec.columns }).from(datasetSpec).where(eq(datasetSpec.evidenceItemId, item.id));
    const columns = (spec?.columns ?? []) as DataColumn[];
    if (!columns.length) throw new ValidationError('the supply does not fit', [{ path: 'rows', message: 'the dataset has no columns to check the rows against' }]);
    const { rows, issues } = validateRows(columns, d.rows);
    if (issues.length) throw new ValidationError(`${issues.length} cell${issues.length === 1 ? ' needs' : 's need'} attention`, issues.slice(0, 200).map((i) => ({ path: `rows.${i.row}.${i.key}`, message: i.message })));
    if (!rows.length) throw new ValidationError('the supply does not fit', [{ path: 'rows', message: 'there are no rows' }]);
    const v = await insertDataVersion(ctx, item.id, columns, rows, { notes: d.notes ?? `Supplied by the BI for ${run.periodLabel}`, sourceKind: 'bi', asOfDate, extra: lineage });
    versionId = v.id;
  } else if (d.rows) {
    throw new ValidationError('the supply does not fit', [{ path: 'rows', message: 'this evidence is a document: send a file or an address' }]);
  } else if (d.url) {
    const [last] = await ctx.tx.select({ n: evidenceVersion.versionNo }).from(evidenceVersion).where(eq(evidenceVersion.evidenceItemId, item.id)).orderBy(sql`${evidenceVersion.versionNo} desc`).limit(1);
    const [v] = await ctx.tx.insert(evidenceVersion).values({
      institutionId: item.institutionId, evidenceItemId: item.id, versionNo: (last?.n ?? 0) + 1, url: d.url, asOfDate, notes: d.notes ?? `Supplied by the BI for ${run.periodLabel}`, lineage,
    }).returning({ id: evidenceVersion.id });
    versionId = v!.id;
  } else {
    const bytes = Buffer.from(d.fileBase64!, 'base64');
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new ValidationError('the supply does not fit', [{ path: 'fileBase64', message: `the file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB` }]);
    if (bytes.byteLength === 0) throw new ValidationError('the supply does not fit', [{ path: 'fileBase64', message: 'the file is empty' }]);
    const v = await storeFileVersion(ctx, item.id, {
      fileName: d.fileName!, mime: d.mime ?? 'application/octet-stream', bytes: new Uint8Array(bytes), asOfDate, ...(d.notes ? { notes: d.notes } : { notes: `Supplied by the BI for ${run.periodLabel}` }),
    }, { lineage, system: true });
    versionId = v.id;
  }
  await markRunSupplied(ctx, run.id, versionId, now, { source });
}
