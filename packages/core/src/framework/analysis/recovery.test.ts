// Check and recover (PRD 15, step D) end to end with a fake model: the gap finder after the extraction, narrow recovery
// questions round by round, confirmed absences, the round and spend limits, resuming a failed step, and deletions a
// re-run remembers.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AnalysisGap, JobEnvelope } from '@ams/shared';
import type { Ctx, JobQueue } from '../../ctx.js';
import { buildWorld, type World } from '../../engagement/test-support.js';
import { createFakeAiModel, setAiModelForTests } from '../../ai/index.js';
import { handlers } from '../../jobs/handlers.js';
import { runJob } from '../../jobs/run.js';
import { deleteNote } from '../notes.js';
import { deleteRequirement, listRequirements } from '../requirements.js';
import { addSourceDocument, addSourcePage } from '../sources.js';
import { createAccreditor, createFramework, createVersion } from '../versions.js';
import { FIXTURE_GAPPY, gappyResponder } from './fixture.js';
import { getAnalysisRun, startAnalysis } from './runs.js';

let w: World;
const sent: JobEnvelope[] = [];
const queue: JobQueue = { send: async (_t, e) => { sent.push(e); } };
const as = <T>(who: string, fn: (c: Ctx) => Promise<T>) => w.as(who, (c) => fn({ ...c, queue, afterCommit: (f) => { void f(); } }));
const runOne = (env: JobEnvelope) => runJob(w.pool, 'analyse', env, handlers, { store: w.store, queue });
async function drain(max = 100) {
  let n = 0;
  while (sent.length && n++ < max) await runOne(sent.shift()!);
  return n;
}
const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;
const setRounds = (n: number | null) => (n === null
  ? w.db.su.query(`delete from ai_setting where institution_id = $1`, [w.ids.inst])
  : w.db.su.query(`insert into ai_setting (institution_id, model, enabled, max_recovery_rounds) values ($1, 'm', true, $2)
      on conflict (institution_id) do update set max_recovery_rounds = excluded.max_recovery_rounds`, [w.ids.inst, n]));

let editions = 0;
async function draft() {
  const edition = `G${++editions}`;
  return as('alo', async (c) => {
    const acc = await createAccreditor(c, { name: `Invented Board ${edition}`, shortName: `IB${edition}`, type: 'programmatic' });
    const fw = await createFramework(c, { accreditorId: acc.id, name: 'Teaching Standards', scope: 'program' });
    const v = await createVersion(c, { frameworkId: fw.id, edition });
    const doc = await addSourceDocument(c, { versionId: v.id, title: FIXTURE_GAPPY.title, role: 'standards', authority: 'binding' });
    for (const [i, text] of FIXTURE_GAPPY.pages.entries()) await addSourcePage(c, { documentId: doc.id, pageNo: i + 1, text, method: 'pdf_text' });
    return { versionId: v.id, doc: doc.id };
  });
}
async function analyse(versionId: string, responder: ReturnType<typeof gappyResponder>) {
  const fake = createFakeAiModel([responder.reply]);
  setAiModelForTests(fake.model);
  const run = await as('alo', (c) => startAnalysis(c, versionId));
  const jobs = await drain();
  return { run: await as('alo', (c) => getAnalysisRun(c, run.id)), jobs, calls: fake.calls.length };
}
const tree = (versionId: string) => as('alo', (c) => listRequirements(c, versionId));
const gapsOf = (run: { report: Record<string, unknown> }) => (run.report.gaps ?? []) as AnalysisGap[];
const status = (run: { report: Record<string, unknown> }) => Object.fromEntries(gapsOf(run).map((g) => [g.key, [g.kind, g.status, g.round]]));

beforeAll(async () => {
  w = await buildWorld('recovery');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
}, 120000);
afterEach(async () => { setAiModelForTests(null); await setRounds(null); });
afterAll(() => w.close());

describe('check and recover', () => {
  it('finds the requirement the extraction missed, confirms what is really absent, and re-cites a bad quote over two rounds', async () => {
    const d = await draft();
    const responder = gappyResponder();
    const { run, jobs, calls } = await analyse(d.versionId, responder);
    expect(run.status).toBe('succeeded');
    // read, survey, structure, extract, gaps, recover x3, gaps, recover, gaps, write, finalise.
    expect(jobs).toBe(13);
    expect(calls).toBe(7);

    const reqs = await tree(d.versionId);
    // 2.3 is in the draft, in its place between 2.2 and 2.4, with a verified quote from page 3. There is no 2.5.
    expect(reqs.map((r) => r.code)).toEqual(['2', '2.1', '2.2', '2.3', '2.4', '2.6']);
    expect(reqs.find((r) => r.code === '2.3')).toMatchObject({
      origin: 'ai', title: 'Feedback', officialText: 'Students receive timely feedback on assessed work so that they can improve their learning.',
      sourcePage: 3, sourceQuote: 'Students receive timely feedback on assessed work', quoteVerified: true, reviewStatus: 'pending', levelLabel: 'Criterion',
    });
    // 2.4 now carries the re-cited quote, which is on the page.
    expect(reqs.find((r) => r.code === '2.4')).toMatchObject({ sourceQuote: 'provides academic advising and learning support services', quoteVerified: true });

    expect(status(run)).toEqual({
      'req:2.3': ['numbering_gap', 'recovered', 1],
      'req:2.5': ['numbering_gap', 'confirmed_absent', 1],
      'req:2.4': ['unverified_quote', 'recovered', 2],
    });
    const absent = gapsOf(run).find((g) => g.key === 'req:2.5')!;
    expect(absent.reason).toBe('The numbering goes from 2.4 to 2.6; there is no 2.5.');
    expect(absent.attempts).toBe(1);
    // Confirmed absent is never asked again: 2.5 was asked once, 2.4 twice.
    expect(responder.questions.filter((x) => x.includes('2.5')).length).toBe(1);
    expect(responder.questions.filter((x) => x.includes('Re-cite the requirement coded')).length).toBe(2);
    // The table of contents (page 1) was never asked about.
    expect(responder.questions.some((x) => x.includes('page 1'))).toBe(false);
    // Links: the requirement card of each gap that has one.
    expect(gapsOf(run).find((g) => g.key === 'req:2.3')!.requirementId).toBe(reqs.find((r) => r.code === '2.3')!.id);
    expect(absent.requirementId).toBeNull();

    expect(run.report.stats).toMatchObject({ requirements: 6, notes: 1, gapsRecovered: 2, gapsUnresolved: 0, gapsConfirmedAbsent: 1, conflicts: 0, uncoveredPages: 0, recoveryRounds: 2, dismissedSkipped: 0 });
    expect(run.report.recovery).toMatchObject({ maxRounds: 2, stopped: 'no_gaps', rounds: [{ round: 1, open: 3, tasks: 3 }, { round: 2, open: 1, tasks: 1 }] });
    expect(run.progress).toMatchObject({ round: 2, maxRounds: 2 });
    // The recovery's raw answers are on record with the round they came from.
    const logged = await q(`select payload->>'round' as round, payload->>'gap' as gap, quote_verified from extraction_item where analysis_run_id = $1 and payload ? 'round' order by created_at, id`, [run.id]);
    expect(logged.map((l) => [l.round, l.gap, l.quote_verified])).toEqual([['1', 'req:2.3', true], ['1', 'req:2.4', false], ['2', 'req:2.4', true]]);
  }, 120000);

  it('respects the round limit: one round leaves the bad quote unresolved; none asks nothing', async () => {
    await setRounds(1);
    const one = await analyse((await draft()).versionId, gappyResponder());
    expect(one.calls).toBe(6);
    expect(status(one.run)['req:2.4']).toEqual(['unverified_quote', 'unresolved', 1]);
    expect(one.run.report.recovery).toMatchObject({ maxRounds: 1, stopped: 'max_rounds' });
    expect(one.run.report.stats).toMatchObject({ gapsRecovered: 1, gapsUnresolved: 1, gapsConfirmedAbsent: 1, recoveryRounds: 1 });

    await setRounds(0);
    const none = await analyse((await draft()).versionId, gappyResponder());
    expect(none.calls).toBe(3);
    expect(none.run.status).toBe('succeeded');
    // The gaps are still found and reported, as unresolved.
    expect(status(none.run)).toEqual({ 'req:2.3': ['numbering_gap', 'unresolved', 0], 'req:2.5': ['numbering_gap', 'unresolved', 0], 'req:2.4': ['unverified_quote', 'unresolved', 0] });
    expect(none.run.report.stats).toMatchObject({ gapsUnresolved: 3, recoveryRounds: 0 });
  }, 120000);

  it('stops after a round that finds nothing new', async () => {
    // The model now says 2.3 is not there either, and keeps re-citing 2.4 wrongly: round 2 adds nothing, so no round 3
    // would run even with more rounds allowed.
    await setRounds(5);
    const responder = gappyResponder({ absent23: true });
    const wrong = { ...responder, reply: (o: unknown) => JSON.parse(JSON.stringify(responder.reply(o)).replaceAll('provides academic advising and learning support services', 'Advising is offered to every student in every term of study')) as object };
    const r = await analyse((await draft()).versionId, wrong);
    expect(r.run.report.recovery).toMatchObject({ stopped: 'nothing_new', rounds: [{ round: 1 }, { round: 2 }] });
    expect(status(r.run)).toMatchObject({ 'req:2.3': ['numbering_gap', 'confirmed_absent', 1], 'req:2.4': ['unverified_quote', 'unresolved', 2] });
  }, 120000);

  it('stops recovering when the spend limit is reached, and still writes everything and succeeds', async () => {
    // $1 per call; the limit lets the survey, structure and extraction through and refuses the first recovery call.
    await w.db.su.query(`insert into ai_setting (institution_id, model, enabled, max_cost_usd_per_run, input_usd_per_mtok, output_usd_per_mtok) values ($1, 'm', true, 2.5, 100000, 0)`, [w.ids.inst]);
    const d = await draft();
    const r = await analyse(d.versionId, gappyResponder());
    expect(r.calls).toBe(3);
    expect(r.run).toMatchObject({ status: 'succeeded', error: null });
    expect(r.run.usage).toMatchObject({ calls: 3, costUsd: 3 });
    expect(r.run.report.recovery).toMatchObject({ stopped: 'budget' });
    expect(Object.values(status(r.run)).map((s) => s[1])).toEqual(['unresolved', 'unresolved', 'unresolved']);
    expect((await tree(d.versionId)).map((x) => x.code)).toEqual(['2', '2.1', '2.2', '2.4', '2.6']);
  }, 120000);

  it('resumes after a failed recovery job exactly where it stopped', async () => {
    const d = await draft();
    const responder = gappyResponder({ failRecover: true });
    setAiModelForTests(createFakeAiModel([responder.reply]).model);
    const started = await as('alo', (c) => startAnalysis(c, d.versionId));
    let failed: JobEnvelope | undefined;
    while (sent.length && !failed) {
      const env = sent.shift()!;
      try { await runOne(env); } catch { failed = env; }
    }
    const [failedJob] = await q(`select status, attempts, payload from job where id = $1`, [failed!.jobId]);
    expect(failedJob).toMatchObject({ status: 'failed', attempts: 1, payload: { stage: 'recover', cursor: 0 } });
    const mid = await as('alo', (c) => getAnalysisRun(c, started.id));
    expect(mid).toMatchObject({ status: 'running', stage: 'recover', progress: { cursor: 0, round: 1 } });
    expect(sent).toHaveLength(0);
    // The queue retries the same job: it picks up the step, and the run ends as if nothing had happened.
    await runOne(failed!);
    await drain();
    const done = await as('alo', (c) => getAnalysisRun(c, started.id));
    expect(done.status).toBe('succeeded');
    expect(status(done)).toEqual({ 'req:2.3': ['numbering_gap', 'recovered', 1], 'req:2.5': ['numbering_gap', 'confirmed_absent', 1], 'req:2.4': ['unverified_quote', 'recovered', 2] });
    expect((await q(`select count(*)::int n from extraction_item where analysis_run_id = $1 and payload->>'gap' = 'req:2.3'`, [started.id]))[0].n).toBe(1);
  }, 120000);

  it('remembers what a person deleted: a re-run does not add it back, and says so', async () => {
    const d = await draft();
    await analyse(d.versionId, gappyResponder());
    const reqs = await tree(d.versionId);
    const note = (await q(`select n.id from requirement_note n join requirement r on r.id = n.requirement_id where r.framework_version_id = $1`, [d.versionId]))[0].id as string;
    await as('alo', (c) => deleteNote(c, note));
    await as('alo', (c) => deleteRequirement(c, reqs.find((r) => r.code === '2.6')!.id));
    expect((await q(`select kind, code, note_text from analysis_dismissal where framework_version_id = $1 order by kind`, [d.versionId]))).toEqual([
      { kind: 'note', code: '2.4', note_text: 'Programmes should publish the advising hours each term.' },
      { kind: 'requirement', code: '2.6', note_text: null },
    ]);

    const again = await analyse(d.versionId, gappyResponder());
    expect(again.run.status).toBe('succeeded');
    expect((await tree(d.versionId)).map((r) => r.code)).toEqual(['2', '2.1', '2.2', '2.3', '2.4']);
    expect((await q(`select count(*)::int n from requirement_note n join requirement r on r.id = n.requirement_id where r.framework_version_id = $1`, [d.versionId]))[0].n).toBe(0);
    expect(again.run.report.stats).toMatchObject({ dismissedSkipped: 2 });
  }, 120000);

  it('only a person\'s deletion of an AI row is remembered; the worker cannot delete or write dismissals', async () => {
    const d = await draft();
    await analyse(d.versionId, gappyResponder());
    const mine = await as('alo', async (c) => {
      const { createRequirement } = await import('../requirements.js');
      return createRequirement(c, { versionId: d.versionId, code: '9', levelLabel: 'Standard', title: 'Mine' });
    });
    await as('alo', (c) => deleteRequirement(c, mine.id));
    expect(await q(`select * from analysis_dismissal where framework_version_id = $1`, [d.versionId])).toHaveLength(0);
    const worker = { userId: w.ids.alo, institutionId: w.ids.inst, role: 'ams_worker' as const };
    await expect(w.db.as(worker, (c) => c.query(`insert into analysis_dismissal (institution_id, framework_version_id, kind, code) values ($1, $2, 'requirement', 'x')`, [w.ids.inst, d.versionId])))
      .rejects.toThrow(/permission denied/);
  }, 120000);
});
