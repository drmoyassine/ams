// The intelligence report of an analysis run (step F1) and the run-readiness checks, end to end with a fake model:
// every section is filled from what the run stored and from the draft as it is now, every link points at something that
// exists, the wording never claims compliance or a score, and the report follows a person's later edits.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { reportToMarkdown, type AnalysisReport, type JobEnvelope, type ReportRef } from '@ams/shared';
import { ForbiddenError, type Ctx, type JobQueue } from '../../ctx.js';
import { buildWorld, type World } from '../../engagement/test-support.js';
import { createFakeAiModel, setAiModelForTests } from '../../ai/index.js';
import { handlers } from '../../jobs/handlers.js';
import { runJob } from '../../jobs/run.js';
import { addQualityItem, publishQualityVersion, setUpQualityFramework } from '../internal.js';
import { listRequirements } from '../requirements.js';
import { deleteRequirement } from '../../trash/delete.js';
import { addSourceDocument, addSourcePage } from '../sources.js';
import { createAccreditor, createFramework, createVersion } from '../versions.js';
import { FIXTURE_GUIDE, FIXTURE_HANDBOOK, fixtureResponder } from './fixture.js';
import { mappingResponder, type MappingScript } from './mapping-fixture.js';
import { analysisPreflight } from './preflight.js';
import { getAnalysisReport, getLatestAnalysisReport } from './report.js';
import { startAnalysis } from './runs.js';

let w: World;
const sent: JobEnvelope[] = [];
const queue: JobQueue = { send: async (_t, e) => { sent.push(e); } };
const as = <T>(who: string, fn: (c: Ctx) => Promise<T>) => w.as(who, (c) => fn({ ...c, queue, afterCommit: (f) => { void f(); } }));
async function drain(max = 200) {
  let n = 0;
  while (sent.length && n++ < max) await runJob(w.pool, 'analyse', sent.shift(), handlers, { store: w.store, queue });
  return n;
}
const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;

async function draftWithSources(edition: string) {
  return as('alo', async (c) => {
    const acc = await createAccreditor(c, { name: `Invented Council ${edition}`, shortName: `IR${edition}`, type: 'institutional' });
    const fw = await createFramework(c, { accreditorId: acc.id, name: 'Institutional Standards', scope: 'institution' });
    const v = await createVersion(c, { frameworkId: fw.id, edition });
    const hb = await addSourceDocument(c, { versionId: v.id, title: FIXTURE_HANDBOOK.title, role: 'standards', authority: 'binding' });
    for (const [i, text] of FIXTURE_HANDBOOK.pages.entries()) await addSourcePage(c, { documentId: hb.id, pageNo: i + 1, text, method: 'pdf_text' });
    const guide = await addSourceDocument(c, { versionId: v.id, title: FIXTURE_GUIDE.title, authority: 'interpretive', language: 'ar' });
    await addSourcePage(c, { documentId: guide.id, pageNo: 1, text: FIXTURE_GUIDE.pages[0]!, method: 'pdf_text' });
    return { versionId: v.id, frameworkId: fw.id, handbook: hb.id, guide: guide.id };
  });
}

const script = (): MappingScript => ({
  fit: { '1': { '1': 'partly_covers', '1.1': 'related' }, '1.1': { '1.1': 'covers' }, '1.2': { '1.2': 'partly_covers' }, '1.2.1': { '1': 'related' } },
  newItems: (codes) => (codes.includes('1.1.1') ? [
    { parent_code: '1.1', level_label: 'Sub-standard', code: '1.1.1', title: 'Published mission statement', description: 'The institution makes its mission statement public.', reason: 'No item asks for publication.', covers: [{ requirement: '1.1.1', relation: 'covers', reason: null }] },
    { parent_code: null, code: '2', title: 'Graduate follow-up', description: 'The institution follows up on its graduates.', reason: 'Nothing about graduates.', covers: [{ requirement: '3.9.1', relation: 'covers', reason: null }] },
  ] : []),
});

let v: Awaited<ReturnType<typeof draftWithSources>>;
let runId: string;
let report: AnalysisReport;

/** Every id and page a report points at must exist. */
async function expectLinksValid(r: AnalysisReport) {
  const refs: ReportRef[] = [
    ...r.requirements.quoteNotFound, ...r.requirements.lowConfidence, ...r.requirements.suggestedNotConfirmed,
    ...Object.values(r.gaps).flatMap((x) => (Array.isArray(x) ? x : [])), ...r.mapping.suggested.map((s) => s.ref), ...r.mapping.noSuggestion,
  ] as ReportRef[];
  for (const ref of refs) {
    if (ref.requirementId) expect(await q(`select 1 from requirement where id = $1 and framework_version_id = $2`, [ref.requirementId, r.versionId])).toHaveLength(1);
    if (ref.documentId && ref.page !== null) expect(await q(`select 1 from source_page where source_document_id = $1 and page_no = $2`, [ref.documentId, ref.page])).toHaveLength(1);
  }
  for (const c of r.checklist) {
    if (c.link?.requirementId) expect(await q(`select 1 from requirement where id = $1`, [c.link.requirementId])).toHaveLength(1);
    if (c.link?.documentId && c.link.page !== null) expect(await q(`select 1 from source_page where source_document_id = $1 and page_no = $2`, [c.link.documentId, c.link.page])).toHaveLength(1);
  }
  for (const n of r.mapping.newItems) expect(await q(`select 1 from iqf_item_proposal where id = $1`, [n.proposalId])).toHaveLength(1);
}

beforeAll(async () => {
  w = await buildWorld('report');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const iqf = (await as('admin', (c) => setUpQualityFramework(c))).versions[0]!.id;
  for (const [code, title, description] of [
    ['1', 'Mission and governance', ''], ['1.1', 'Mission, vision and values', 'The institution states its mission, vision and values.'], ['1.2', 'Integrity and ethics', ''],
    ['2', 'Teaching and learning', ''], ['2.1', 'Assessment of learning', 'How student learning is assessed.'],
  ] as const) await as('admin', (c) => addQualityItem(c, iqf, { code, title, description }));
  await as('admin', (c) => publishQualityVersion(c, iqf));
}, 120000);
afterEach(() => setAiModelForTests(null));
afterAll(() => w.close());

describe('the analysis report', () => {
  it('fills every section from a full run, and every link points at something that exists', async () => {
    v = await draftWithSources('A');
    setAiModelForTests(createFakeAiModel([mappingResponder(fixtureResponder(), script())]).model);
    const run = await as('alo', (c) => startAnalysis(c, v.versionId));
    runId = run.id;
    await drain();
    report = await as('alo', (c) => getAnalysisReport(c, runId));
    expect(report).toMatchObject({ reportVersion: 1, runId, versionId: v.versionId });

    // a. Summary: who, what was read, what was used. No key anywhere.
    const s = report.summary;
    expect(s).toMatchObject({ status: 'succeeded', error: null, startedBy: { name: 'alo' } });
    expect(s.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(s.sources.map((d) => [d.title, d.roleDecidedBy, d.language, d.pages, d.pagesNative, d.pagesOcr, d.pagesUnreadable])).toEqual([
      [FIXTURE_HANDBOOK.title, 'person', 'en', 9, 9, 0, 0], [FIXTURE_GUIDE.title, 'analysis', 'ar', 1, 1, 0, 0],
    ]);
    expect(s.used).toMatchObject({
      analysisModel: 'test', visionModel: null, embeddings: { used: false, model: null }, calls: 12, recoveryRounds: 1,
      promptVersions: { survey: 'v1', map: 'v1' },
    });
    expect(s.used.inputTokens + s.used.outputTokens).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(/api[_-]?key|secret|sk-/i);

    // b. Structure.
    expect(report.structure).toMatchObject({
      levelLabelsProposed: ['Standard', 'Criterion', 'Indicator'], levelLabelsWritten: ['Standard', 'Criterion', 'Indicator'],
      levelLabelsNow: ['Standard', 'Criterion', 'Indicator'], scope: 'The institution as a whole.',
      keyTerms: [{ term: 'mission statement', meaning: null }],
    });
    expect(report.structure!.numbering[1]).toEqual({ levelLabel: 'Criterion', examples: ['1.1', '1.2'] });

    // c. Requirements.
    const r = report.requirements;
    expect(r).toMatchObject({ total: 7, notes: 3, orphans: 1, keptYourEdits: 0, deleted: [] });
    expect(r.byLevel).toEqual([{ level: 'Standard', count: 1 }, { level: 'Criterion', count: 3 }, { level: 'Indicator', count: 3 }]);
    expect(r.quotes).toEqual({ found: 8, total: 10, percent: 80 });
    expect(r.atRun).toMatchObject({ requirements: 7, notes: 3, quotesFound: 8, quotesTotal: 10 });
    expect(r.quoteNotFound.map((i) => [i.kind, i.code, i.page])).toEqual([['note', '1.2.1', 9], ['requirement', '1.9', 5]]);
    expect(r.lowConfidence.map((i) => i.code)).toEqual(['1.9']);
    expect(r.suggestedNotConfirmed.map((i) => [i.kind, i.code])).toEqual([['note', '1.2.1']]);
    expect(r.quoteNotFound[1]).toMatchObject({ documentTitle: FIXTURE_HANDBOOK.title, requirementId: expect.any(String), text: 'The institution must operate a research vessel.' });

    // d. Gaps: the model confirmed three codes absent, each with its reason.
    expect(report.gaps.rounds).toBe(1);
    expect(report.gaps.confirmedAbsent).toHaveLength(3);
    expect(report.gaps.confirmedAbsent.every((g) => g.reason === 'It is not on these pages.')).toBe(true);
    expect(report.gaps.unresolved).toEqual([]);
    expect(report.gaps.conflicts).toEqual([]);

    // e. IQF mapping: by relation, no suggestion, new items, nothing decided yet; words only.
    const m = report.mapping;
    expect(m).toMatchObject({ ran: true, skipped: null, retrieval: 'words only', requirementsConsidered: 7, stopped: null });
    expect(m.byRelation).toEqual({ covers: 1, partly_covers: 2, related: 2 });
    expect(m.suggested.map((x) => [x.ref.code, x.links.map((l) => `${l.relation}:${l.internalCode}`)])).toEqual([
      ['1', ['partly_covers:1', 'related:1.1']], ['1.1', ['covers:1.1']], ['1.2', ['partly_covers:1.2']], ['1.2.1', ['related:1']],
    ]);
    expect(m.suggested[0]!.links[0]).toMatchObject({ internalTitle: 'Mission and governance', reviewStatus: 'pending' });
    expect(m.noSuggestion.map((x) => x.code)).toEqual(['1.1.1', '1.9', '3.9.1']);
    expect(m.newItems.map((n) => [n.code, n.status, n.covers.map((c) => c.externalCode)])).toEqual([['1.3', 'pending', ['1.1.1']], ['3', 'pending', ['3.9.1']]]);
    expect(m.decisions).toEqual({ linksWaiting: 5, linksAccepted: 0, linksDismissed: 0, newItemsWaiting: 2, newItemsAccepted: 0, newItemsDismissed: 0 });
    expect(JSON.stringify(m)).not.toMatch(/similarity|cosine/i);

    // f. Before you publish: concrete items, each with a link.
    const ids = report.checklist.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['quote_not_found', 'low_confidence', 'suggested_notes', 'links_waiting', 'new_items_waiting', 'no_suggestion', 'validation_warnings']));
    expect(report.checklist.find((c) => c.id === 'quote_not_found')).toMatchObject({ count: 2, label: '2 requirements or notes whose quote was not found in the source', level: 'look' });
    expect(report.checklist.find((c) => c.id === 'links_waiting')).toMatchObject({ count: 5, link: { tab: 'mappings' } });
    expect(report.validation.warnings[0]).toMatch(/quote was not found in the sources: 1.9/);

    await expectLinksValid(report);
  }, 120000);

  it('never says compliant, met, a score or readiness, in the report or its Markdown', () => {
    const text = `${JSON.stringify(report)}\n${reportToMarkdown(report, 'Analysis report')}`;
    for (const word of [/compliant/i, /\bmet\b/i, /\bscores?\b/i, /readiness/i, /predict/i, /\bready to publish\b/i]) expect(text).not.toMatch(word);
    const md = reportToMarkdown(report, 'Analysis report: Test');
    expect(md).toContain('## Before you publish');
    expect(md).toContain('8 of 10 quotes found in the source (80%)');
    expect(md).toContain('Candidates were found by words only');
  });

  it('is the latest finished run\'s report from the version, and null for a version never analysed', async () => {
    expect((await as('alo', (c) => getLatestAnalysisReport(c, v.versionId)))!.runId).toBe(runId);
    const other = await draftWithSources('B');
    expect(await as('alo', (c) => getLatestAnalysisReport(c, other.versionId))).toBeNull();
  });

  it('follows a person\'s later edit: deleting a requirement changes the counts, lists it as deleted and keeps the frozen run numbers', async () => {
    const reqs = await as('alo', (c) => listRequirements(c, v.versionId));
    await as('alo', (c) => deleteRequirement(c, reqs.find((x) => x.code === '1.9')!.id));
    const after = await as('alo', (c) => getAnalysisReport(c, runId));
    expect(after.requirements.total).toBe(6);
    expect(after.requirements.quotes).toEqual({ found: 8, total: 9, percent: 89 });
    expect(after.requirements.quoteNotFound.map((i) => i.code)).toEqual(['1.2.1']);
    expect(after.requirements.deleted).toEqual([{ kind: 'requirement', code: '1.9' }]);
    // The run's own numbers are as they were.
    expect(after.requirements.atRun).toMatchObject({ requirements: 7, quotesFound: 8, quotesTotal: 10 });
    expect(after.checklist.find((c) => c.id === 'quote_not_found')!.count).toBe(1);
    expect(after.mapping.noSuggestion.map((x) => x.code)).toEqual(['1.1.1', '3.9.1']);
    await expectLinksValid(after);
  });

  it('shows both wordings of a conflict side by side, and a failed run with its reason', async () => {
    const fx = await draftWithSources('C');
    const [row] = await q(
      `insert into analysis_run (institution_id, framework_version_id, status, stage, error, started_by, started_at, finished_at, report)
       values ($1, $2, 'failed', 'recover', 'the model stopped answering', $3, now() - interval '3 minutes', now(), $4::jsonb) returning id`,
      [w.ids.inst, fx.versionId, w.ids.alo, JSON.stringify({
        gaps: [{
          key: 'conflict:1.1', kind: 'conflict', status: 'conflict', code: '1.1', documentId: fx.handbook, page: 3, round: 0, attempts: 0, detail: 'different wording in two documents (pages 3 and 1)',
          reason: null, requirementId: null,
          variants: [{ documentId: fx.handbook, page: 3, text: 'The institution has a mission statement.' }, { documentId: fx.guide, page: 1, text: 'المؤسسة لديها بيان رسالة معتمد.' }],
        }],
      })]);
    const r = await as('alo', (c) => getAnalysisReport(c, row.id));
    expect(r.gaps.conflicts).toHaveLength(1);
    expect(r.gaps.conflicts[0]!.variants).toEqual([
      { documentId: fx.handbook, documentTitle: FIXTURE_HANDBOOK.title, page: 3, text: 'The institution has a mission statement.' },
      { documentId: fx.guide, documentTitle: FIXTURE_GUIDE.title, page: 1, text: 'المؤسسة لديها بيان رسالة معتمد.' },
    ]);
    expect(r.checklist.map((c) => c.id)).toEqual(expect.arrayContaining(['run_stopped', 'conflicts']));
    expect(r.checklist[0]).toMatchObject({ id: 'run_stopped' });
    expect(r.checklist[0]!.label).toContain('the model stopped answering');
    expect(r.summary).toMatchObject({ status: 'failed', error: 'the model stopped answering', durationSeconds: 180 });
    expect(r.structure).toBeNull();
    expect(r.mapping).toMatchObject({ ran: false, retrieval: 'words only' });
    expect(reportToMarkdown(r)).toContain('المؤسسة لديها بيان رسالة معتمد.');
  });

  it('needs framework:read, and the latest report too', async () => {
    await expect(as('outsider', (c) => getAnalysisReport(c, runId))).rejects.toThrow(ForbiddenError);
    await expect(as('outsider', (c) => getLatestAnalysisReport(c, v.versionId))).rejects.toThrow(ForbiddenError);
    expect((await as('contrib', (c) => getAnalysisReport(c, runId))).runId).toBe(runId);
  });
});

describe('run readiness (preflight)', () => {
  const settings = (sql: string, params: unknown[] = []) => w.db.su.query(sql, params);
  const reset = () => settings(`delete from ai_setting where institution_id = $1`, [w.ids.inst]);
  afterEach(async () => { await reset(); await settings(`delete from ai_account where institution_id = $1`, [w.ids.inst]); });
  const check = (p: Awaited<ReturnType<typeof analysisPreflight>>, id: string) => p.checks.find((c) => c.id === id)!;

  it('passes for a draft with sources when the AI is usable, noting lexical-only matching', async () => {
    setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
    const fx = await draftWithSources('P1');
    const p = await as('alo', (c) => analysisPreflight(c, fx.versionId));
    expect(p).toMatchObject({ canStart: true, firstProblem: null });
    expect(p.checks.map((c) => [c.id, c.status])).toEqual([
      ['draft', 'ok'], ['sources', 'ok'], ['config_docs', 'note'], ['ai_on', 'ok'], ['analysis_model', 'ok'], ['cap', 'note'], ['embeddings', 'note'],
    ]);
    expect(check(p, 'embeddings').message).toMatch(/words only/);
    expect(check(p, 'embeddings').fix).toEqual({ label: 'Open Settings -> AI', where: 'ai' });
  });

  it('names each blocker: not a draft, no sources, AI off, no model, no key, a dollar cap without a price, a run in progress', async () => {
    const empty = await as('alo', async (c) => {
      const acc = await createAccreditor(c, { name: 'Invented Council P2', shortName: 'IRP2', type: 'institutional' });
      const fw = await createFramework(c, { accreditorId: acc.id, name: 'Standards', scope: 'institution' });
      return (await createVersion(c, { frameworkId: fw.id, edition: 'P2' })).id;
    });
    let p = await as('alo', (c) => analysisPreflight(c, empty));
    expect(p).toMatchObject({ canStart: false, firstProblem: expect.stringMatching(/Add the accreditor's documents under Sources/) });
    expect(check(p, 'sources')).toMatchObject({ status: 'problem', fix: { where: 'sources' } });

    const fx = await draftWithSources('P3');
    // AI switched off.
    await settings(`insert into ai_setting (institution_id, model, enabled) values ($1, 'm', false)`, [w.ids.inst]);
    p = await as('alo', (c) => analysisPreflight(c, fx.versionId));
    expect(check(p, 'ai_on')).toMatchObject({ status: 'problem', fix: { where: 'ai' } });
    expect(p.canStart).toBe(false);
    // On, but an account with no model.
    const acct = (await settings(`insert into ai_account (institution_id, name, provider) values ($1, 'A', 'openrouter') returning id`, [w.ids.inst])).rows[0].id as string;
    await reset();
    await settings(`insert into ai_setting (institution_id, enabled, analysis_account_id) values ($1, true, $2)`, [w.ids.inst, acct]);
    p = await as('alo', (c) => analysisPreflight(c, fx.versionId));
    expect(check(p, 'analysis_model')).toMatchObject({ status: 'problem', message: expect.stringMatching(/no model/) });
    // A model, but a key that cannot be read (not decryptable) is a problem that never shows the key.
    await settings(`update ai_setting set model = 'some/model' where institution_id = $1`, [w.ids.inst]);
    await settings(`update ai_account set api_key_enc = 'not-a-valid-ciphertext', api_key_last4 = '1234' where id = $1`, [acct]);
    p = await as('alo', (c) => analysisPreflight(c, fx.versionId));
    expect(check(p, 'analysis_model')).toMatchObject({ status: 'problem', message: expect.stringMatching(/key could not be read/) });
    expect(JSON.stringify(p)).not.toContain('not-a-valid-ciphertext');
    // A dollar cap with no known price.
    await settings(`update ai_account set api_key_enc = null, api_key_last4 = null where id = $1`, [acct]);
    await settings(`update ai_setting set cap_unit = 'usd', max_cost_usd_per_run = 5 where institution_id = $1`, [w.ids.inst]);
    p = await as('alo', (c) => analysisPreflight(c, fx.versionId));
    expect(check(p, 'cap')).toMatchObject({ status: 'problem', message: expect.stringMatching(/price is not known/) });
    expect(p.firstProblem).toBeTruthy();
  });

  it('refuses a version that is not a draft, notes scanned pages, and reports a run already in progress', async () => {
    setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
    const fx = await draftWithSources('P4');
    await q(`update source_page set needs_ocr = true where source_document_id = $1 and page_no = 1`, [fx.handbook]);
    await settings(`insert into ai_setting (institution_id, model, enabled, ocr_enabled) values ($1, 'm', true, false)`, [w.ids.inst]);
    let p = await as('alo', (c) => analysisPreflight(c, fx.versionId));
    expect(check(p, 'reading')).toMatchObject({ status: 'note', message: expect.stringMatching(/reading them is switched off/) });
    expect(p.canStart).toBe(true);
    await q(`insert into analysis_run (institution_id, framework_version_id, status) values ($1, $2, 'running')`, [w.ids.inst, fx.versionId]);
    p = await as('alo', (c) => analysisPreflight(c, fx.versionId));
    expect(check(p, 'running')).toMatchObject({ status: 'problem' });
    await q(`update analysis_run set status = 'succeeded' where framework_version_id = $1`, [fx.versionId]);
    await q(`update framework_version set status = 'in_review' where id = $1`, [fx.versionId]);
    p = await as('alo', (c) => analysisPreflight(c, fx.versionId));
    expect(check(p, 'draft')).toMatchObject({ status: 'problem', message: expect.stringMatching(/Only a draft/) });
  });

  it('needs framework:write', async () => {
    const fx = await draftWithSources('P5');
    await expect(as('contrib', (c) => analysisPreflight(c, fx.versionId))).rejects.toThrow(ForbiddenError);
  });
});
