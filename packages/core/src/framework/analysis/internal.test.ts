// The institution's own framework from its own documents (TASK-107): the analysis runs on the internal quality
// framework's draft exactly as on an external standard's sources — same stages, the internal prompt variants, the
// institution's own level names kept — and the wording stage proposes better wording for the items a person wrote,
// as diffs a person accepts or declines. Nothing is applied by itself, and a published version is never touched.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobEnvelope, JobType } from '@ams/shared';
import { type Ctx, type JobQueue } from '../../ctx.js';
import { buildWorld, type World } from '../../engagement/test-support.js';
import { createFakeAiModel, setAiModelForTests } from '../../ai/index.js';
import { handlers } from '../../jobs/handlers.js';
import { runJob } from '../../jobs/run.js';
import { getVersion } from '../common.js';
import { listRequirements, updateRequirement } from '../requirements.js';
import { addSourceDocument, addSourcePage } from '../sources.js';
import { newQualityVersion, publishQualityVersion, setUpQualityFramework } from '../internal.js';
import { decideWordingProposal, listWordingProposals } from '../wording-proposals.js';
import { FIXTURE_MANUAL, internalResponder } from './internal-fixture.js';
import { getAnalysisRun, startAnalysis } from './runs.js';
import { analysisPreflight } from './preflight.js';

let w: World;
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
const tree = (versionId: string) => as('alo', (c) => listRequirements(c, versionId));
const item11 = async (versionId: string) => (await tree(versionId)).find((r) => r.code === '1.1')!;

beforeAll(async () => {
  w = await buildWorld('iqfanalysis');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
}, 120000);
afterEach(() => setAiModelForTests(null));
afterAll(() => w.close());

describe('the internal quality framework from documents', () => {
  let versionId: string;
  let docId: string;
  let runId: string;

  it('refuses to start while the framework has no documents, and says where to add them', async () => {
    const { versions } = await as('alo', (c) => setUpQualityFramework(c, { template: true }));
    versionId = versions[0]!.id;
    await expect(as('alo', (c) => startAnalysis(c, versionId))).rejects.toThrow('add the institution\'s documents under Docs first');
    const pre = await as('alo', (c) => analysisPreflight(c, versionId));
    expect(pre.checks.find((k) => k.id === 'sources')).toMatchObject({
      status: 'problem', message: 'Add the institution\'s documents under Docs first.', fix: { label: 'Add documents', where: 'docs' },
    });
  });

  it('runs the stages with the internal prompts, keeps the institution\'s level names, and proposes wording as a diff', async () => {
    // One item given its wording by a person (the rest of the template holds titles only), and the institution's policy manual.
    const doc = await as('alo', async (c) => {
      await updateRequirement(c, (await item11(versionId)).id, { officialText: 'The institution defines its mission and reviews it every five years.' });
      const d = await addSourceDocument(c, { versionId, title: FIXTURE_MANUAL.title, authority: 'binding' }); // no role chosen: the survey decides
      for (const [i, text] of FIXTURE_MANUAL.pages.entries()) await addSourcePage(c, { documentId: d.id, pageNo: i + 1, text, method: 'pdf_text' });
      return d;
    });
    docId = doc.id;

    const fake = createFakeAiModel([internalResponder()]);
    setAiModelForTests(fake.model);
    const run = await as('alo', (c) => startAnalysis(c, versionId));
    runId = run.id;
    expect(run).toMatchObject({ status: 'queued', stage: 'read', promptVersions: { survey: 'v2', structure: 'v2', extract: 'v2', recover: 'v2', map: 'v1', newiqf: 'v1', wording: 'v1' } });
    // One job per step: read, survey, structure, extract (one window), gaps, write, wording, embed (skipped), finalise.
    expect(await drain()).toBe(9);
    expect(fake.calls).toHaveLength(4);

    const done = await as('alo', (c) => getAnalysisRun(c, runId));
    expect(done).toMatchObject({ status: 'succeeded', error: null, model: 'test' });
    expect(done.progress).toMatchObject({ windowsTotal: 1, windowsDone: 1, items: 2, wordingProposed: 1 });
    expect(done.usage).toEqual({ inputTokens: 40, outputTokens: 20, costUsd: null, calls: 4 });

    // The institution names its own levels: the model's are recorded on the run, never applied (DEC-016).
    expect((done.report.structure as { level_labels: string[] }).level_labels).toEqual(['Policy', 'Section']);
    expect((await as('alo', (c) => getVersion(c, versionId))).levelLabels).toEqual(['Standard', 'Sub-standard']);

    // The framework maps onto nothing: it IS the frame.
    expect(String((done.report.mapping as { skipped: string }).skipped)).toContain('internal quality framework');

    // What the documents state is written into the draft like any extraction, its level following its depth.
    const reqs = await tree(versionId);
    expect(reqs.find((r) => r.code === 'QM-1')).toMatchObject({
      origin: 'ai', reviewStatus: 'pending', editedByPerson: false, quoteVerified: true, levelLabel: 'Standard',
      sourceDocumentId: docId, sourcePage: 1,
      officialText: 'The institution reviews its mission every five years and publishes the review on its website.',
    });
    expect(reqs.find((r) => r.code === 'QM-2')).toMatchObject({ quoteVerified: true, sourcePage: 2 });
    // The person's items are untouched (their levels were relabelled once, when the template was laid in).
    expect(reqs.find((r) => r.code === '1.2')).toMatchObject({ origin: 'manual', officialText: null });
    expect(done.report.stats).toMatchObject({ added: 2, wordingProposed: 1 });

    // The wording stage: exactly the proposal whose quote checks out, for the person's item — the model's other two
    // answers are refused (the quote is not on page 2) and dropped (QM-1 is the run's own work, not a person's).
    const proposals = await as('alo', (c) => listWordingProposals(c, versionId));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      requirementCode: '1.1', status: 'pending', analysisRunId: runId, sourceDocumentId: docId, sourcePage: 1,
      sourceQuote: 'reviews its mission every five years',
      currentText: 'The institution defines its mission and reviews it every five years.',
      proposedText: 'The institution defines its mission, reviews it every five years and publishes the review on its website.',
      reason: 'The policy adds that the review is published.', decidedBy: null, decidedAt: null,
    });

    // A person accepts: the wording lands on the item as one edit (back to review, undo reported), decided once.
    const decided = await as('alo', (c) => decideWordingProposal(c, proposals[0]!.id, { accept: true }));
    expect(decided).toMatchObject({ status: 'accepted' });
    expect(decided.decidedBy).not.toBeNull();
    expect(decided.decidedAt).not.toBeNull();
    expect((await item11(versionId)).officialText).toBe('The institution defines its mission, reviews it every five years and publishes the review on its website.');
    expect((await item11(versionId))).toMatchObject({ reviewStatus: 'pending', editedByPerson: true });
    await expect(as('alo', (c) => decideWordingProposal(c, proposals[0]!.id, { accept: true }))).rejects.toThrow('already been accepted');
  });

  it('declines, refuses an accept whose item has changed since, and leaves a published version alone', async () => {
    // A second analysis of the same draft proposes for 1.1 again — a sharpened variant of the accepted wording (the same
    // words would be no proposal at all).
    const fake = createFakeAiModel([internalResponder({ wordingText: 'The institution defines its mission, reviews it every five years, and publishes each review.' })]);
    setAiModelForTests(fake.model);
    const second = await as('alo', (c) => startAnalysis(c, versionId));
    await drain();
    expect((await as('alo', (c) => getAnalysisRun(c, second.id))).status).toBe('succeeded');
    const proposals = await as('alo', (c) => listWordingProposals(c, versionId));
    expect(proposals).toHaveLength(2); // the first run's, accepted; the second run's, pending
    const pending = proposals.find((p) => p.status === 'pending')!;
    expect(pending).toMatchObject({
      currentText: 'The institution defines its mission, reviews it every five years and publishes the review on its website.',
      sourceQuote: 'reviews its mission every five years',
    });

    // The item's wording changes while the proposal waits: accepting it would apply a diff no longer on offer.
    const item = await item11(versionId);
    await as('alo', (c) => updateRequirement(c, item.id, { officialText: 'The institution defines, reviews and publishes its mission.' }));
    await expect(as('alo', (c) => decideWordingProposal(c, pending.id, { accept: true }))).rejects.toThrow('changed since the proposal was made');

    // Declining needs no wording to match: it closes the proposal and names who declined it.
    const declined = await as('alo', (c) => decideWordingProposal(c, pending.id, { accept: false }));
    expect(declined).toMatchObject({ status: 'declined' });
    expect(declined.decidedBy).not.toBeNull();
    expect(declined.decidedAt).not.toBeNull();
    expect((await item11(versionId)).officialText).toBe('The institution defines, reviews and publishes its mission.');

    // Published: the analysis refuses to start and a person starts the next draft instead.
    await as('admin', (c) => publishQualityVersion(c, versionId));
    expect((await as('alo', (c) => getVersion(c, versionId))).status).toBe('published');
    await expect(as('alo', (c) => startAnalysis(c, versionId))).rejects.toThrow(/published and immutable/);
    const next = await as('admin', (c) => newQualityVersion(c));
    expect(next).toMatchObject({ status: 'draft', edition: '2' });
  });
});
