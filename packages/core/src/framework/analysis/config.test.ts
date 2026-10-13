// Compiler step H end to end with a fake model: the analysis also reads policy, report-template and guidance documents and
// writes the lifecycle, vocabularies and report templates into the draft as proposals; human edits win; publishing is the gate.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AnalysisConfig, JobEnvelope } from '@ams/shared';
import { ConflictError, type Ctx, type JobQueue } from '../../ctx.js';
import { buildWorld, type World } from '../../engagement/test-support.js';
import { createFakeAiModel, setAiModelForTests } from '../../ai/index.js';
import { handlers } from '../../jobs/handlers.js';
import { runJob } from '../../jobs/run.js';
import { addSourceDocument, addSourcePage } from '../sources.js';
import { getVersion } from '../common.js';
import { deleteReportTemplate, listReportTemplates, upsertReportTemplate } from '../templates.js';
import { createAccreditor, createFramework, createVersion, updateVersionConfig, validateVersion } from '../versions.js';
import { configResponder, FIXTURE_ARABIC_POLICY, FIXTURE_POLICY, FIXTURE_TEMPLATE_DOC } from './config-fixture.js';
import { analysisPreflight } from './preflight.js';
import { getAnalysisReport } from './report.js';
import { getAnalysisRun, startAnalysis } from './runs.js';

let w: World;
const sent: JobEnvelope[] = [];
const queue: JobQueue = { send: async (_t, e) => { sent.push(e); } };
const as = <T>(who: string, fn: (c: Ctx) => Promise<T>) => w.as(who, (c) => fn({ ...c, queue, afterCommit: (f) => { void f(); } }));
const runOne = (env: JobEnvelope) => runJob(w.pool, 'analyse', env, handlers, { store: w.store, queue });
async function drain(max = 200) {
  let n = 0;
  while (sent.length && n++ < max) await runOne(sent.shift()!);
  return n;
}
const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;

let editions = 0;
type DocSpec = { title: string; role: 'policy_procedure' | 'report_template' | 'guidance' | 'standards'; pages: string[]; language?: string };
const POLICY: DocSpec = { title: FIXTURE_POLICY.title, role: 'policy_procedure', pages: FIXTURE_POLICY.pages };
const TEMPLATE: DocSpec = { title: FIXTURE_TEMPLATE_DOC.title, role: 'report_template', pages: FIXTURE_TEMPLATE_DOC.pages };
const ARABIC: DocSpec = { title: FIXTURE_ARABIC_POLICY.title, role: 'policy_procedure', pages: FIXTURE_ARABIC_POLICY.pages, language: 'ar' };

async function draft(docs: DocSpec[]) {
  const edition = `H${++editions}`;
  return as('alo', async (c) => {
    const acc = await createAccreditor(c, { name: `Invented Authority ${edition}`, shortName: `IA${edition}`, type: 'institutional' });
    const fw = await createFramework(c, { accreditorId: acc.id, name: 'Process Rules', scope: 'institution' });
    const v = await createVersion(c, { frameworkId: fw.id, edition });
    const ids: string[] = [];
    for (const d of docs) {
      const doc = await addSourceDocument(c, { versionId: v.id, title: d.title, role: d.role, authority: 'interpretive', ...(d.language ? { language: d.language } : {}) });
      for (const [i, text] of d.pages.entries()) await addSourcePage(c, { documentId: doc.id, pageNo: i + 1, text, method: 'pdf_text' });
      ids.push(doc.id);
    }
    return { versionId: v.id, docs: ids };
  });
}
const lifecycleOf = async (versionId: string) => (await as('alo', (c) => getVersion(c, versionId))).lifecycleTemplate as { phases: { name: string; type: string; applies_to: string[]; milestones: Record<string, unknown>[] }[] };

async function analyse(versionId: string, responder = configResponder()) {
  const fake = createFakeAiModel([responder.reply]);
  setAiModelForTests(fake.model);
  const run = await as('alo', (c) => startAnalysis(c, versionId));
  const jobs = await drain();
  return { run: await as('alo', (c) => getAnalysisRun(c, run.id)), jobs, calls: fake.calls.length, responder };
}
const stagesOf = async (runId: string) => (await q(`select payload->>'stage' s from job where type = 'analyse' and payload->>'runId' = $1 order by created_at, id`, [runId])).map((r) => r.s as string);
const configOfRun = (run: { report: Record<string, unknown> }) => run.report.config as AnalysisConfig;

beforeAll(async () => {
  w = await buildWorld('config');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
}, 120000);
afterEach(async () => { setAiModelForTests(null); await w.db.su.query(`delete from ai_setting where institution_id = $1`, [w.ids.inst]); });
afterAll(() => w.close());

describe('configuration from policy and template documents (step H)', () => {
  let v: Awaited<ReturnType<typeof draft>>;
  let runId: string;

  it('reads the policy and template documents in its own stages and writes the lifecycle, vocabularies and a template, with verified quotes', async () => {
    v = await draft([POLICY, TEMPLATE]);
    const { run, calls, responder } = await analyse(v.versionId);
    runId = run.id;
    expect(run).toMatchObject({ status: 'succeeded', error: null });
    expect(run.promptVersions).toMatchObject({ config_survey: 'v1', lifecycle: 'v1', vocab: 'v1', template: 'v1' });

    // Stage routing: the configuration stages run after write and before the mapping (which ends at once here).
    expect(await stagesOf(run.id)).toEqual([
      'read', 'read', 'survey', 'survey', 'structure', 'write',
      'config_survey', 'config_survey', 'config_extract', 'config_extract', 'config_extract', 'config_write',
      'embed', 'finalise',
    ]);
    // read x0, survey x2, structure, config survey x2, windows: policy lifecycle, policy vocabularies, the form's template.
    expect(calls).toBe(8);
    expect(responder.tasks).toEqual(['config_survey', 'config_survey', 'lifecycle', 'vocab', 'template']);
    expect(run.progress).toMatchObject({ configDocsTotal: 2, configDocsDone: 2, configWindowsTotal: 3, configWindowsDone: 3, configItems: 24 });

    // ---- lifecycle: phases in process order, steps in reading order, names as printed
    const life = await lifecycleOf(v.versionId);
    expect(life.phases.map((p) => [p.type, p.name, p.applies_to])).toEqual([
      ['eligibility', 'Becoming eligible', ['initial', 'reaffirmation']], ['self_study', 'The self-study', ['initial', 'reaffirmation']],
      ['review', 'The review', ['initial', 'reaffirmation']], ['maintenance', 'After a decision', ['initial', 'reaffirmation']],
    ]);
    const steps = life.phases.flatMap((p) => p.milestones);
    expect(steps.map((m) => m.name)).toEqual(['has graduated at least one cohort of students', 'Self-Study Report', 'approved internally', 'site visit', 'Annual Report']);
    const report = steps.find((m) => m.name === 'Self-Study Report')!;
    // The due text is copied word for word, never turned into a date; a reviewer must set the rule.
    expect(report).toMatchObject({
      type: 'submission', due: null, due_text: 'no later than July 1 of the calendar year of the visit', due_pending: true, required: true,
      deliverable: { report_template_key: 'self_study_report_form' }, source_ref: { doc: FIXTURE_POLICY.title, page: 2 },
      description: 'The institution submits its Self-Study Report no later than July 1 of the calendar year of the visit.',
    });
    expect(steps.find((m) => m.name === 'Annual Report')).toMatchObject({ due: null, due_text: 'after its decision; every year', due_pending: true });
    // No timing in the document: nothing to set, no flag.
    expect(steps.find((m) => m.name === 'approved internally')).not.toHaveProperty('due_pending');
    expect(steps.find((m) => m.name === 'has graduated at least one cohort of students')).toMatchObject({ type: 'task' });
    // The step that is not in the document is not in the lifecycle.
    expect(JSON.stringify(life)).not.toMatch(/processing fee/);

    // ---- vocabularies: only what the document states, labels as printed, codes derived
    const ver = await as('alo', (c) => getVersion(c, v.versionId));
    expect(ver.decisionVocab).toEqual([
      { code: 'full_accreditation', label: 'Full Accreditation', outcome: 'accredited', term_years: 6 },
      { code: 'not_accredited', label: 'Not Accredited', outcome: 'not_accredited' },
    ]);
    expect(ver.findingVocab).toEqual([{ code: 'deficiency', label: 'Deficiency', requires_action: true }, { code: 'observation', label: 'Observation', requires_action: false }]);
    expect(ver.responseVocab).toEqual([{ code: 'draft_letter', label: 'Draft Letter', reply_required: true, reply_window_days: 30 }]);
    // The rating method lacks how ratings combine: kept out, not written as a half method.
    expect(ver.ratingMethod).toBeNull();

    // ---- the template: one per template document, nesting and numbering kept, block types from the allowed set
    const templates = await as('alo', (c) => listReportTemplates(c, v.versionId));
    expect(templates).toHaveLength(1);
    const tpl = templates[0]!;
    expect(tpl).toMatchObject({
      key: 'self_study_report_form', name: 'Self-Study Report Form', kind: 'self_study', language: 'en', requiresAttestation: true, origin: 'ai', reviewStatus: 'pending', editedByPerson: false,
      sourceDocumentId: v.docs[1], sourcePage: 1, quoteVerified: true,
    });
    expect(tpl.structure).toEqual({
      sections: [
        { key: 'A', title: 'Introduction', block_type: 'narrative', prompt: 'Describe the institution and its context.', word_limit: 500 },
        { key: 'B', title: 'Standards', block_type: 'narrative', children: [{ key: 'B.1', title: 'Mission', block_type: 'narrative' }] },
        { key: 'Table-1', title: 'Enrolment by year', block_type: 'data_table', columns: [{ key: 'year', label: 'Year', type: 'number' }, { key: 'headcount', label: 'Headcount', type: 'number' }] },
        { key: 'C', title: 'Appendices', block_type: 'appendix' },
        { key: 'S7', title: 'Attestation', block_type: 'attestation', prompt: 'The President signs a statement affirming the accuracy of this report.' },
      ],
    });

    // ---- the record: every proposal is logged with how it fared; flagged ones are in the report, not the configuration
    const logged = await q(`select kind, quote_verified, flags from extraction_item where analysis_run_id = $1 and kind in ('milestone','decision','finding_severity','response_type','report_section','metadata')`, [run.id]);
    expect(logged).toHaveLength(24);
    expect(logged.filter((l) => l.kind === 'report_section')).toHaveLength(7);
    expect(logged.filter((l) => l.flags.includes('quote_not_found'))).toHaveLength(1);
    const conf = configOfRun(run);
    expect(conf.skipped).toBeNull();
    expect(conf.survey.map((e) => [e.title, !!e.lifecycle, !!e.vocab, !!e.template])).toEqual([[FIXTURE_POLICY.title, true, true, false], [FIXTURE_TEMPLATE_DOC.title, false, false, true]]);
    expect(conf.windows).toEqual([
      { documentId: v.docs[0], target: 'lifecycle', pages: [1, 2, 3, 4, 5] }, { documentId: v.docs[0], target: 'vocab', pages: [4, 5, 6] },
      { documentId: v.docs[1], target: 'template', pages: [1, 2, 3] },
    ]);
    const flagged = conf.result!.items.filter((i) => i.status === 'flagged');
    expect(flagged.map((i) => [i.group, i.label])).toEqual([
      ['milestone', 'Pay the processing fee'], ['decision', 'Interim Report'], ['rating', 'Rating Scale'], ['section', 'Staff by rank'],
    ]);
    expect(flagged[0]!.reasons.join(' ')).toMatch(/quote was not found/);
    expect(flagged[1]!.reasons.join(' ')).toMatch(/no decision outcome/);
    expect(flagged[2]!.reasons.join(' ')).toMatch(/whole rating method/);
    expect(flagged[3]!.reasons.join(' ')).toMatch(/needs its columns/);
    expect(conf.result!.milestonesNeedingDueRule).toBe(3);
    expect(conf.result!.notFound).toEqual([]);
    expect(run.report.stats).toMatchObject({ configItems: 25, configWritten: 21, configFlagged: 4 });
    // Quotes carry their page: the Settings tabs show them.
    const found = (ver.configFound as Record<string, { items: Record<string, { page: number; quote: string; verified: boolean }> }>);
    expect(found.lifecycle_template!.items['self_study_report']).toMatchObject({ page: 2, verified: true, quote: 'submits its Self-Study Report no later than July 1' });
    expect(found.decision_vocab!.items['full_accreditation']).toMatchObject({ page: 4, verified: true });
    expect(found.report_templates!.items['self_study_report_form']).toMatchObject({ page: 1, sections: { 'B.1': { page: 1 } } });
    expect(ver.configEdited).toEqual({});
  }, 120000);

  it('puts what needs a reviewer into the checks before publishing: due rules the documents leave to a person, and the flagged items', async () => {
    const check = await as('alo', (c) => validateVersion(c, v.versionId));
    expect(check.ok).toBe(false);
    const issues = (check as { issues: { path: string; message: string }[] }).issues;
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringMatching(/"Self-Study Report": the reviewer must set the due rule \(the document says: "no later than July 1 of the calendar year of the visit"\)/),
      expect.stringMatching(/"site visit": the reviewer must set the due rule \(the document says: "during the autumn term"\)/),
      expect.stringMatching(/"Annual Report": the reviewer must set the due rule/),
    ]);
    expect(issues[0]!.path).toBe('lifecycle_template.phases[1].milestones[0].due');
    const report = await as('alo', (c) => getAnalysisReport(c, runId));
    const c = report.configuration;
    expect(c).toMatchObject({ ran: true, skipped: null, stopped: null, milestonesNeedingDueRule: 3, notFound: [] });
    expect(c.documents).toEqual([
      expect.objectContaining({ title: FIXTURE_POLICY.title, found: ['lifecycle (pages 1 to 5)', 'vocabularies (pages 4 to 6)'] }),
      expect.objectContaining({ title: FIXTURE_TEMPLATE_DOC.title, found: ['report template "Self-Study Report Form" (pages 1 to 3)'] }),
    ]);
    expect(c.sections.map((s) => [s.section, s.state, s.written, s.flagged, s.editedSince])).toEqual([
      ['lifecycle_template', 'written', 9, 1, false], ['decision_vocab', 'written', 2, 1, false], ['finding_vocab', 'written', 2, 0, false],
      ['response_vocab', 'written', 1, 0, false], ['rating_method', 'flagged_only', 0, 1, false], ['report_templates', 'written', 7, 1, false],
    ]);
    expect(c.items.find((i) => i.label === 'Self-Study Report')).toMatchObject({ group: 'milestone', dueText: 'no later than July 1 of the calendar year of the visit', page: 2, documentTitle: FIXTURE_POLICY.title, status: 'written' });
    expect(c.flagged).toHaveLength(4);
    const ids = report.checklist.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(['config_flagged', 'config_due_rules', 'validation_problems']));
    expect(report.checklist.find((x) => x.id === 'config_due_rules')).toMatchObject({ count: 3, level: 'look', link: { tab: 'settings', section: 'lifecycle' } });
    expect(report.checklist.find((x) => x.id === 'config_flagged')!.count).toBe(4);
    expect(report.validation.problems).toHaveLength(3);
  });

  it('leaves what a person edited or deleted alone on a re-run, and updates only what the analysis itself wrote', async () => {
    // A person renames a milestone, edits the template and deletes nothing yet.
    const life = await lifecycleOf(v.versionId);
    life.phases[0]!.name = 'Eligibility (checked by our office)';
    await as('alo', (c) => updateVersionConfig(c, v.versionId, { lifecycleTemplate: life as never }));
    const tpl = (await as('alo', (c) => listReportTemplates(c, v.versionId)))[0]!;
    await as('alo', (c) => upsertReportTemplate(c, v.versionId, { key: tpl.key, name: 'Our self-study form', kind: 'self_study', structure: tpl.structure as never, requires_attestation: true }));
    const before = await as('alo', (c) => getVersion(c, v.versionId));
    expect(before.configEdited).toEqual({ lifecycle_template: true });
    // The decision vocabulary is still the analysis's own: a person is about to change it elsewhere, not here.

    const { run } = await analyse(v.versionId);
    expect(run.status).toBe('succeeded');
    const after = await as('alo', (c) => getVersion(c, v.versionId));
    expect(after.lifecycleTemplate).toEqual(before.lifecycleTemplate); // the person's lifecycle, untouched
    const [tpl2] = await as('alo', (c) => listReportTemplates(c, v.versionId));
    expect(tpl2).toMatchObject({ name: 'Our self-study form', editedByPerson: true });
    expect(after.decisionVocab).toEqual(before.decisionVocab); // rewritten from the same documents: same content
    const cfg = configOfRun(run).result!;
    expect(cfg.sections.find((s) => s.section === 'lifecycle_template')).toMatchObject({ state: 'kept_your_edits', written: 0 });
    expect(cfg.sections.find((s) => s.section === 'report_templates')).toMatchObject({ state: 'kept_your_edits', written: 0 });
    expect(cfg.sections.find((s) => s.section === 'decision_vocab')).toMatchObject({ state: 'written' });
    expect(cfg.items.filter((i) => i.status === 'kept').every((i) => /left as it is/.test(i.reasons.join(' ')))).toBe(true);
    const report = await as('alo', (c) => getAnalysisReport(c, run.id));
    expect(report.configuration.sections.find((s) => s.section === 'lifecycle_template')).toMatchObject({ editedSince: true });
    expect(report.checklist.find((x) => x.id === 'config_kept')).toMatchObject({ level: 'info' });

    // A template a person deletes is not added back; the report says so.
    await as('alo', (c) => deleteReportTemplate(c, v.versionId, tpl.key));
    const again = await analyse(v.versionId);
    expect(await as('alo', (c) => listReportTemplates(c, v.versionId))).toHaveLength(0);
    expect(configOfRun(again.run).result!.deletedByPerson).toEqual(['Self-Study Report Form']);
    // The database says the same to the worker, whatever the code does.
    const asWorker = { userId: w.ids.alo, institutionId: w.ids.inst, role: 'ams_worker' as const };
    await expect(w.db.as(asWorker, (c) => c.query(`update framework_version set lifecycle_template = '{}' where id = $1`, [v.versionId]))).rejects.toThrow(/a person edited the lifecycle_template/);
  }, 120000);

  it('keeps a part that a person or an import made, even when the analysis never wrote it', async () => {
    const d = await draft([POLICY]);
    await as('alo', (c) => updateVersionConfig(c, d.versionId, { findingVocab: [{ code: 'concern', label: 'Concern', requires_action: true }] }));
    const { run } = await analyse(d.versionId);
    const ver = await as('alo', (c) => getVersion(c, d.versionId));
    expect(ver.findingVocab).toEqual([{ code: 'concern', label: 'Concern', requires_action: true }]);
    expect(ver.decisionVocab).toHaveLength(2);
    expect(configOfRun(run).result!.sections.find((s) => s.section === 'finding_vocab')).toMatchObject({ state: 'kept_your_edits', written: 0 });
  }, 120000);

  it('reads an Arabic policy: names stay as printed, quotes match through the diacritics, codes and keys are derived', async () => {
    const d = await draft([ARABIC]);
    const { run } = await analyse(d.versionId);
    expect(run.status).toBe('succeeded');
    const life = await lifecycleOf(d.versionId);
    // The document names no stage: it is named after its type, flagged for a person to rename.
    expect(life.phases).toHaveLength(1);
    expect(life.phases[0]).toMatchObject({ type: 'self_study', name: 'Self-study' });
    expect(life.phases[0]!.milestones[0]).toMatchObject({
      key: 'self_study_1', name: 'تقرير الدراسة الذاتية', type: 'submission', due: null, due_text: 'قبل زيارة الفريق بثلاثين يومًا', due_pending: true,
      source_ref: { doc: FIXTURE_ARABIC_POLICY.title, page: 1 },
    });
    const ver = await as('alo', (c) => getVersion(c, d.versionId));
    expect(ver.decisionVocab).toEqual([
      { code: 'decision_1', label: 'اعتماد كامل', outcome: 'accredited' }, { code: 'decision_2', label: 'عدم اعتماد', outcome: 'not_accredited' },
    ]);
    const items = configOfRun(run).result!.items;
    expect(items.find((i) => i.group === 'phase')!.reasons.join(' ')).toMatch(/does not name this stage/);
    expect(items.filter((i) => i.status === 'written').every((i) => i.page >= 1 && i.quote.length > 0)).toBe(true);
    const logged = await q(`select quote_verified from extraction_item where analysis_run_id = $1 and kind <> 'requirement'`, [run.id]);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.every((l) => l.quote_verified)).toBe(true);
    // Nothing else was found: the report says what the documents did not contain.
    expect(items.map((i) => i.label).join(' ')).not.toMatch(/Deficiency/);
    const cfg = configOfRun(run).result!;
    expect(cfg.notFound).toEqual(expect.arrayContaining(['No finding vocabulary was found in the documents.', 'No report template was found in the documents.']));
  }, 120000);

  it('says so when there is no policy, template or guidance document: the stages are skipped', async () => {
    const d = await draft([{ title: 'Handbook of Standards', role: 'standards', pages: ['Standard 1: The institution defines its purposes.'] }]);
    const responder = configResponder((o) => {
      const s = JSON.stringify(o);
      if (s.includes('what the document is, one of')) return { role: 'standards', language: 'en', outline: [], confidence: 0.9 };
      if (s.includes('Work out how the accreditor organises its requirements')) return { level_labels: ['Standard'], numbering: [], key_terms: [], scope: null, confidence: 0.5 };
      if (s.includes('You are extracting an accreditation body')) return { items: [] };
      throw new Error('unexpected prompt');
    });
    const { run } = await analyse(d.versionId, responder);
    expect(run.status).toBe('succeeded');
    expect((await stagesOf(run.id)).filter((s) => s.startsWith('config'))).toEqual([]);
    expect(configOfRun(run).skipped).toMatch(/no policy and procedure, report template or guidance document/);
    const report = await as('alo', (c) => getAnalysisReport(c, run.id));
    expect(report.configuration).toMatchObject({ ran: false, skipped: expect.stringMatching(/nothing to read/), items: [], sections: [] });
    expect(report.checklist.map((x) => x.id)).not.toContain('config_flagged');
  }, 120000);

  it('stops at the spend limit in the middle of the configuration reading and keeps what was found so far', async () => {
    const d = await draft([POLICY, TEMPLATE]);
    // $1 per call; seven calls go through: both surveys, structure, both config surveys, the lifecycle window and the vocabulary window.
    await w.db.su.query(`insert into ai_setting (institution_id, model, enabled, cap_unit, max_cost_usd_per_run, input_usd_per_mtok, output_usd_per_mtok) values ($1, 'm', true, 'usd', 6.5, 100000, 0)`, [w.ids.inst]);
    const { run, calls } = await analyse(d.versionId);
    expect(calls).toBe(7);
    // The spend limit ends the configuration reading, not the run: what was read is written, the template window was not.
    expect(run.status).toBe('succeeded');
    // The third window's job is the one the limit stops; the next job writes.
    expect(await stagesOf(run.id)).toContain('config_write');
    expect(configOfRun(run).stopped).toBe('budget');
    expect((await lifecycleOf(d.versionId)).phases.length).toBeGreaterThan(0);
    expect((await as('alo', (c) => getVersion(c, d.versionId))).decisionVocab).toHaveLength(2);
    expect(await as('alo', (c) => listReportTemplates(c, d.versionId))).toHaveLength(0);
    const report = await as('alo', (c) => getAnalysisReport(c, run.id));
    expect(report.configuration.stopped).toMatch(/spend limit/);
    expect(report.configuration.sections.find((s) => s.section === 'report_templates')).toMatchObject({ state: 'nothing_found' });
  }, 120000);

  it('resumes after a failed configuration job exactly where it stopped', async () => {
    const d = await draft([POLICY, TEMPLATE]);
    const responder = configResponder(undefined, { failOnce: 'vocab' });
    setAiModelForTests(createFakeAiModel([responder.reply]).model);
    const started = await as('alo', (c) => startAnalysis(c, d.versionId));
    let failed: JobEnvelope | undefined;
    while (sent.length && !failed) {
      const env = sent.shift()!;
      try { await runOne(env); } catch { failed = env; }
    }
    const [failedJob] = await q(`select status, attempts, payload from job where id = $1`, [failed!.jobId]);
    expect(failedJob).toMatchObject({ status: 'failed', attempts: 1, payload: { stage: 'config_extract', cursor: 1 } });
    expect(await as('alo', (c) => getAnalysisRun(c, started.id))).toMatchObject({ status: 'running', stage: 'config_extract', progress: { cursor: 1, configWindowsDone: 1 } });
    expect(sent).toHaveLength(0);
    // The window before it was kept; the queue retries the failed one and the run ends as if nothing had happened.
    expect((await q(`select count(*)::int n from extraction_item where analysis_run_id = $1 and kind = 'milestone'`, [started.id]))[0].n).toBe(6);
    await runOne(failed!);
    await drain();
    const done = await as('alo', (c) => getAnalysisRun(c, started.id));
    expect(done.status).toBe('succeeded');
    expect(await as('alo', (c) => listReportTemplates(c, d.versionId))).toHaveLength(1);
    expect((await q(`select count(*)::int n from extraction_item where analysis_run_id = $1 and kind = 'decision'`, [started.id]))[0].n).toBe(3);
  }, 120000);

  it('a run whose version left draft stops: the configuration is never written into a version in review or a published one', async () => {
    const d = await draft([POLICY]);
    setAiModelForTests(createFakeAiModel([configResponder().reply]).model);
    const run = await as('alo', (c) => startAnalysis(c, d.versionId));
    // Run up to the configuration reading, then take the version out of draft.
    while (sent.length) {
      const env = sent.shift()!;
      await runOne(env);
      if ((await as('alo', (c) => getAnalysisRun(c, run.id))).stage === 'config_extract') break;
    }
    await w.db.su.query(`update framework_version set status = 'in_review' where id = $1`, [d.versionId]);
    await drain();
    expect(await as('alo', (c) => getAnalysisRun(c, run.id))).toMatchObject({ status: 'failed', error: expect.stringMatching(/in_review/) });
    expect((await as('alo', (c) => getVersion(c, d.versionId))).decisionVocab).toEqual([]);
    await w.db.su.query(`update framework_version set status = 'draft' where id = $1`, [d.versionId]);
    await expect(as('alo', (c) => startAnalysis(c, w.ids.wscuc!))).rejects.toThrow(ConflictError);
  }, 120000);

  it('names the documents that can supply configuration in the readiness checks, as information', async () => {
    const d = await draft([POLICY, TEMPLATE, { title: 'Notes', role: 'guidance', pages: ['Some notes.'] }, { title: 'Standards', role: 'standards', pages: ['One.'] }]);
    const pre = await as('alo', (c) => analysisPreflight(c, d.versionId));
    expect(pre.checks.find((x) => x.id === 'config_docs')).toMatchObject({ status: 'ok', message: expect.stringMatching(/Documents that can supply configuration: 3 /) });
    const none = await draft([{ title: 'Standards', role: 'standards', pages: ['One.'] }]);
    const pre0 = await as('alo', (c) => analysisPreflight(c, none.versionId));
    expect(pre0.checks.find((x) => x.id === 'config_docs')).toMatchObject({ status: 'note', message: expect.stringMatching(/: 0\./) });
    // Informational only: it never blocks a run.
    expect(pre0.checks.filter((x) => x.status === 'problem').map((x) => x.id)).not.toContain('config_docs');
  }, 120000);
});
