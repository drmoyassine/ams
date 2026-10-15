// The import engine end to end with an invented target and a fake model (no network): read -> extract -> verify -> propose, review,
// apply as one undoable group, and the rules around it (permissions, resume, cancel, spend limit, a place that cannot change).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobEnvelope, JobType, UndoDescriptor } from '@ams/shared';
import { ConflictError, ForbiddenError, ValidationError, type Ctx, type JobQueue } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createFakeAiModel, setAiModelForTests } from '../ai/index.js';
import { handlers } from '../jobs/handlers.js';
import { runJob } from '../jobs/run.js';
import { pdf } from '../framework/parse-fixtures.js';
import { addSourceDocument, addSourcePage } from '../framework/sources.js';
import { newVersionFrom } from '../framework/versions.js';
import { listOrgUnits } from '../org/units.js';
import { uploadDocument } from './documents.js';
import {
  applyImport, decideImportProposals, editImportProposal, listImportProposals, previewImportApply, redoImportApply, undoImportApply,
} from './proposals.js';
import { getImportReport } from './report.js';
import { cancelImport, getImportRun, importPreflight, listImportRuns, listImportTargets, startImport } from './runs.js';
import { MAX_IMPORT_ATTEMPTS } from './stages.js';
import { registerTestTarget, TEST_TARGET_KIND, testUnitsResponder, unregisterTestTarget } from './test-target.js';

let w: World;
const sent: (JobEnvelope & { type: JobType })[] = [];
const queue: JobQueue = { send: async (type, e) => { sent.push({ ...e, type }); } };
let reported: UndoDescriptor[] = [];
const as = <T>(who: string, fn: (c: Ctx) => Promise<T>) =>
  w.as(who, (c) => fn({ ...c, queue, afterCommit: (f) => { void f(); }, undo: (d) => { reported.push(d); } }));
const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;

/**
 * The worker: runs queued jobs in order (the parser's extract_text and the agent's import alike) until none is left. A job that throws
 * is put back at the front, as the queue does, up to `retries` times per message; `onError` sees each failure.
 */
async function drain(opts: { only?: JobType[]; max?: number; retries?: number; onError?: (e: Error) => Promise<void> | void } = {}) {
  let n = 0;
  const tried = new Map<string, number>();
  while (sent.length && n++ < (opts.max ?? 200)) {
    const i = opts.only ? sent.findIndex((s) => opts.only!.includes(s.type)) : 0;
    if (i < 0) break;
    const [{ type, ...env }] = sent.splice(i, 1) as [JobEnvelope & { type: JobType }];
    try {
      await runJob(w.pool, type, env, handlers, { store: w.store, queue });
    } catch (e) {
      const k = `${type}:${env.jobId}`;
      tried.set(k, (tried.get(k) ?? 0) + 1);
      if (!opts.retries || tried.get(k)! > opts.retries) throw e;
      await opts.onError?.(e as Error);
      sent.splice(i, 0, { type, ...env });
    }
  }
  return n;
}

const unitPage = (unit: string | null, n: number) => `${unit ? `${unit}\n` : ''}Page ${n} of the university's list of units, with enough words to count as a real page of text.`;
const doc = (units: Record<number, string>, pages = 10) => pdf(Array.from({ length: pages }, (_, i) => unitPage(units[i + 1] ?? null, i + 1)));
const upload = (name: string, bytes: Uint8Array) => as('alo', (c) => uploadDocument(c, { scopeKind: 'org_chart', scopeId: null, fileName: name, mime: 'application/pdf', bytes }));
const start = (documentIds: string[], who = 'alo') => as(who, (c) => startImport(c, { scopeKind: 'org_chart', scopeId: null, targetKind: TEST_TARGET_KIND, documentIds }));
const proposals = async (runId: string) => (await as('alo', (c) => listImportProposals(c, runId))).proposals;
const units = async () => (await as('alo', (c) => listOrgUnits(c)));
const ids: Record<string, string> = {};

beforeAll(async () => {
  w = await buildWorld('imports');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  registerTestTarget();
}, 120000);
afterEach(() => setAiModelForTests(null));
afterAll(async () => { unregisterTestTarget(); await w.close(); });

describe('readiness and who may start', () => {
  it('lists the imports a place offers, and checks readiness before anyone clicks', async () => {
    expect((await as('contrib', (c) => listImportTargets(c, 'org_chart', null))).map((t) => t.kind)).toEqual([TEST_TARGET_KIND]);
    expect(await as('alo', (c) => listImportTargets(c, 'glossary', null))).toEqual([]);
    await expect(as('contrib', (c) => importPreflight(c, 'org_chart', null, TEST_TARGET_KIND))).rejects.toThrow(ForbiddenError);

    const none = await as('alo', (c) => importPreflight(c, 'org_chart', null, TEST_TARGET_KIND));
    expect(none.canStart).toBe(false);
    expect(none.checks.find((c) => c.id === 'documents')).toMatchObject({ status: 'problem', fix: { where: 'docs' } });

    ids.a = (await upload('units-a.pdf', doc({ 1: 'Unit: College of Arts (college)', 3: 'Unit: Department of History (department; under College of Arts)', 8: 'Unit: School of Law (school)', 9: 'Unit: Phantom Faculty (other)', 10: 'Unit: Unsure Centre (other)' }))).id;
    ids.b = (await upload('units-b.pdf', doc({ 1: 'Unit: Library (admin_unit)', 2: 'Unit: College of Arts (college)' }, 2))).id;
    const noAi = await as('alo', (c) => importPreflight(c, 'org_chart', null, TEST_TARGET_KIND));
    expect(noAi.canStart).toBe(false); // AI is not set up
    expect(noAi.checks.find((c) => c.id === 'analysis_model')?.status).toBe('problem');

    setAiModelForTests(createFakeAiModel([testUnitsResponder()]).model);
    const ready = await as('alo', (c) => importPreflight(c, 'org_chart', null, TEST_TARGET_KIND));
    expect(ready.canStart).toBe(true);
    expect(ready.checks.find((c) => c.id === 'documents')?.message).toMatch(/2 documents to read; 2 still being read/);
    expect((await as('alo', (c) => importPreflight(c, 'org_chart', null, 'nothing'))).canStart).toBe(false);
  }, 60000);

  it('refuses a person who may not write there, an unknown target, a document from another place, and AI that is off', async () => {
    setAiModelForTests(createFakeAiModel([testUnitsResponder()]).model);
    await expect(start([ids.a!], 'contrib')).rejects.toThrow(ForbiddenError);
    await expect(as('alo', (c) => startImport(c, { scopeKind: 'org_chart', scopeId: null, targetKind: 'nothing', documentIds: [ids.a!] }))).rejects.toThrow(/import target/);
    await expect(as('alo', (c) => startImport(c, { scopeKind: 'glossary', scopeId: null, targetKind: TEST_TARGET_KIND, documentIds: [ids.a!] }))).rejects.toThrow(ConflictError);
    await expect(as('alo', (c) => startImport(c, { scopeKind: 'org_chart', scopeId: null, targetKind: TEST_TARGET_KIND, documentIds: [crypto.randomUUID()] }))).rejects.toThrow(ValidationError);
    setAiModelForTests(null);
    await expect(start([ids.a!])).rejects.toThrow(/AI/);
    expect(await q(`select count(*)::int n from import_run`)).toEqual([{ n: 0 }]);
  });
});

describe('a run end to end', () => {
  let runId: string;
  let calls: unknown[];

  it('reads, extracts window by window, verifies quotes on their pages, merges the overlap and proposes', async () => {
    const fake = createFakeAiModel([testUnitsResponder()]);
    calls = fake.calls;
    setAiModelForTests(fake.model);
    const run = await start([ids.a!, ids.b!]);
    runId = run.id;
    expect(run).toMatchObject({ status: 'queued', stage: 'read', targetLabel: 'Units (test)', startedByName: 'alo', counts: { total: 0 } });
    await expect(start([ids.a!])).rejects.toThrow(/already running/);
    await drain();

    const done = await as('alo', (c) => getImportRun(c, runId));
    expect(done).toMatchObject({ status: 'succeeded', error: null, stage: 'finalise' });
    expect(done.finishedAt).not.toBeNull();
    // Pages 1-8 and 8-10 of the long document, one window for the short one: three model calls.
    expect(calls).toHaveLength(3);
    expect(done.progress).toMatchObject({ windowsTotal: 3, windowsDone: 3, items: 8 });
    expect(done.usage).toEqual({ inputTokens: 30, outputTokens: 15, costUsd: null, calls: 3 });
    expect(done.counts).toMatchObject({ total: 7, pending: 7, flagged: 2 });
    // The model was asked with the target's instructions, the page headings and temperature 0.
    const first = JSON.stringify(calls[0]);
    expect(first).toContain('Find the organisational units');
    expect(first).toContain('=== Page 1 ===');
    expect((calls[0] as { temperature?: number }).temperature).toBe(0);
    expect((await q(`select prompt_version, model from import_run where id = $1`, [runId]))[0]).toEqual({ prompt_version: 'v1', model: 'test' });

    const list = await proposals(runId);
    expect(list.map((p) => [p.label, p.documentName, p.pageNo, p.status])).toEqual([
      ['College of Arts', 'units-a.pdf', 1, 'pending'], ['Department of History', 'units-a.pdf', 3, 'pending'], ['School of Law', 'units-a.pdf', 8, 'pending'],
      ['Phantom Faculty', 'units-a.pdf', 9, 'pending'], ['Unsure Centre', 'units-a.pdf', 10, 'pending'], ['Library', 'units-b.pdf', 1, 'pending'], ['College of Arts', 'units-b.pdf', 2, 'pending'],
    ]);
    expect(list.find((p) => p.label === 'School of Law')).toMatchObject({ quoteVerified: true, flags: [], payload: { name: 'School of Law', type: 'school', parent: null } });
    expect(list.find((p) => p.label === 'Department of History')?.payload).toEqual({ name: 'Department of History', type: 'department', parent: 'College of Arts' });
    // Flags are plain words and never silent.
    expect(list.find((p) => p.label === 'Phantom Faculty')).toMatchObject({ quoteVerified: false, flags: ['The quote was not found on the page it cites.'] });
    expect(list.find((p) => p.label === 'Unsure Centre')).toMatchObject({ quoteVerified: true, confidence: 0.3, flags: ['The AI was not sure about this one.'] });
    // Candidates are gone: only released proposals exist.
    expect(await q(`select count(*)::int n from import_proposal where run_id = $1 and candidate`, [runId])).toEqual([{ n: 0 }]);
    // The target's real records were not touched by the run.
    expect((await units()).map((u) => u.nameEn)).toEqual(['Engineering']);
  }, 120000);

  it('has a report of what was read, found and checked, with no score', async () => {
    const r = await as('contrib', (c) => getImportReport(c, runId));
    expect(r.scopeLabel).toBe('Org chart');
    expect(r.totals).toMatchObject({ documents: 2, documentsRead: 2, pages: 12, ocrPages: 0, unreadablePages: 0 });
    expect(r.documents.map((d) => [d.name, d.pages, d.status])).toEqual([['units-a.pdf', 10, 'read'], ['units-b.pdf', 2, 'read']]);
    expect(r.proposals).toMatchObject({ total: 7, pending: 7, quoteVerified: 6, quoteNotFound: 1, lowConfidence: 1 });
    expect(r.flagged.map((f) => [f.label, f.reasons])).toEqual([
      ['Phantom Faculty', ['The quote was not found on the page it cites.']], ['Unsure Centre', ['The AI was not sure about this one.']],
    ]);
    expect(r.models).toEqual({ model: 'test', role: 'analysis' });
    expect(r.usage.calls).toBe(3);
    expect(r.stoppedBy).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/compliant|\bmet\b|readiness|score/i);
    expect((await as('alo', (c) => listImportRuns(c, 'org_chart', null))).map((x) => x.id)).toEqual([runId]);
    await expect(as('outsider', (c) => getImportReport(c, runId))).rejects.toThrow(ForbiddenError);
  });

  it('lets a person edit values (they must fit the schema), accept and skip one or many', async () => {
    const list = await proposals(runId);
    const law = list.find((p) => p.label === 'School of Law')!;
    await expect(as('contrib', (c) => editImportProposal(c, law.id, { name: 'X', type: 'school', parent: null }))).rejects.toThrow(ForbiddenError);
    await expect(as('alo', (c) => editImportProposal(c, law.id, { name: '', type: 'school' }))).rejects.toThrow(ValidationError);
    await expect(as('alo', (c) => editImportProposal(c, law.id, { name: 'Law', type: 'faculty' }))).rejects.toThrow(/do not fit/);
    const edited = await as('alo', (c) => editImportProposal(c, law.id, { name: 'School of Law and Policy', type: 'school', parent: null }));
    expect(edited).toMatchObject({ status: 'edited', label: 'School of Law and Policy', payload: { name: 'School of Law' }, editedPayload: { name: 'School of Law and Policy' }, effective: { name: 'School of Law and Policy' } });

    const phantom = list.find((p) => p.label === 'Phantom Faculty')!;
    expect(await as('alo', (c) => decideImportProposals(c, runId, { ids: [phantom.id], decision: 'skip' }))).toEqual({ changed: 1 });
    const rest = list.filter((p) => !['Phantom Faculty', 'School of Law'].includes(p.label)).map((p) => p.id);
    expect(await as('alo', (c) => decideImportProposals(c, runId, { ids: rest, decision: 'accept' }))).toEqual({ changed: rest.length });
    await expect(as('contrib', (c) => decideImportProposals(c, runId, { ids: rest, decision: 'skip' }))).rejects.toThrow(ForbiddenError);
    await expect(as('alo', (c) => decideImportProposals(c, runId, { ids: [crypto.randomUUID()], decision: 'accept' }))).rejects.toThrow();
    const after = await proposals(runId);
    expect(Object.fromEntries(after.map((p) => [`${p.label}@${p.documentName}`, p.status]))).toMatchObject({
      'School of Law and Policy@units-a.pdf': 'edited', 'Phantom Faculty@units-a.pdf': 'skipped', 'College of Arts@units-a.pdf': 'accepted', 'Library@units-b.pdf': 'accepted',
    });
    // Resetting an edited one keeps its edit and makes it pending; accepting it again makes it "edited" again.
    await as('alo', (c) => decideImportProposals(c, runId, { ids: [law.id], decision: 'reset' }));
    expect((await proposals(runId)).find((p) => p.id === law.id)).toMatchObject({ status: 'pending', editedPayload: { name: 'School of Law and Policy' } });
    await as('alo', (c) => decideImportProposals(c, runId, { ids: [law.id], decision: 'accept' }));
    expect((await proposals(runId)).find((p) => p.id === law.id)?.status).toBe('edited');
  });

  it('applies the accepted ones as one undoable group, and leaves alone what is already there', async () => {
    const preview = await as('alo', (c) => previewImportApply(c, runId));
    expect(preview).toMatchObject({ count: 6, skippedPending: 0 });
    expect(preview.message).toMatch(/^Apply 6 units to Org chart\? You can undo it afterwards\./);
    await expect(as('contrib', (c) => applyImport(c, runId))).rejects.toThrow(ForbiddenError);

    reported = [];
    const res = await as('alo', (c) => applyImport(c, runId));
    expect(res).toMatchObject({ state: 'applied', applied: 5, message: 'Applied 5 units to Org chart. 1 item left alone.' });
    expect(res.skipped).toEqual([{ proposalId: expect.any(String), label: 'College of Arts', reason: 'a unit with this name is already in the org chart' }]);
    expect(res.applyId).toEqual(expect.any(String));
    // ONE undo descriptor for the whole group.
    expect(reported).toEqual([{ label: 'Applied 5 units to Org chart', method: 'POST', path: `/api/import-applies/${res.applyId}/undo` }]);

    const all = await units();
    expect(all.map((u) => u.nameEn).sort()).toEqual(['College of Arts', 'Department of History', 'Engineering', 'Library', 'School of Law and Policy', 'Unsure Centre']);
    const arts = all.find((u) => u.nameEn === 'College of Arts')!;
    expect(all.find((u) => u.nameEn === 'Department of History')).toMatchObject({ parentId: arts.id, type: 'department', active: true });
    // The rows are the person's: created by them (the audit trail names them), not by the worker.
    expect((await q(`select created_by from org_unit where name_en = 'Library'`))[0].created_by).toBe(w.ids.alo);

    const after = await proposals(runId);
    const by = Object.fromEntries(after.map((p) => [`${p.label}@${p.documentName}`, p]));
    expect(by['College of Arts@units-a.pdf']).toMatchObject({ status: 'applied', appliedRef: { unitId: arts.id } });
    expect(by['College of Arts@units-b.pdf']).toMatchObject({ status: 'skipped', appliedRef: { skipped: true, reason: expect.stringContaining('already in the org chart') } });
    expect(by['Phantom Faculty@units-a.pdf']?.status).toBe('skipped');
    // Nothing accepted is left to apply, and an apply is recorded without the words.
    await expect(as('alo', (c) => applyImport(c, runId))).rejects.toThrow(/nothing is accepted/);
    const [a] = await q(`select state, counts, summary from import_apply where id = $1`, [res.applyId]);
    expect(a).toMatchObject({ state: 'applied', counts: { applied: 5, skipped: 1 } });
    const audit = await q(`select after from audit_event where target_type = 'import_apply' and target_id = $1`, [res.applyId]);
    expect(audit.length).toBe(1);
    ids.apply = res.applyId!;
    ids.arts = arts.id;
  });

  it('undoes and redoes the whole apply, with the descriptor of the other direction each time', async () => {
    reported = [];
    const undone = await as('alo', (c) => undoImportApply(c, ids.apply!));
    expect(undone).toMatchObject({ state: 'undone', message: 'Undone: Applied 5 units to Org chart.' });
    expect(reported).toEqual([{ label: 'Applied 5 units to Org chart', method: 'POST', path: `/api/import-applies/${ids.apply}/redo` }]);
    expect((await units()).filter((u) => u.active).map((u) => u.nameEn)).toEqual(['Engineering']);
    const rows = await proposals(runId);
    expect(rows.find((p) => p.label === 'School of Law and Policy')).toMatchObject({ status: 'edited', appliedRef: null });
    expect(rows.find((p) => p.label === 'Library')).toMatchObject({ status: 'accepted', appliedRef: null });
    await expect(as('alo', (c) => undoImportApply(c, ids.apply!))).rejects.toThrow(/already undone/);
    await expect(as('contrib', (c) => undoImportApply(c, ids.apply!))).rejects.toThrow(ForbiddenError);

    reported = [];
    const redone = await as('alo', (c) => redoImportApply(c, ids.apply!));
    expect(redone).toMatchObject({ state: 'applied', applied: 5 });
    expect(reported).toEqual([{ label: 'Applied 5 units to Org chart', method: 'POST', path: `/api/import-applies/${ids.apply}/undo` }]);
    expect((await units()).filter((u) => u.active).length).toBe(6);
    expect((await proposals(runId)).find((p) => p.label === 'Library')).toMatchObject({ status: 'applied', appliedRef: { unitId: expect.any(String) } });
    await expect(as('alo', (c) => redoImportApply(c, ids.apply!))).rejects.toThrow(/already in place/);
  });
});

describe('apply is all or nothing', () => {
  it('rolls everything back when the target refuses one item', async () => {
    setAiModelForTests(createFakeAiModel([testUnitsResponder()]).model);
    const d = await upload('units-c.pdf', doc({ 1: 'Unit: Zeta Unit (other)', 2: 'Unit: Explode (other)' }, 2));
    const run = await start([d.id]);
    await drain();
    const list = await proposals(run.id);
    await as('alo', (c) => decideImportProposals(c, run.id, { ids: list.map((p) => p.id), decision: 'accept' }));
    const before = (await units()).length;
    await expect(as('alo', (c) => applyImport(c, run.id))).rejects.toThrow(/all-or-nothing/);
    expect((await units()).length).toBe(before);
    expect((await proposals(run.id)).every((p) => p.status === 'accepted' && p.appliedRef === null)).toBe(true);
    expect(await q(`select count(*)::int n from import_apply where run_id = $1`, [run.id])).toEqual([{ n: 0 }]);
  }, 60000);
});

describe('resume, cancel and the spend limit', () => {
  it('a step that fails is tried again from where it stopped, without duplicating anything', async () => {
    const d = await upload('units-d.pdf', doc({ 1: 'Unit: Alpha Unit (other)', 9: 'Unit: Beta Unit (other)' }));
    const fake = createFakeAiModel([new Error('temporary outage at the provider'), testUnitsResponder()]);
    setAiModelForTests(fake.model);
    const run = await start([d.id]);
    const failures: string[] = [];
    await drain({
      retries: 3,
      onError: async (e) => {
        failures.push(e.message);
        // The failed step left nothing behind: the run is still at the first window, with no candidate rows.
        const mid = await as('alo', (c) => getImportRun(c, run.id));
        expect(mid).toMatchObject({ status: 'running', stage: 'extract', progress: { cursor: 0, windowsDone: 0 } });
        expect(await q(`select count(*)::int n from import_proposal where run_id = $1`, [run.id])).toEqual([{ n: 0 }]);
      },
    });
    expect(failures).toEqual(['temporary outage at the provider']);
    const done = await as('alo', (c) => getImportRun(c, run.id));
    expect(done.status).toBe('succeeded');
    expect(done.progress).toMatchObject({ windowsDone: 2 });
    expect((await proposals(run.id)).map((p) => p.label)).toEqual(['Alpha Unit', 'Beta Unit']);
    expect(done.usage.calls).toBe(2); // the failed step was rolled back with its record; the two good calls are counted once
  }, 120000);

  it('ends the run as failed after the last attempt, with the reason, and the queue stops', async () => {
    const d = await upload('units-e.pdf', doc({ 1: 'Unit: Gamma Unit (other)' }, 3));
    setAiModelForTests(createFakeAiModel([new Error('the provider is down')]).model);
    const run = await start([d.id]);
    let threw = 0;
    await drain({ retries: MAX_IMPORT_ATTEMPTS + 2, onError: () => { threw += 1; } });
    expect(threw).toBe(MAX_IMPORT_ATTEMPTS - 1);
    const done = await as('alo', (c) => getImportRun(c, run.id));
    expect(done).toMatchObject({ status: 'failed', error: expect.stringContaining('the provider is down') });
    expect(done.counts.total).toBe(0);
    expect(sent).toHaveLength(0);
  }, 120000);

  it('ends the run at once, with a plain reason, when the model returns nothing (retrying cannot help)', async () => {
    const d = await upload('units-g.pdf', doc({ 1: 'Unit: Eta Unit (other)' }, 3));
    setAiModelForTests(createFakeAiModel([new Error('No output generated.')]).model);
    const run = await start([d.id]);
    let threw = 0;
    await drain({ retries: MAX_IMPORT_ATTEMPTS + 2, onError: () => { threw += 1; } });
    expect(threw).toBe(0);
    expect(await as('alo', (c) => getImportRun(c, run.id))).toMatchObject({ status: 'failed', error: expect.stringContaining('returned nothing') });
  }, 120000);

  it('waits for the parser when a document is not read yet, then goes on', async () => {
    const d = await upload('units-f.pdf', doc({ 1: 'Unit: Delta Unit (other)' }, 2));
    setAiModelForTests(createFakeAiModel([testUnitsResponder()]).model);
    const run = await start([d.id]);
    // The import's first step runs before the parser has read the file: it queues itself again, with a delay.
    await drain({ only: ['import'], max: 1 });
    expect(sent.filter((s) => s.type === 'import')).toHaveLength(1);
    expect((await as('alo', (c) => getImportRun(c, run.id))).stage).toBe('read');
    expect(await q(`select read_status from import_document where id = $1`, [d.id])).toEqual([{ read_status: 'queued' }]);
    await drain();
    expect((await as('alo', (c) => getImportRun(c, run.id))).status).toBe('succeeded');
    expect((await proposals(run.id)).map((p) => p.label)).toEqual(['Delta Unit']);
  }, 120000);

  it('keeps what was found before Cancel, and does no further model call', async () => {
    const d = await upload('units-g.pdf', doc({ 1: 'Unit: Epsilon Unit (other)', 9: 'Unit: Zeta Two (other)' }));
    const fake = createFakeAiModel([testUnitsResponder()]);
    setAiModelForTests(fake.model);
    const run = await start([d.id]);
    await drain({ only: ['extract_text'] });
    // read, then the first window only.
    await drain({ only: ['import'], max: 2 });
    expect(fake.calls).toHaveLength(1);
    const cancelled = await as('alo', (c) => cancelImport(c, run.id));
    expect(cancelled.status).toBe('cancelled');
    await expect(as('alo', (c) => cancelImport(c, run.id))).rejects.toThrow(/already ended/);
    await drain();
    expect(fake.calls).toHaveLength(1);
    expect((await as('alo', (c) => getImportRun(c, run.id))).status).toBe('cancelled');
    expect((await proposals(run.id)).map((p) => p.label)).toEqual(['Epsilon Unit']);
    const r = await as('alo', (c) => getImportReport(c, run.id));
    expect(r.stoppedBy).toBe('cancelled');
  }, 120000);

  it('stops at the spend limit as failed, keeping the proposals found so far', async () => {
    const d = await upload('units-h.pdf', doc({ 1: 'Unit: Eta Unit (other)', 9: 'Unit: Theta Unit (other)' }));
    // $1 per call (10 input tokens at $100,000 per million); the limit lets one call through.
    await w.db.su.query(`insert into ai_setting (institution_id, model, enabled, cap_unit, max_cost_usd_per_run, input_usd_per_mtok, output_usd_per_mtok) values ($1, 'm', true, 'usd', 1, 100000, 0)`, [w.ids.inst]);
    try {
      const fake = createFakeAiModel([testUnitsResponder()]);
      setAiModelForTests(fake.model);
      const run = await start([d.id]);
      await drain();
      expect(fake.calls).toHaveLength(1);
      const done = await as('alo', (c) => getImportRun(c, run.id));
      expect(done.status).toBe('failed');
      expect(done.error).toMatch(/cost budget for this run is used up/);
      expect(done.usage).toMatchObject({ calls: 1, costUsd: 1 });
      expect((await proposals(run.id)).map((p) => p.label)).toEqual(['Eta Unit']);
      const r = await as('alo', (c) => getImportReport(c, run.id));
      expect(r.stoppedBy).toBe('budget');
      expect(r.stoppedMessage).toMatch(/budget/);
      // The partial proposals can still be reviewed and applied.
      const [p] = await proposals(run.id);
      await as('alo', (c) => decideImportProposals(c, run.id, { ids: [p!.id], decision: 'accept' }));
      await expect(as('alo', (c) => applyImport(c, run.id))).resolves.toMatchObject({ applied: 1 });
    } finally {
      await w.db.su.query(`delete from ai_setting where institution_id = $1`, [w.ids.inst]);
    }
  }, 120000);
});

describe('a place that cannot change', () => {
  it('imports from a standards version\'s sources, but refuses to start or apply once the version is no longer a draft', async () => {
    const draft = (await as('admin', (c) => newVersionFrom(c, w.ids.wscuc!, { edition: '2032' }))).version.id;
    const src = await as('alo', (c) => addSourceDocument(c, { versionId: draft, title: 'Typed list', role: 'other', authority: 'informational' }));
    await as('alo', (c) => addSourcePage(c, { documentId: src.id, pageNo: 1, text: 'Unit: Iota Unit (other)\nA short page.', method: 'pdf_text' }));
    setAiModelForTests(createFakeAiModel([testUnitsResponder()]).model);
    const run = await as('alo', (c) => startImport(c, { scopeKind: 'framework_version', scopeId: draft, targetKind: TEST_TARGET_KIND, documentIds: [src.id] }));
    await drain();
    expect(await as('alo', (c) => getImportRun(c, run.id))).toMatchObject({ status: 'succeeded', scopeKind: 'framework_version', scopeId: draft });
    const [p] = (await as('alo', (c) => listImportProposals(c, run.id))).proposals;
    expect(p).toMatchObject({ label: 'Iota Unit', documentName: 'Typed list', pageNo: 1, quoteVerified: true });
    // The report reads the version's own pages.
    expect((await as('alo', (c) => getImportReport(c, run.id))).documents).toMatchObject([{ name: 'Typed list', pages: 1, status: 'read' }]);
    await as('alo', (c) => decideImportProposals(c, run.id, { ids: [p!.id], decision: 'accept' }));

    await w.db.su.query(`update framework_version set status = 'in_review' where id = $1`, [draft]);
    await expect(as('alo', (c) => applyImport(c, run.id))).rejects.toThrow(/fixed with it/);
    await expect(as('alo', (c) => startImport(c, { scopeKind: 'framework_version', scopeId: draft, targetKind: TEST_TARGET_KIND, documentIds: [src.id] }))).rejects.toThrow(/fixed with it/);
    expect((await as('alo', (c) => importPreflight(c, 'framework_version', draft, TEST_TARGET_KIND))).checks.find((c) => c.id === 'editable')).toMatchObject({ status: 'problem' });
    expect((await units()).some((u) => u.nameEn === 'Iota Unit')).toBe(false);
    await w.db.su.query(`update framework_version set status = 'draft' where id = $1`, [draft]);
    await expect(as('alo', (c) => applyImport(c, run.id))).resolves.toMatchObject({ applied: 1 });
  }, 120000);
});
