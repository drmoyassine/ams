// Framework analysis end to end (PRD 15, step C): a person starts it, the worker runs it one small job at a time, and
// the draft version gets the accreditor's requirements in their exact wording, with page, quote and verification.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobEnvelope, JobType } from '@ams/shared';
import { ConflictError, ForbiddenError, type Ctx, type JobQueue } from '../../ctx.js';
import { buildWorld, type World } from '../../engagement/test-support.js';
import { createFakeAiModel, setAiModelForTests } from '../../ai/index.js';
import { handlers } from '../../jobs/handlers.js';
import { runJob } from '../../jobs/run.js';
import { pdf } from '../parse-fixtures.js';
import { createRequirement, listRequirements, updateRequirement } from '../requirements.js';
import { addSourceDocument, addSourcePage, listSourceDocuments, uploadSourceFile } from '../sources.js';
import { getVersion } from '../common.js';
import { createAccreditor, createFramework, createVersion, publishVersion, submitForReview, updateVersionConfig, validateVersion } from '../versions.js';
import { upsertReportTemplate } from '../templates.js';
import { FIXTURE_GUIDE, FIXTURE_HANDBOOK, fixtureResponder } from './fixture.js';
import { cancelAnalysis, getAnalysisRun, listAnalysisRuns, startAnalysis } from './runs.js';
import { MAX_READ_WAITS } from './stages.js';

let w: World;
// Every job goes through the fake queue with its type, so extract_text (the parser's) and analyse (the agent's) both run.
const sent: (JobEnvelope & { type: JobType })[] = [];
const queue: JobQueue = { send: async (type, e) => { sent.push({ ...e, type }); } };
const as = <T>(who: string, fn: (c: Ctx) => Promise<T>) => w.as(who, (c) => fn({ ...c, queue, afterCommit: (f) => { void f(); } }));
/** The worker: runs queued analysis steps until none is left (each step queues the next). */
async function drain(max = 100) {
  let n = 0;
  while (sent.length && n++ < max) {
    const { type, ...env } = sent.shift()!;
    await runJob(w.pool, type, env, handlers, { store: w.store, queue });
  }
  return n;
}
const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;

async function draftWithSources(edition: string) {
  return as('alo', async (c) => {
    const acc = await createAccreditor(c, { name: `Invented Council ${edition}`, shortName: `IC${edition}`, type: 'institutional' });
    const fw = await createFramework(c, { accreditorId: acc.id, name: 'Institutional Standards', scope: 'institution' });
    const v = await createVersion(c, { frameworkId: fw.id, edition });
    const hb = await addSourceDocument(c, { versionId: v.id, title: FIXTURE_HANDBOOK.title, role: 'standards', authority: 'binding' });
    for (const [i, text] of FIXTURE_HANDBOOK.pages.entries()) await addSourcePage(c, { documentId: hb.id, pageNo: i + 1, text, method: 'pdf_text' });
    // No role chosen: the survey decides it.
    const guide = await addSourceDocument(c, { versionId: v.id, title: FIXTURE_GUIDE.title, authority: 'interpretive', language: 'ar' });
    await addSourcePage(c, { documentId: guide.id, pageNo: 1, text: FIXTURE_GUIDE.pages[0]!, method: 'pdf_text' });
    return { versionId: v.id, handbook: hb.id, guide: guide.id };
  });
}

const tree = (versionId: string) => as('alo', (c) => listRequirements(c, versionId));
const notesOf = (versionId: string) => q(`select n.*, r.code from requirement_note n join requirement r on r.id = n.requirement_id where r.framework_version_id = $1 order by r.code, n.text`, [versionId]);

beforeAll(async () => {
  w = await buildWorld('analysis');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
}, 120000);
afterEach(() => setAiModelForTests(null));
afterAll(() => w.close());

describe('framework analysis', () => {
  let v: Awaited<ReturnType<typeof draftWithSources>>;
  let runId: string;

  it('runs every stage as its own job and writes the requirement tree in the accreditor\'s wording', async () => {
    v = await draftWithSources('A');
    const fake = createFakeAiModel([fixtureResponder()]);
    setAiModelForTests(fake.model);
    const run = await as('alo', (c) => startAnalysis(c, v.versionId));
    runId = run.id;
    expect(run).toMatchObject({ status: 'queued', stage: 'read', promptVersions: { survey: 'v1', structure: 'v1', extract: 'v1', recover: 'v1', map: 'v1', newiqf: 'v1', config_survey: 'v1', lifecycle: 'v1', vocab: 'v1', template: 'v1' } });
    // One job per step: read x2, survey x2, structure, extract x3 (two windows of the handbook, one of the guide), then
    // step D: gaps, recover x3 (1.9's and a note's quotes, 3.9.1's missing parent: all answered "not there"), gaps; write, finalise.
    // Then step H for the guidance document (one survey call: it holds no lifecycle, vocabulary or template; one write step), and the
    // IQF mapping's first step, which ends the run here: this institution has no quality framework to map onto.
    expect(await drain()).toBe(18);
    expect(fake.calls).toHaveLength(10);

    const done = await as('alo', (c) => getAnalysisRun(c, runId));
    expect(done).toMatchObject({ status: 'succeeded', error: null, model: 'test' });
    expect(done.finishedAt).not.toBeNull();
    expect(done.progress).toMatchObject({ windowsTotal: 3, windowsDone: 3, items: 12 });
    expect(done.usage).toEqual({ inputTokens: 100, outputTokens: 50, costUsd: null, calls: 10 });

    // The level names apply to the draft.
    expect((await as('alo', (c) => getVersion(c, v.versionId))).levelLabels).toEqual(['Standard', 'Criterion', 'Indicator']);
    // The survey set the role nobody had chosen, and left the person's choice alone.
    const docs = await as('alo', (c) => listSourceDocuments(c, v.versionId));
    expect(docs.find((d) => d.id === v.guide)).toMatchObject({ role: 'guidance', roleOrigin: 'ai' });
    expect(docs.find((d) => d.id === v.handbook)).toMatchObject({ role: 'standards', roleOrigin: 'manual' });

    const reqs = await tree(v.versionId);
    const code = (c: string) => reqs.find((r) => r.code === c)!;
    expect(reqs.map((r) => [r.code, r.depth, r.levelLabel])).toEqual([
      // Siblings in reading order: 1.9 is on page 5, 1.2 on page 8.
      ['1', 0, 'Standard'], ['1.1', 1, 'Criterion'], ['1.1.1', 2, 'Indicator'], ['1.9', 1, 'Criterion'], ['1.2', 1, 'Criterion'], ['1.2.1', 2, 'Indicator'],
      ['3.9.1', 0, 'Indicator'],
    ]);
    // Exact wording in the description; the short heading (or the code) as the title.
    expect(code('1')).toMatchObject({ title: 'Mission and Purposes', officialText: FIXTURE_HANDBOOK.pages[1]!.split('\n')[1], language: 'en' });
    expect(code('1.1.1')).toMatchObject({ title: 'The mission statement is published on the institution\'s website and reviewed every five years.', officialText: null }); // no heading: the statement is the title
    // Overlap: proposed in both windows, written once, with the complete text of the second.
    expect(code('1.2').officialText).toBe('The institution publicly states its commitment to academic freedom for faculty, staff, and students, and acts accordingly.');
    // Provenance: AI-made, with document, page and quote; verified where the quote is on the page.
    for (const r of reqs) expect(r).toMatchObject({ origin: 'ai', sourceDocumentId: v.handbook, reviewStatus: 'pending', reviewedBy: null, editedByPerson: false });
    expect(code('1.1')).toMatchObject({ sourcePage: 3, sourceQuote: 'formally approved statements of purpose are appropriate', quoteVerified: true });
    expect(code('1.9').quoteVerified).toBe(false);
    expect(reqs.filter((r) => r.quoteVerified).length).toBe(6);

    const notes = await notesOf(v.versionId);
    expect(notes.map((n) => [n.code, n.authority, n.quote_verified, n.origin])).toEqual([
      ['1.1', 'required', true, 'ai'], // Arabic: verified only after normalisation
      ['1.1.1', 'required', true, 'ai'],
      ['1.2.1', 'ai_suggested', false, 'ai'], // "required" without a verified quote is the AI's suggestion
    ]);
    expect(notes[0].source_document_id).toBe(v.guide);

    expect(done.report.stats).toEqual({
      pagesRead: 10, requirementsByLevel: { Standard: 1, Criterion: 3, Indicator: 3 }, requirements: 7, notes: 3,
      quoteVerified: 8, quoteVerifiedShare: 0.8, unverified: 2, orphans: 1, lowConfidence: 1, added: 10, updated: 0, keptHumanEdits: 0,
      dismissedSkipped: 0, gapsRecovered: 0, gapsUnresolved: 0, gapsConfirmedAbsent: 3, conflicts: 0, uncoveredPages: 0, recoveryRounds: 1,
      configItems: 0, configWritten: 0, configFlagged: 0,
    });
    // The model confirmed each gap absent, with its reason; the gaps link to the requirement cards they are about.
    const gaps = done.report.gaps as { key: string; kind: string; status: string; reason: string; requirementId: string | null }[];
    expect(gaps.map((g) => [g.key.replace(/:[^:]*$/, (m) => (m.length > 12 ? ':…' : m)), g.kind, g.status])).toEqual([
      ['req:3.9', 'missing_parent', 'confirmed_absent'], ['req:1.9', 'unverified_quote', 'confirmed_absent'], ['note:1.2.1:…', 'unverified_quote', 'confirmed_absent'],
    ]);
    expect(gaps.find((g) => g.key === 'req:1.9')).toMatchObject({ reason: 'It is not on these pages.', requirementId: code('1.9').id });
    expect((done.report.structure as { key_terms: unknown[] }).key_terms).toHaveLength(1);
    expect(done.report.mapping).toMatchObject({ skipped: expect.stringMatching(/no quality framework/), judged: 0, newItems: 0 });

    // The raw items are on record with how each fared.
    const logged = await q(`select kind, flags, quote_verified from extraction_item where analysis_run_id = $1 order by (payload->>'seq')::numeric`, [runId]);
    expect(logged).toHaveLength(12);
    expect(logged.find((l) => l.flags.includes('orphan_note'))).toBeUndefined();
    expect(logged.filter((l) => l.flags.includes('not_from_standards'))).toHaveLength(1);
    expect(logged.filter((l) => l.flags.includes('quote_not_found'))).toHaveLength(2);

    // Each step recorded its model calls in its job's result (PRD 15.3).
    const jobs = await q(`select status, result from job where type = 'analyse' and payload->>'runId' = $1`, [runId]);
    expect(jobs.every((j) => j.status === 'succeeded')).toBe(true);
    expect(jobs.flatMap((j) => j.result.ai ?? []).map((c: { task: string }) => c.task).sort()).toEqual(['config_survey', 'extract', 'extract', 'extract', 'recover', 'recover', 'recover', 'structure', 'survey', 'survey']);
  }, 120000);

  it('re-runs without duplicating, leaves what a person edited or made, and updates only untouched AI rows', async () => {
    const before = await tree(v.versionId);
    const one = before.find((r) => r.code === '1.1')!;
    await as('alo', (c) => updateRequirement(c, one.id, { title: 'Mission statement (checked)' }));
    const mine = await as('alo', (c) => createRequirement(c, { versionId: v.versionId, code: '5', levelLabel: 'Standard', title: 'Added by a person' }));
    // A person's own level names are kept too.
    await as('alo', (c) => updateVersionConfig(c, v.versionId, { levelLabels: ['Standard', 'Criterion', 'Indicator', 'Element'] }));

    setAiModelForTests(createFakeAiModel([fixtureResponder({ revised: true })]).model);
    const run = await as('alo', (c) => startAnalysis(c, v.versionId));
    await drain();
    const after = await tree(v.versionId);
    expect(after).toHaveLength(before.length + 1);
    const code = (c: string) => after.find((r) => r.code === c)!;
    // Edited by a person: same title, same wording, never re-parented.
    expect(code('1.1')).toMatchObject({ title: 'Mission statement (checked)', officialText: one.officialText, parentId: one.parentId, editedByPerson: true });
    // Untouched AI row: updated from the new run.
    expect(code('1.2').title).toBe('Integrity and academic freedom');
    expect(code('5')).toMatchObject({ origin: 'manual', title: 'Added by a person', id: mine.id });
    expect((await notesOf(v.versionId))).toHaveLength(3);
    expect((await as('alo', (c) => getVersion(c, v.versionId))).levelLabels).toEqual(['Standard', 'Criterion', 'Indicator', 'Element']);
    const done = await as('alo', (c) => getAnalysisRun(c, run.id));
    expect(done.status).toBe('succeeded');
    expect(done.report.stats).toMatchObject({ added: 0, keptHumanEdits: 1, updated: 9 });
    expect((done.report.structure as { levelLabelsApplied: unknown }).levelLabelsApplied).toBeNull();
    expect((await as('alo', (c) => listAnalysisRuns(c, v.versionId))).map((r) => r.id)).toEqual([run.id, runId]);
  }, 120000);

  it('the worker cannot touch a row a person changed, even directly', async () => {
    const one = (await tree(v.versionId)).find((r) => r.code === '1.1')!;
    await expect(w.db.as({ userId: w.ids.alo, institutionId: w.ids.inst, role: 'ams_worker' }, (c) => c.query(`update requirement set title = 'x' where id = $1`, [one.id])))
      .rejects.toThrow(/a person made, edited or reviewed/);
    await expect(w.db.as({ userId: w.ids.alo, institutionId: w.ids.inst, role: 'ams_worker' }, (c) => c.query(`update requirement set review_status = 'approved' where id = $1`, [one.id])))
      .rejects.toThrow(/permission denied/);
    await expect(w.db.as({ userId: w.ids.alo, institutionId: w.ids.inst, role: 'ams_worker' }, (c) => c.query(`delete from requirement where id = $1`, [one.id])))
      .rejects.toThrow(/permission denied/);
  });

  it('stops at the per-run budget as failed, with the reason, keeping what was written so far', async () => {
    const d = await draftWithSources('B');
    // $1 per call (10 input tokens at $100,000 per million); the limit lets four calls through.
    await w.db.su.query(`insert into ai_setting (institution_id, model, enabled, cap_unit, max_cost_usd_per_run, input_usd_per_mtok, output_usd_per_mtok) values ($1, 'm', true, 'usd', 3.5, 100000, 0)`, [w.ids.inst]);
    try {
      const fake = createFakeAiModel([fixtureResponder()]);
      setAiModelForTests(fake.model);
      const run = await as('alo', (c) => startAnalysis(c, d.versionId));
      await drain();
      expect(fake.calls).toHaveLength(4); // survey x2, structure, the first window
      const done = await as('alo', (c) => getAnalysisRun(c, run.id));
      expect(done.status).toBe('failed');
      expect(done.error).toMatch(/cost budget for this run is used up/);
      expect(done.usage).toMatchObject({ calls: 4, costUsd: 4 });
      expect(done.report.stoppedAt).toEqual({ stage: 'extract', cursor: 1 });
      // The first window's requirements are in the draft.
      expect((await tree(d.versionId)).map((r) => r.code)).toEqual(['1', '1.1', '1.1.1', '1.9', '1.2']);
      expect(done.report.stats).toMatchObject({ requirements: 5, notes: 1 });
    } finally {
      await w.db.su.query(`delete from ai_setting where institution_id = $1`, [w.ids.inst]);
    }
  }, 120000);

  it('a source with a file but no page text is read by the parser first: the agent queues extract_text and waits', async () => {
    const d = await as('alo', async (c) => {
      const acc = await createAccreditor(c, { name: 'Invented Council C', shortName: 'ICC', type: 'institutional' });
      const fw = await createFramework(c, { accreditorId: acc.id, name: 'S', scope: 'institution' });
      const ver = await createVersion(c, { frameworkId: fw.id, edition: 'C' });
      const doc = await addSourceDocument(c, { versionId: ver.id, title: FIXTURE_HANDBOOK.title, role: 'standards', authority: 'binding' });
      await uploadSourceFile(c, doc.id, { fileName: 'h.pdf', mime: 'application/pdf', bytes: pdf(FIXTURE_HANDBOOK.pages.slice(0, 4)) });
      return { versionId: ver.id, doc: doc.id };
    });
    setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
    const run = await as('alo', (c) => startAnalysis(c, d.versionId));
    // The read step queues extract_text and itself (delayed); the parser's job runs, then the read step finds the pages.
    const jobs: string[] = [];
    while (sent.length && jobs.length < 100) {
      jobs.push(sent[0]!.type);
      const { type, ...env } = sent.shift()!;
      await runJob(w.pool, type, env, handlers, { store: w.store, queue });
    }
    expect(jobs.slice(0, 4)).toEqual(['analyse', 'extract_text', 'analyse', 'analyse']);
    expect(jobs.filter((t) => t === 'extract_text')).toHaveLength(1);
    expect((await q(`select count(*)::int n from source_page where source_document_id = $1`, [d.doc]))[0].n).toBe(4);
    const done = await as('alo', (c) => getAnalysisRun(c, run.id));
    expect(done.status).toBe('succeeded');
    expect((await tree(d.versionId)).map((r) => r.code)).toContain('1.1.1');
  }, 120000);

  it('a read that fails for good, or never finishes, ends the run with a clear message', async () => {
    const mk = (edition: string) => as('alo', async (c) => {
      const acc = await createAccreditor(c, { name: `Invented Council ${edition}`, shortName: `IC${edition}`, type: 'institutional' });
      const fw = await createFramework(c, { accreditorId: acc.id, name: 'S', scope: 'institution' });
      const ver = await createVersion(c, { frameworkId: fw.id, edition });
      const doc = await addSourceDocument(c, { versionId: ver.id, title: 'Handbook', role: 'standards', authority: 'binding' });
      await uploadSourceFile(c, doc.id, { fileName: 'h.pdf', mime: 'application/pdf', bytes: pdf(['One page']) });
      return ver.id;
    });
    setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);

    // The reading job is lost its last attempt: the run fails with the job's own error.
    const a = await mk('R1');
    const runA = await as('alo', (c) => startAnalysis(c, a));
    const readStep = sent.shift()!;
    await runJob(w.pool, readStep.type, readStep, handlers, { store: w.store, queue }); // queues extract_text + a delayed read
    const extract = sent.shift()!;
    expect(extract.type).toBe('extract_text');
    await w.db.su.query(`update job set status = 'failed', attempts = 4, error = 'worker crashed' where id = $1`, [extract.jobId]);
    await drain();
    expect(await as('alo', (c) => getAnalysisRun(c, runA.id))).toMatchObject({ status: 'failed', error: 'reading "Handbook" failed: worker crashed' });

    // Nobody takes the reading job (no parser running): after the bounded number of waits the run fails.
    const b = await mk('R2');
    const runB = await as('alo', (c) => startAnalysis(c, b));
    let waits = 0;
    while (sent.length && waits < MAX_READ_WAITS + 5) {
      const { type, ...env } = sent.shift()!;
      if (type === 'extract_text') continue; // never picked up
      await runJob(w.pool, type, env, handlers, { store: w.store, queue });
      waits++;
    }
    expect(waits).toBe(MAX_READ_WAITS + 1);
    expect(await as('alo', (c) => getAnalysisRun(c, runB.id))).toMatchObject({ status: 'failed', error: expect.stringMatching(/did not finish in time.*parser service/) });
  }, 120000);

  it('refuses to start without a draft, sources, AI or permission, and while a run is active', async () => {
    setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
    // A published version is fixed.
    await expect(as('alo', (c) => startAnalysis(c, w.ids.wscuc!))).rejects.toThrow(ConflictError);
    await expect(as('contrib', (c) => startAnalysis(c, v.versionId))).rejects.toThrow(ForbiddenError);
    const empty = await as('alo', async (c) => {
      const acc = await createAccreditor(c, { name: 'Invented Council D', shortName: 'ICD', type: 'institutional' });
      const fw = await createFramework(c, { accreditorId: acc.id, name: 'S', scope: 'institution' });
      return (await createVersion(c, { frameworkId: fw.id, edition: 'D' })).id;
    });
    await expect(as('alo', (c) => startAnalysis(c, empty))).rejects.toThrow(/on the Docs tab first/);
    await w.db.su.query(`insert into ai_setting (institution_id, model, enabled) values ($1, 'm', false)`, [w.ids.inst]);
    await expect(as('alo', (c) => startAnalysis(c, v.versionId))).rejects.toThrow(/switched off/);
    await w.db.su.query(`delete from ai_setting where institution_id = $1`, [w.ids.inst]);

    const run = await as('alo', (c) => startAnalysis(c, v.versionId));
    await expect(as('alo', (c) => startAnalysis(c, v.versionId))).rejects.toThrow(/already running/);
    // Cancelled: the step in flight does nothing, nothing more is queued.
    await as('alo', (c) => cancelAnalysis(c, run.id));
    await expect(as('alo', (c) => cancelAnalysis(c, run.id))).rejects.toThrow(/already ended/);
    expect(await drain()).toBe(1);
    expect(sent).toHaveLength(0);
    expect((await as('alo', (c) => getAnalysisRun(c, run.id))).status).toBe('cancelled');
  }, 120000);

  it('a run whose version left draft stops, and the worker cannot write into a version in review', async () => {
    setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
    const run = await as('alo', (c) => startAnalysis(c, v.versionId));
    await w.db.su.query(`update framework_version set status = 'in_review' where id = $1`, [v.versionId]);
    await drain();
    const done = await as('alo', (c) => getAnalysisRun(c, run.id));
    expect(done).toMatchObject({ status: 'failed', error: expect.stringMatching(/in_review/) });
    const r = (await tree(v.versionId)).find((x) => x.code === '1.2')!;
    await expect(w.db.as({ userId: w.ids.alo, institutionId: w.ids.inst, role: 'ams_worker' }, (c) => c.query(`update requirement set title = 'x' where id = $1`, [r.id])))
      .rejects.toThrow(/only into a draft/);
    await w.db.su.query(`update framework_version set status = 'draft' where id = $1`, [v.versionId]);
  }, 120000);

  it('publishes an analysis-made draft as it stands: publishing is the review, no line is approved (DEC-022)', async () => {
    const p = await draftWithSources('P');
    setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
    await as('alo', (c) => startAnalysis(c, p.versionId));
    await drain();
    // The accreditor's lifecycle and vocabularies are configured by a person, as for any standard.
    await as('alo', async (c) => {
      await updateVersionConfig(c, p.versionId, {
        lifecycleTemplate: { phases: [{ type: 'self_study', name: 'Self-study', applies_to: ['reaffirmation'], milestones: [
          { key: 'submit', name: 'Submit', type: 'submission', deliverable: { report_template_key: 'report' }, due: { anchor: 'submission_date', offset_days: 0 } }] }] },
        decisionVocab: [{ code: 'ok', label: 'Accredited', outcome: 'accredited' }],
        findingVocab: [{ code: 'rec', label: 'Recommendation', requires_action: true }],
        responseVocab: [{ code: 'letter', label: 'Action letter', is_decision: true }],
      });
      await upsertReportTemplate(c, p.versionId, { key: 'report', name: 'Self-study', kind: 'self_study', structure: { sections: [{ key: 'A', title: 'Intro', block_type: 'narrative' }] } });
    });
    const before = await tree(p.versionId);
    expect(before.every((r) => r.origin === 'ai' && r.reviewStatus === 'pending')).toBe(true);

    // 1.9's quote was not found: a warning, not a problem.
    const check = await as('alo', (c) => validateVersion(c, p.versionId));
    expect(check).toMatchObject({ ok: true, warnings: [{ path: 'requirements', message: '1 requirement\'s quote was not found in the sources: 1.9' }] });
    await as('alo', (c) => submitForReview(c, p.versionId));
    const published = await as('admin', (c) => publishVersion(c, p.versionId));
    expect(published).toMatchObject({ status: 'published', publishedBy: w.ids.admin });
    // No row was marked approved: the version's publisher is the approval.
    expect((await tree(p.versionId)).every((r) => r.reviewStatus === 'pending' && r.reviewedBy === null)).toBe(true);
    expect((await notesOf(p.versionId)).every((n) => n.review_status === 'pending')).toBe(true);
  }, 120000);
});
