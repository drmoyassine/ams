// Evidence collection runs (TASK-090, DEC-031): the scheduler makes a run per period, carries each out by the item's method (ask the BI,
// send the request, open the form, tell the owner), marks late ones, and the BI's callback token works once. No network: the BI is a fake
// client, the clock is a fake clock, and the tick runs against a real database under the worker's role.
import { withIdentity } from '@ams/db';
import { MAX_COLLECTION_ATTEMPTS, type CollectionRun, type Schedule } from '@ams/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../ctx.js';
import { ConflictError, ForbiddenError, ValidationError } from '../ctx.js';
import { createAcademicTerm } from '../cycles/calendar.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { saveDatasetSpec } from '../evidence/dataset.js';
import { addFileVersion, createEvidence, getEvidence } from '../evidence/evidence.js';
import { addResponsesToData, submitDataResponse } from '../evidence/forms.js';
import { answerEvidenceRequest, answerRequestWithForm, listEvidenceRequests, requestsForDataItem } from '../evidence/requests.js';
import { listMyNotifications } from '../notifications/notifications.js';
import { BiCallError, httpBiClient, resolveBiUrl, type BiCall, type BiCallResult, type BiClient, type BiConfig, type BiRuntime } from './bi-client.js';
import { hashCallbackToken } from './execute.js';
import { callbackTokenValid, collectionConfig, listCollectionRuns, retryRun, runNow, runsOfItem, skipRun, supplyByCallback, supplyRunWithVersion } from './runs.js';
import { collectTick } from './tick.js';

let w: World;
const bytes = (s: string) => new TextEncoder().encode(s);

// ---- A BI that answers as told, and remembers what it was asked ----------------------------------------------------------------------
class FakeBi implements BiClient {
  calls: BiCall[] = [];
  /** What the next call does: a result, or an error to throw. The last one repeats. */
  script: (BiCallResult | Error)[] = [{ status: 202 }];
  async collect(call: BiCall): Promise<BiCallResult> {
    this.calls.push(call);
    const next = this.script.length > 1 ? this.script.shift()! : this.script[0]!;
    if (next instanceof Error) throw next;
    return next;
  }
}
const config = (over: Partial<BiConfig> = {}): BiConfig => ({
  baseUrl: 'https://bi.example.org', apiKey: 'secret-key', endpoints: { warehouse: '/ams/collect/warehouse' }, publicUrl: 'https://ams.example.org/', production: true, ...over,
});
const runtime = (client: BiClient | null, over: Partial<BiConfig> = {}): BiRuntime => ({ config: config(over), client });

const DAILY: Schedule = { every: 'day', startDate: '2026-10-01', dueAfterDays: 2, timezone: 'UTC' };
let seq = 0;
async function item(over: Record<string, unknown> = {}, who = 'contrib') {
  seq += 1;
  return w.as(who, (c) => createEvidence(c, { title: `Item ${seq}`, type: 'document', schedule: DAILY, ...over } as never));
}
const tick = (at: string, bi: BiRuntime = runtime(new FakeBi())) => collectTick(w.pool, { bi, store: w.store, now: () => new Date(at) });
const runsOf = (id: string) => w.as('alo', (c) => runsOfItem(c, id));
/** The system identity the BI's callback acts as (no user). */
function sys<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const caller = { userId: null, institutionId: w.ids.inst!, requestId: crypto.randomUUID(), actorType: 'system' as const };
  return withIdentity(w.pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined, store: w.store }));
}
const notices = async (who: string, kind?: string) => (await w.as(who, (c) => listMyNotifications(c))).filter((n) => !kind || n.kind === kind);
const row = async (runId: string) => (await w.db.su.query('select * from evidence_collection_run where id = $1', [runId])).rows[0] as Record<string, unknown>;

beforeAll(async () => { w = await buildWorld('collect'); }, 120000);
// Every test makes its own items; the ones left by an earlier test are archived so a tick at a later date does not catch them up.
beforeEach(async () => { await w.db.su.query(`update evidence_item set status = 'archived' where status = 'active'`); });
/** The calls the fake BI got for one run, and the token it was given for it. */
const callsFor = (bi: FakeBi, runId: string) => bi.calls.filter((c) => c.body.runId === runId);
const tokenOf = (bi: FakeBi, runId: string) => callsFor(bi, runId)[0]!.body.callbackToken;
afterAll(() => w.close());

// ==== Making the runs ==================================================================================================================

describe('the scheduler makes a run for each period', () => {
  it('every day: only the current period at first, then one per day, and a second tick makes nothing', async () => {
    const it1 = await item();
    expect(await tick('2026-10-21T08:00:00Z')).toMatchObject({ created: 1 });
    expect((await runsOf(it1.id)).map((r) => [r.periodLabel, r.periodStart, r.status, r.trigger])).toEqual([['2026-10-21', '2026-10-21', 'pending', 'schedule']]);
    expect(await tick('2026-10-21T08:00:00Z')).toMatchObject({ created: 0 });
    expect(await tick('2026-10-21T20:00:00Z')).toMatchObject({ created: 0 });
    // The next day, and then three days at once after the worker was away.
    expect(await tick('2026-10-22T00:01:00Z')).toMatchObject({ created: 1 });
    expect(await tick('2026-10-25T09:00:00Z')).toMatchObject({ created: 3 });
    expect((await runsOf(it1.id)).map((r) => r.periodStart).sort()).toEqual(['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    // The item keeps the bookkeeping: when it last ran and when the next collection is due.
    const after = (await w.as('alo', (c) => getEvidence(c, it1.id))).item;
    expect(after.lastRunAt).toBe('2026-10-25T09:00:00.000Z');
    expect(after.nextDueAt).toBe('2026-10-26T00:00:00.000Z'); // the 23rd's period (due two days on, at the end of the 25th) is the earliest not yet due
  });

  it('every week, month, quarter and year: the period that is current, labelled and due as the schedule says', async () => {
    const week = await item({ schedule: { every: 'week', startDate: '2026-10-05', dueAfterDays: 3, timezone: 'UTC' } });
    const month = await item({ schedule: { every: 'month', startDate: '2026-01-15', dueAfterDays: 10, timezone: 'UTC' } });
    const quarter = await item({ schedule: { every: 'quarter', startDate: '2026-01-01', dueAfterDays: 30, timezone: 'UTC' } });
    const year = await item({ schedule: { every: 'year', startDate: '2025-09-01', dueAfterDays: 60, timezone: 'UTC' } });
    await tick('2026-10-21T08:00:00Z');
    const one = async (id: string) => { const r = await runsOf(id); expect(r).toHaveLength(1); return r[0]!; };
    expect(await one(week.id)).toMatchObject({ periodLabel: 'Week of 2026-10-19', periodStart: '2026-10-19', periodEnd: '2026-10-25', dueAt: '2026-10-23T00:00:00.000Z' });
    expect(await one(month.id)).toMatchObject({ periodLabel: 'Oct 2026', periodStart: '2026-10-15', periodEnd: '2026-11-14' });
    expect(await one(quarter.id)).toMatchObject({ periodStart: '2026-10-01', periodLabel: 'Oct 2026 – Dec 2026', periodEnd: '2026-12-31' });
    expect(await one(year.id)).toMatchObject({ periodStart: '2026-09-01', periodEnd: '2027-08-31' });
    // A new week, month ... only when its period starts.
    expect(await tick('2026-10-26T01:00:00Z')).toMatchObject({ created: 1 }); // the new week
    expect((await runsOf(week.id)).map((r) => r.periodStart)).toContain('2026-10-26');
    expect(await runsOf(month.id)).toHaveLength(1);
  });

  it('never before the start date: a schedule that has not begun makes nothing', async () => {
    const future = await item({ schedule: { every: 'day', startDate: '2027-02-01', dueAfterDays: 0, timezone: 'UTC' } });
    await tick('2026-10-30T08:00:00Z');
    expect(await runsOf(future.id)).toEqual([]);
  });

  it('every semester: one run per academic term as it begins; a semester the calendar does not define makes nothing', async () => {
    await w.as('admin', (c) => createAcademicTerm(c, { name: 'Fall 2026', kind: 'term', startDate: '2026-08-24', endDate: '2026-12-18' }));
    await w.as('admin', (c) => createAcademicTerm(c, { name: 'Spring 2027', kind: 'term', startDate: '2027-01-11', endDate: '2027-05-14' }));
    const sem = await item({ schedule: { every: 'semester', startDate: '2026-08-01', dueAfterDays: 14, timezone: 'UTC' } });
    await tick('2026-10-21T08:00:00Z');
    expect((await runsOf(sem.id)).map((r) => [r.periodLabel, r.periodStart, r.periodEnd])).toEqual([['Fall 2026', '2026-08-24', '2026-12-18']]);
    // Between terms nothing is made.
    expect(await tick('2027-01-05T08:00:00Z')).toMatchObject({ created: expect.any(Number) });
    expect((await runsOf(sem.id)).map((r) => r.periodLabel)).toEqual(['Fall 2026']);
    await tick('2027-01-12T08:00:00Z');
    expect((await runsOf(sem.id)).map((r) => r.periodLabel).sort()).toEqual(['Fall 2026', 'Spring 2027']);
    // Past the last term the calendar defines: no guess, no run. The gap is what the item shows.
    await tick('2027-09-15T08:00:00Z');
    expect((await runsOf(sem.id)).map((r) => r.periodLabel).sort()).toEqual(['Fall 2026', 'Spring 2027']);
  });

  it('a day is a day of the schedule\'s time zone: daylight saving never moves a period', async () => {
    const ny = await item({ schedule: { every: 'day', startDate: '2026-03-01', dueAfterDays: 0, timezone: 'America/New_York' } });
    await tick('2026-03-08T04:59:00Z'); // still 7 March in New York
    expect((await runsOf(ny.id)).map((r) => r.periodStart)).toEqual(['2026-03-07']);
    await tick('2026-03-08T05:00:00Z'); // New York's midnight (EST); the clocks go forward at 2am
    const runs = await runsOf(ny.id);
    expect(runs.map((r) => r.periodStart).sort()).toEqual(['2026-03-07', '2026-03-08']);
    // 8 March is a 23-hour day: its due time (the end of that day) is 04:00 UTC on the 9th, an hour earlier than a 24-hour day would give.
    expect(runs.find((r) => r.periodStart === '2026-03-08')!.dueAt).toBe('2026-03-09T04:00:00.000Z');
    expect(runs.find((r) => r.periodStart === '2026-03-07')!.dueAt).toBe('2026-03-08T05:00:00.000Z');
    await tick('2026-03-08T05:00:00Z');
    expect(await runsOf(ny.id)).toHaveLength(2);
  });

  it('archived items and the reserved survey method make no runs', async () => {
    const archived = await item();
    await w.db.su.query(`update evidence_item set status = 'archived' where id = $1`, [archived.id]);
    const survey = await item({ method: 'survey' } as never).catch(() => null);
    await tick('2026-11-02T08:00:00Z');
    expect(await runsOf(archived.id)).toEqual([]);
    if (survey) expect(await runsOf(survey.id)).toEqual([]);
  });
});

// ==== Carrying a run out ===============================================================================================================

describe('manual: the owner is told, and their next version supplies the run', () => {
  it('tells the owner once, shows the run as pending, and an upload by the owner supplies the oldest open run', async () => {
    const m = await item({ methodConfig: { instructions: 'Upload the signed PDF', expectedFormat: 'PDF' } });
    await tick('2026-11-10T08:00:00Z');
    await tick('2026-11-10T08:15:00Z');
    await tick('2026-11-11T08:00:00Z');
    const runs = await runsOf(m.id);
    expect(runs.map((r) => [r.periodStart, r.status]).sort()).toEqual([['2026-11-10', 'pending'], ['2026-11-11', 'pending']]);
    const mine = (await notices('contrib', 'collection_due')).filter((n) => n.title.startsWith(`Supply ${m.title} for`));
    expect(mine.map((n) => n.title).sort()).toEqual([`Supply ${m.title} for 2026-11-10`, `Supply ${m.title} for 2026-11-11`]);
    expect(mine[0]!.body).toContain('Upload the signed PDF');
    expect(mine[0]).toMatchObject({ refKind: 'collection_run' });
    const v = await w.as('contrib', (c) => addFileVersion(c, m.id, { fileName: 'policy.pdf', mime: 'application/pdf', bytes: bytes('v1') }));
    const after = await runsOf(m.id);
    expect(after.find((r) => r.periodStart === '2026-11-10')).toMatchObject({ status: 'supplied', versionId: v.id, versionNo: 1 });
    expect(after.find((r) => r.periodStart === '2026-11-11')!.status).toBe('pending');
    // The next upload supplies the next one, and a later one finds no open run and changes nothing.
    await w.as('contrib', (c) => addFileVersion(c, m.id, { fileName: 'policy.pdf', mime: 'application/pdf', bytes: bytes('v2') }));
    await w.as('contrib', (c) => addFileVersion(c, m.id, { fileName: 'policy.pdf', mime: 'application/pdf', bytes: bytes('v3') }));
    expect((await runsOf(m.id)).map((r) => r.status)).toEqual(['supplied', 'supplied']);
  });
});

describe('late: past the due time without a supply', () => {
  it('becomes late once, tells the owner once, and a late run still takes a supply', async () => {
    const l = await item({ schedule: { every: 'day', startDate: '2026-12-01', dueAfterDays: 0, timezone: 'UTC' } });
    await tick('2026-12-05T10:00:00Z');
    expect((await runsOf(l.id)).map((r) => r.status)).toEqual(['pending']);
    await tick('2026-12-05T23:59:00Z');
    expect((await runsOf(l.id)).map((r) => r.status)).toEqual(['pending']);
    await tick('2026-12-06T00:05:00Z');
    const runs = await runsOf(l.id);
    expect(runs.find((r) => r.periodStart === '2026-12-05')!.status).toBe('late');
    await tick('2026-12-06T00:20:00Z');
    await tick('2026-12-06T10:00:00Z');
    expect((await notices('contrib', 'collection_late')).filter((n) => n.title === `${l.title} is late for 2026-12-05`)).toHaveLength(1);
    await w.as('contrib', (c) => addFileVersion(c, l.id, { fileName: 'late.pdf', mime: 'application/pdf', bytes: bytes('late') }));
    expect((await runsOf(l.id)).find((r) => r.periodStart === '2026-12-05')!.status).toBe('supplied');
  });
});

describe('form: the dataset\'s form opens for the period; adding responses supplies the run', () => {
  it('opens the form, tells the owner, and a new version from the responses supplies it', async () => {
    const f = await item({ type: 'dataset', method: 'form', schedule: { ...DAILY, startDate: '2027-01-01' } });
    await w.as('contrib', (c) => saveDatasetSpec(c, f.id, { columns: [{ key: 'n', label: 'Headcount', type: 'integer', required: true }] }));
    await tick('2027-01-10T08:00:00Z');
    const [run] = await runsOf(f.id);
    expect(run).toMatchObject({ status: 'requested', method: 'form' });
    expect((await w.db.su.query('select form_open from dataset_spec where evidence_item_id = $1', [f.id])).rows[0].form_open).toBe(true);
    expect((await notices('contrib', 'collection_due')).some((n) => n.title === `Fill in ${f.title} for 2027-01-10`)).toBe(true);
    await w.as('alo', (c) => submitDataResponse(c, f.id, { answers: { n: '120' } }));
    expect((await runsOf(f.id))[0]!.status).toBe('requested'); // a response alone is not yet data
    const v = await w.as('contrib', (c) => addResponsesToData(c, f.id));
    expect((await runsOf(f.id))[0]).toMatchObject({ status: 'supplied', versionId: v.id });
  });

  it('a dataset without columns has no questions: the run fails with the reason, and does not try again by itself', async () => {
    const f = await item({ type: 'dataset', method: 'form', schedule: { ...DAILY, startDate: '2027-01-01' } });
    await tick('2027-01-10T08:00:00Z');
    expect((await runsOf(f.id))[0]).toMatchObject({ status: 'failed', attempts: 1, nextAttemptAt: null, lastError: expect.stringContaining('no columns') });
    await tick('2027-01-11T01:00:00Z');
    expect((await runsOf(f.id)).find((r) => r.periodStart === '2027-01-10')).toMatchObject({ status: 'failed', attempts: 1 });
  });
});

describe('request: the request is sent for the run; its answer is the supply', () => {
  it('a document: asks the person, who answers in the AMS with a new version of the item', async () => {
    const r = await item({ method: 'request', methodConfig: { assigneeUserId: w.ids.alo, note: 'Please send the signed copy' }, schedule: { ...DAILY, startDate: '2027-02-01' } });
    await tick('2027-02-10T08:00:00Z');
    const [run] = await runsOf(r.id);
    expect(run).toMatchObject({ status: 'requested', requestHasAccount: true });
    expect(run!.requestId).toBeTruthy();
    const mine = await w.as('alo', (c) => listEvidenceRequests(c, { mine: true }));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: run!.requestId, title: `${r.title} · 2027-02-10`, message: 'Please send the signed copy', status: 'open', assigneeHasAccount: true, evidenceItemId: r.id });
    expect((await notices('alo', 'collection_due')).some((n) => n.title === `Please supply ${r.title} for 2027-02-10`)).toBe(true);
    await tick('2027-02-10T08:15:00Z');
    expect(await w.as('alo', (c) => listEvidenceRequests(c, { mine: true }))).toHaveLength(1); // no second request
    await w.as('alo', (c) => answerEvidenceRequest(c, run!.requestId!, { fileName: 'signed.pdf', mime: 'application/pdf', bytes: bytes('signed') }, 'As approved'));
    const [done] = await runsOf(r.id);
    expect(done).toMatchObject({ status: 'supplied', versionNo: 1 });
    const detail = await w.as('alo', (c) => getEvidence(c, r.id));
    expect(detail.versions).toHaveLength(1); // a version of THIS item, not a new item
    expect(detail.versions[0]).toMatchObject({ fileName: 'signed.pdf', notes: 'As approved' });
  });

  it('an email address without an account: the request waits and the owner is told how to send its link', async () => {
    const r = await item({ method: 'request', methodConfig: { assigneeEmail: 'partner@example.com' }, schedule: { ...DAILY, startDate: '2027-02-01' } });
    await tick('2027-02-10T08:00:00Z');
    const [run] = await runsOf(r.id);
    expect(run).toMatchObject({ status: 'requested', requestHasAccount: false });
    const req = (await w.db.su.query('select * from evidence_request where id = $1', [run!.requestId])).rows[0];
    expect(req).toMatchObject({ assignee_email: 'partner@example.com', assignee_user_id: null, token_hash: null, collection_run_id: run!.id });
    expect((await notices('contrib', 'collection_due')).some((n) => n.title === `Asked for ${r.title} for 2027-02-10` && n.body.includes('has no account'))).toBe(true);
  });

  it('a dataset is asked for through its form: the answer waits until someone adds it to the data, which supplies the run', async () => {
    const r = await item({ type: 'dataset', method: 'request', methodConfig: { assigneeUserId: w.ids.second }, schedule: { ...DAILY, startDate: '2027-02-01' } });
    await w.as('contrib', (c) => saveDatasetSpec(c, r.id, { columns: [{ key: 'n', label: 'Count', type: 'integer', required: true }] }));
    await tick('2027-02-10T08:00:00Z');
    const [run] = await runsOf(r.id);
    expect(run).toMatchObject({ status: 'requested' });
    const [req] = await w.as('contrib', (c) => requestsForDataItem(c, r.id));
    expect(req).toMatchObject({ id: run!.requestId, dataItemId: r.id });
    await w.as('second', (c) => answerRequestWithForm(c, req!.id, { answers: { n: '7' } }));
    expect((await runsOf(r.id))[0]!.status).toBe('requested');
    await w.as('contrib', (c) => addResponsesToData(c, r.id));
    expect((await runsOf(r.id))[0]!.status).toBe('supplied');
  });

  it('skipping the period cancels the open request', async () => {
    const r = await item({ method: 'request', methodConfig: { assigneeUserId: w.ids.second }, schedule: { ...DAILY, startDate: '2027-02-01' } });
    await tick('2027-02-12T08:00:00Z');
    const [run] = await runsOf(r.id);
    await w.as('alo', (c) => skipRun(c, run!.id, { reason: 'Nothing changed this term' }));
    expect((await w.db.su.query('select status from evidence_request where id = $1', [run!.requestId])).rows[0].status).toBe('cancelled');
  });
});

describe('bi: the AMS asks the BI', () => {
  async function biDataset(over: Record<string, unknown> = {}) {
    const d = await item({
      type: 'dataset', method: 'bi', schedule: { ...DAILY, startDate: '2027-03-01' },
      methodConfig: { query: { metric: 'enrollment_headcount', dimensions: ['program'], filters: [{ field: 'level', op: 'eq', value: 'bachelor' }] }, period: 'month', timeoutSeconds: 30 },
      definition: 'Students enrolled per program', ...over,
    });
    await w.as('contrib', (c) => saveDatasetSpec(c, d.id, { columns: [{ key: 'program', label: 'Program', type: 'text', required: true }, { key: 'n', label: 'Headcount', type: 'integer', required: true }] }));
    return d;
  }

  it('sends the documented request and takes a synchronous answer (200) as the supply', async () => {
    const bi = new FakeBi();
    bi.script = [{ status: 200, body: { rows: [{ program: 'BSME', n: 120 }, { program: 'BSEE', n: '80' }], asOf: '2027-03-09', lineage: { steward: 'registrar', query_hash: 'abc' } } }];
    const d = await biDataset();
    await tick('2027-03-10T08:00:00Z', runtime(bi));
    expect(bi.calls).toHaveLength(1);
    const call = bi.calls[0]!;
    expect(call).toMatchObject({ url: 'https://bi.example.org/ams/collect', apiKey: 'secret-key', timeoutMs: 30_000 });
    const [run] = await runsOf(d.id);
    expect(call.body).toMatchObject({
      runId: run!.id, evidence: { id: d.id, title: d.title, type: 'dataset', definition: 'Students enrolled per program' },
      period: { label: '2027-03-10', start: '2027-03-10', end: '2027-03-10' },
      query: { metric: 'enrollment_headcount', dimensions: ['program'], filters: [{ field: 'level', op: 'eq', value: 'bachelor' }], grain: 'month' },
      callbackUrl: `https://ams.example.org/api/bi/v0/runs/${run!.id}/supply`,
    });
    expect(call.body.evidence.columns?.map((c) => c.key)).toEqual(['program', 'n']);
    expect(call.body.callbackToken.length).toBeGreaterThan(30);
    expect(run).toMatchObject({ status: 'supplied', versionNo: 1, attempts: 0 });
    const detail = await w.as('alo', (c) => getEvidence(c, d.id));
    expect(detail.versions[0]).toMatchObject({ asOfDate: '2027-03-09', rowCount: 2 });
    const stored = (await w.db.su.query('select data, lineage, as_of_date from evidence_version where id = $1', [run!.versionId])).rows[0];
    expect(stored.data.rows).toEqual([{ program: 'BSME', n: 120 }, { program: 'BSEE', n: 80 }]);
    expect(stored.lineage).toMatchObject({ origin: 'bi', run_id: run!.id, as_of: '2027-03-09', bi: { steward: 'registrar', query_hash: 'abc' } });
    // The token was used up by the supply.
    expect(await row(run!.id)).toMatchObject({ callback_token_hash: null, callback_expires_at: null });
  });

  it('a document may be supplied as a file or an address', async () => {
    const bi = new FakeBi();
    const doc = await item({ method: 'bi', schedule: { ...DAILY, startDate: '2027-03-01' }, methodConfig: { endpointKey: 'warehouse' } });
    bi.script = [{ status: 200, body: { fileBase64: Buffer.from('pdf-bytes').toString('base64'), fileName: 'report.pdf', mime: 'application/pdf', asOf: '2027-03-09' } }];
    await tick('2027-03-10T08:00:00Z', runtime(bi));
    expect(bi.calls[0]!.url).toBe('https://bi.example.org/ams/collect/warehouse');
    expect(bi.calls[0]!.body.endpoint).toBe('warehouse');
    expect(bi.calls[0]!.timeoutMs).toBe(60_000); // the default
    const [run] = await runsOf(doc.id);
    expect(run).toMatchObject({ status: 'supplied' });
    const v = (await w.as('alo', (c) => getEvidence(c, doc.id))).versions[0]!;
    expect(v).toMatchObject({ fileName: 'report.pdf', mime: 'application/pdf', size: 9, asOfDate: '2027-03-09' });
    expect(w.store.objects.size).toBeGreaterThan(0);
    bi.script = [{ status: 200, body: { url: 'https://docs.example.org/report-2', asOf: '2027-03-10T06:00:00Z' } }];
    await tick('2027-03-11T08:00:00Z', runtime(bi));
    expect((await w.as('alo', (c) => getEvidence(c, doc.id))).versions[0]).toMatchObject({ url: 'https://docs.example.org/report-2', asOfDate: '2027-03-10' });
  });

  it('202: the run waits for the BI\'s callback, which supplies it once with the run\'s token', async () => {
    const bi = new FakeBi(); // 202 by default
    const d = await biDataset();
    await tick('2027-03-12T08:00:00Z', runtime(bi));
    const [run] = await runsOf(d.id);
    expect(run).toMatchObject({ status: 'requested', requestedAt: expect.any(String) });
    const token = tokenOf(bi, run!.id);
    // Only the hash is stored, and it expires.
    const stored = await row(run!.id);
    expect(stored.callback_token_hash).toBe(hashCallbackToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect((stored.callback_expires_at as Date).getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000 - 1);
    const good = { rows: [{ program: 'BSME', n: 130 }], asOf: '2027-03-11', lineage: { by: 'bi' } };
    // The wrong token, and the token of another run, supply nothing.
    await expect(sys((c) => supplyByCallback(c, run!.id, 'not-the-token', good))).rejects.toThrow(ForbiddenError);
    const other = await biDataset();
    const bi2 = new FakeBi();
    await tick('2027-03-12T08:30:00Z', runtime(bi2));
    const otherRun = (await runsOf(other.id))[0]!;
    await expect(sys((c) => supplyByCallback(c, run!.id, tokenOf(bi2, otherRun.id), good))).rejects.toThrow(ForbiddenError);
    // A body that does not fit the columns is refused with the issues, and the token stays valid for another try.
    const bad = await sys((c) => supplyByCallback(c, run!.id, token, { rows: [{ program: 'BSME', n: 'many' }], asOf: '2027-03-11' })).catch((e: ValidationError) => e);
    expect(bad).toBeInstanceOf(ValidationError);
    expect((bad as ValidationError).issues.map((i) => i.path)).toEqual(['rows.0.n']);
    expect((await runsOf(d.id))[0]!.status).toBe('requested');
    expect(await sys((c) => supplyByCallback(c, run!.id, token, good))).toMatchObject({ status: 'supplied', versionNo: 1 });
  });

  it('the callback token works once, and not after it expires', async () => {
    const bi = new FakeBi();
    const d = await biDataset();
    await tick('2027-03-13T08:00:00Z', runtime(bi));
    const [run] = await runsOf(d.id);
    const token = tokenOf(bi, run!.id);
    const out = await sys((c) => supplyByCallback(c, run!.id, token, { rows: [{ program: 'BSME', n: 130 }], asOf: '2027-03-12' }));
    expect(out).toMatchObject({ status: 'supplied', versionNo: 1 });
    expect(await row(run!.id)).toMatchObject({ callback_token_hash: null });
    await expect(sys((c) => supplyByCallback(c, run!.id, token, { rows: [{ program: 'BSME', n: 131 }], asOf: '2027-03-12' }))).rejects.toThrow(ForbiddenError);
    expect((await w.as('alo', (c) => getEvidence(c, d.id))).versions).toHaveLength(1);
    // An expired token.
    const bi2 = new FakeBi();
    await tick('2027-03-14T08:00:00Z', runtime(bi2));
    const next = (await runsOf(d.id)).find((r) => r.periodStart === '2027-03-14')!;
    await w.db.su.query(`update evidence_collection_run set callback_expires_at = now() - interval '1 minute' where id = $1`, [next.id]);
    await expect(sys((c) => supplyByCallback(c, next.id, tokenOf(bi2, next.id), { rows: [{ program: 'x', n: 1 }], asOf: '2027-03-14' }))).rejects.toThrow(ForbiddenError);
    expect(callbackTokenValid({ tokenHash: 'ab'.repeat(32), expiresAt: new Date(Date.now() + 1000) }, 'anything', new Date())).toBe(false);
    expect(callbackTokenValid({ tokenHash: null, expiresAt: null }, 'anything', new Date())).toBe(false);
  });

  it('an error or a timeout fails the run; later ticks try again with a growing delay, five attempts in all, then the owner is told once', async () => {
    const bi = new FakeBi();
    bi.script = [new BiCallError('The BI did not answer within 30 seconds.')];
    const d = await biDataset();
    const at = (min: number) => new Date(Date.parse('2027-04-01T08:00:00Z') + min * 60_000).toISOString();
    const state = async () => (await runsOf(d.id)).find((r) => r.periodStart === '2027-04-01')!;
    await tick(at(0), runtime(bi));
    expect(await state()).toMatchObject({ status: 'failed', attempts: 1, lastError: 'The BI did not answer within 30 seconds.', nextAttemptAt: at(15) });
    const runId = (await state()).id;
    await tick(at(5), runtime(bi)); // too early
    expect(callsFor(bi, runId)).toHaveLength(1);
    await tick(at(15), runtime(bi));
    expect(await state()).toMatchObject({ status: 'failed', attempts: 2, nextAttemptAt: at(15 + 60) });
    await tick(at(75), runtime(bi));
    expect(await state()).toMatchObject({ attempts: 3, nextAttemptAt: at(75 + 240) });
    await tick(at(315), runtime(bi));
    expect(await state()).toMatchObject({ attempts: 4, nextAttemptAt: at(315 + 720) });
    expect((await notices('contrib', 'collection_failed')).filter((n) => n.title.includes(d.title))).toHaveLength(0);
    await tick(at(1035), runtime(bi));
    expect(await state()).toMatchObject({ status: 'failed', attempts: MAX_COLLECTION_ATTEMPTS, nextAttemptAt: null });
    expect(callsFor(bi, runId)).toHaveLength(MAX_COLLECTION_ATTEMPTS);
    await tick(at(2000), runtime(bi));
    await tick(at(2100), runtime(bi));
    expect(callsFor(bi, runId)).toHaveLength(MAX_COLLECTION_ATTEMPTS); // given up
    const told = (await notices('contrib', 'collection_failed')).filter((n) => n.title === `Collecting ${d.title} for 2027-04-01 failed`);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain('did not answer');
    // A person retries it, and the BI is up again.
    const ok = new FakeBi();
    ok.script = [{ status: 200, body: { rows: [{ program: 'BSME', n: 5 }], asOf: '2027-04-01' } }];
    const retried = await w.as('contrib', async (c) => retryRun(c, (await state()).id, { bi: runtime(ok), now: () => new Date(at(2200)) }));
    expect(retried).toMatchObject({ status: 'supplied', attempts: 5 });
  });

  it('a BI answer that does not fit the columns fails the run with the reason (and writes nothing)', async () => {
    const bi = new FakeBi();
    bi.script = [{ status: 200, body: { rows: [{ program: 'BSME', n: 'lots' }], asOf: '2027-05-01' } }];
    const d = await biDataset();
    await tick('2027-05-01T08:00:00Z', runtime(bi));
    const [run] = await runsOf(d.id);
    expect(run).toMatchObject({ status: 'failed', attempts: 1 });
    expect(run!.lastError).toContain("The BI's answer was refused");
    expect(run!.lastError).toContain('rows.0.n');
    expect((await w.as('alo', (c) => getEvidence(c, d.id))).versions).toHaveLength(0);
    // Nor does an answer that sends the wrong kind of thing for the evidence.
    bi.script = [{ status: 200, body: { fileBase64: 'AAAA', fileName: 'x.bin', asOf: '2027-05-02' } }];
    await tick('2027-05-02T08:00:00Z', runtime(bi));
    expect((await runsOf(d.id)).find((r) => r.periodStart === '2027-05-02')!.lastError).toContain('rows');
  });

  it('is simply "not configured" when there is no BI: the run fails with a clear error, nothing crashes, and a retry works once it is set up', async () => {
    const d = await biDataset();
    expect(collectionConfig(runtime(null, { baseUrl: null }))).toEqual({ bi: { configured: false, endpointKeys: ['warehouse'], callbackConfigured: true } });
    await tick('2027-06-01T08:00:00Z', runtime(null, { baseUrl: null, apiKey: null }));
    const [run] = await runsOf(d.id);
    expect(run).toMatchObject({ status: 'failed', attempts: 1, nextAttemptAt: null, lastError: expect.stringContaining('BI_BASE_URL') });
    await tick('2027-06-01T09:00:00Z', runtime(null, { baseUrl: null }));
    expect((await runsOf(d.id))[0]!.attempts).toBe(1); // not retried by itself: a setting has to be fixed first
    const bi = new FakeBi();
    bi.script = [{ status: 200, body: { rows: [{ program: 'BSME', n: 9 }], asOf: '2027-06-01' } }];
    expect(await w.as('contrib', (c) => retryRun(c, run!.id, { bi: runtime(bi), now: () => new Date('2027-06-01T10:00:00Z') }))).toMatchObject({ status: 'supplied' });
  });

  it('refuses an endpoint name the server does not know and a BI that is not https', async () => {
    const unknown = await item({ method: 'bi', schedule: { ...DAILY, startDate: '2027-07-01' }, methodConfig: { endpointKey: 'nowhere' } });
    const bi = new FakeBi();
    await tick('2027-07-01T08:00:00Z', runtime(bi));
    expect(bi.calls).toHaveLength(0);
    expect((await runsOf(unknown.id))[0]).toMatchObject({ status: 'failed', nextAttemptAt: null, lastError: expect.stringContaining('"nowhere" is not configured') });
    const insecure = await item({ method: 'bi', schedule: { ...DAILY, startDate: '2027-07-01' } });
    await tick('2027-07-01T09:00:00Z', runtime(bi, { baseUrl: 'http://bi.example.org' }));
    expect(bi.calls).toHaveLength(0);
    expect((await runsOf(insecure.id))[0]).toMatchObject({ status: 'failed', lastError: expect.stringContaining('https') });
    expect(() => resolveBiUrl(config({ baseUrl: 'http://localhost:9000', production: false }), undefined)).not.toThrow();
    expect(() => resolveBiUrl(config({ baseUrl: 'http://localhost:9000', production: true }), undefined)).toThrow(/https/);
    expect(resolveBiUrl(config({ baseUrl: 'https://bi.example.org/base/' }), 'warehouse')).toBe('https://bi.example.org/base/ams/collect/warehouse');
  });
});

describe('the HTTP client', () => {
  const call: BiCall = { url: 'https://bi.example.org/ams/collect', apiKey: 'k', timeoutMs: 50, body: { runId: 'r', evidence: { id: 'e', title: 't', type: 'document', definition: null }, period: { label: 'p', start: '2027-01-01', end: null }, query: null, callbackUrl: 'https://a/b', callbackToken: 'tok' } };
  const reply = (status: number, body = '{"asOf":"2027-01-01"}') => (async () => new Response(body, { status })) as unknown as typeof fetch;

  it('sends a bearer key and JSON, reads 200 and 202, and turns anything else into a retryable error', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const spy = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response('{"asOf":"2027-01-01"}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await httpBiClient(spy).collect(call)).toEqual({ status: 200, body: { asOf: '2027-01-01' } });
    expect(seen!.url).toBe(call.url);
    expect(seen!.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(seen!.init.body as string)).toMatchObject({ runId: 'r', callbackToken: 'tok' });
    expect(await httpBiClient(reply(202, '')).collect(call)).toEqual({ status: 202 });
    await expect(httpBiClient(reply(500, 'boom')).collect(call)).rejects.toMatchObject({ message: 'The BI answered 500: boom', retryable: true });
    await expect(httpBiClient(reply(200, 'not json')).collect(call)).rejects.toThrow(/not JSON/);
    const slow = (async (_u: string, init: RequestInit) => new Promise((_res, rej) => { init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))); })) as unknown as typeof fetch;
    await expect(httpBiClient(slow).collect(call)).rejects.toThrow(/did not answer within 0 seconds|did not answer/);
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(httpBiClient(down).collect(call)).rejects.toThrow(/could not be reached: ECONNREFUSED/);
  });
});

// ==== People ============================================================================================================================

describe('people: run now, skip, retry, supply with a version', () => {
  it('"Run now" makes today\'s run (the schedule\'s current period) and carries it out; a second one is refused', async () => {
    const bi = new FakeBi();
    const m = await item({ schedule: null, methodConfig: { instructions: 'Send it' } });
    expect(await runsOf(m.id)).toEqual([]);
    const run = await w.as('alo', (c) => runNow(c, m.id, { bi: runtime(bi), now: () => new Date('2027-08-01T10:00:00Z') }));
    expect(run).toMatchObject({ status: 'pending', trigger: 'manual', periodLabel: '2027-08-01', periodEnd: '2027-08-01', dueAt: '2027-08-02T00:00:00.000Z' });
    await expect(w.as('alo', (c) => runNow(c, m.id, { bi: runtime(bi), now: () => new Date('2027-08-01T12:00:00Z') }))).rejects.toThrow(ConflictError);
    await expect(w.as('outsider', (c) => runNow(c, m.id, { bi: runtime(bi) }))).rejects.toThrow(ForbiddenError);
    // On a scheduled item it makes the run of the current period, which the scheduler then does not repeat.
    const s = await item({ schedule: { every: 'month', startDate: '2027-01-01', dueAfterDays: 5, timezone: 'UTC' } });
    const now = await w.as('alo', (c) => runNow(c, s.id, { bi: runtime(bi), now: () => new Date('2027-08-10T10:00:00Z') }));
    expect(now).toMatchObject({ periodLabel: 'Aug 2027', periodStart: '2027-08-01', trigger: 'manual' });
    await tick('2027-08-10T11:00:00Z');
    expect((await runsOf(s.id)).filter((r) => r.periodStart === '2027-08-01')).toHaveLength(1);
  });

  it('skip needs a reason and is final; retry is for a failed run; a version of another item cannot supply it', async () => {
    const m = await item();
    await tick('2027-09-01T08:00:00Z');
    const [run] = await runsOf(m.id);
    await expect(w.as('alo', (c) => skipRun(c, run!.id, { reason: '  ' }))).rejects.toThrow();
    await expect(w.as('outsider', (c) => skipRun(c, run!.id, { reason: 'x' }))).rejects.toThrow(ForbiddenError);
    await expect(w.as('alo', (c) => retryRun(c, run!.id, { bi: runtime(null) }))).rejects.toThrow(/only a failed period/);
    const other = await item({ schedule: null });
    const ov = await w.as('contrib', (c) => addFileVersion(c, other.id, { fileName: 'o.pdf', mime: 'application/pdf', bytes: bytes('o') }));
    await expect(w.as('alo', (c) => supplyRunWithVersion(c, run!.id, { versionId: ov.id }))).rejects.toThrow(/version of this evidence item/);
    const skipped = await w.as('alo', (c) => skipRun(c, run!.id, { reason: 'Closed for the break' }));
    expect(skipped).toMatchObject({ status: 'skipped', skipReason: 'Closed for the break' });
    await expect(w.as('alo', (c) => skipRun(c, run!.id, { reason: 'again' }))).rejects.toThrow(ConflictError);
    await tick('2027-09-01T09:00:00Z');
    await tick('2027-09-03T09:00:00Z');
    expect((await runsOf(m.id)).find((r) => r.id === run!.id)!.status).toBe('skipped'); // never revived
    // Mark supplied by choosing a version of its own item.
    const d = (await runsOf(m.id)).find((r) => r.periodStart === '2027-09-03')!;
    const v = await w.db.su.query(`insert into evidence_version (institution_id, evidence_item_id, version_no, url) values ($1, $2, 1, 'https://x.example/a') returning id`, [w.ids.inst, m.id]);
    expect(await w.as('alo', (c) => supplyRunWithVersion(c, d.id, { versionId: v.rows[0].id }))).toMatchObject({ status: 'supplied', versionNo: 1 });
  });

  it('lists runs with filters (status, item, owner, mine, due)', async () => {
    const all = await w.as('alo', (c) => listCollectionRuns(c, {}));
    expect(all.length).toBeGreaterThan(10);
    const late = await w.as('alo', (c) => listCollectionRuns(c, { status: 'late' }));
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((r) => r.status === 'late')).toBe(true);
    const some = all[0] as CollectionRun;
    expect((await w.as('alo', (c) => listCollectionRuns(c, { itemId: some.evidenceItemId }))).every((r) => r.evidenceItemId === some.evidenceItemId)).toBe(true);
    expect((await w.as('contrib', (c) => listCollectionRuns(c, { mine: 'true' }))).every((r) => r.ownerUserId === w.ids.contrib)).toBe(true);
    expect(await w.as('coord', (c) => listCollectionRuns(c, { mine: 'true', status: 'pending' }))).toEqual([]);
    expect((await w.as('alo', (c) => listCollectionRuns(c, { dueBefore: '2026-10-22T00:00:00Z' }))).every((r) => Date.parse(r.dueAt) <= Date.parse('2026-10-22T00:00:00Z'))).toBe(true);
    await expect(w.as('alo', (c) => listCollectionRuns(c, { status: 'bogus' }))).rejects.toThrow(ValidationError);
    await expect(w.as('outsider', (c) => listCollectionRuns(c, {}))).rejects.toThrow(ForbiddenError);
  });

  it('an item\'s runs count in the library: open, late and failed', async () => {
    const m = await item({ schedule: { every: 'day', startDate: '2028-01-01', dueAfterDays: 0, timezone: 'UTC' } });
    await tick('2028-01-05T10:00:00Z');
    await tick('2028-01-06T10:00:00Z');
    const got = (await w.as('alo', (c) => getEvidence(c, m.id))).item;
    expect(got.runCounts).toEqual({ open: 2, late: 1, failed: 0 });
  });
});
