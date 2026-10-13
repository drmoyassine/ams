// Framework analysis, step E: after the requirements are written, the run suggests links to the institution's quality
// framework (IQF) and new IQF items where nothing fits. Everything stays a suggestion until a person accepts it
// (DEC-006, DEC-021/022/023). No network: a fake model and a fake embedder.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobEnvelope } from '@ams/shared';
import { ConflictError, ForbiddenError, type Ctx, type JobQueue } from '../../ctx.js';
import { buildWorld, type World } from '../../engagement/test-support.js';
import { createFakeAiModel, createFakeEmbedder, setAiModelForTests, setEmbedderForTests } from '../../ai/index.js';
import { handlers } from '../../jobs/handlers.js';
import { runJob } from '../../jobs/run.js';
import { acceptCoverSuggestions, acceptIqfProposal, dismissIqfProposal, listIqfProposals } from '../../mapping/proposals.js';
import { getMappings, reviewMapping } from '../../mapping/mapping.js';
import { addQualityItem, newQualityVersion, publishQualityVersion, setUpQualityFramework } from '../internal.js';
import { listRequirements } from '../requirements.js';
import { addSourceDocument, addSourcePage } from '../sources.js';
import { createAccreditor, createFramework, createVersion } from '../versions.js';
import { FIXTURE_GUIDE, FIXTURE_HANDBOOK, fixtureResponder } from './fixture.js';
import { mappingResponder, type MappingScript } from './mapping-fixture.js';
import { getAnalysisRun, startAnalysis } from './runs.js';

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
    const acc = await createAccreditor(c, { name: `Invented Council ${edition}`, shortName: `IM${edition}`, type: 'institutional' });
    const fw = await createFramework(c, { accreditorId: acc.id, name: 'Institutional Standards', scope: 'institution' });
    const v = await createVersion(c, { frameworkId: fw.id, edition });
    const hb = await addSourceDocument(c, { versionId: v.id, title: FIXTURE_HANDBOOK.title, role: 'standards', authority: 'binding' });
    for (const [i, text] of FIXTURE_HANDBOOK.pages.entries()) await addSourcePage(c, { documentId: hb.id, pageNo: i + 1, text, method: 'pdf_text' });
    const guide = await addSourceDocument(c, { versionId: v.id, title: FIXTURE_GUIDE.title, authority: 'interpretive', language: 'ar' });
    await addSourcePage(c, { documentId: guide.id, pageNo: 1, text: FIXTURE_GUIDE.pages[0]!, method: 'pdf_text' });
    return { versionId: v.id, frameworkId: fw.id };
  });
}

/** What the fake model says about links, and the new items it drafts. */
const firstScript = (): MappingScript => ({
  fit: {
    '1': { '1': 'partly_covers', '1.1': 'related' }, '1.1': { '1.1': 'covers' }, '1.2': { '1.2': 'partly_covers' }, '1.2.1': { '1': 'related' },
  },
  newItems: (codes) => (codes.includes('1.1.1') ? [
    { parent_code: '1.1', level_label: 'Sub-standard', code: '1.1.1', title: 'Published mission statement', description: 'The institution makes its mission statement public and reviews it on a schedule.', reason: 'No item asks for publication.', covers: [{ requirement: '1.1.1', relation: 'covers', reason: 'Asks for publication and review.' }] },
    { parent_code: '1.2', level_label: 'Sub-standard', code: '1.2', title: 'Academic freedom policy', description: 'The institution has a policy on academic freedom and reviews it.', reason: 'No item mentions academic freedom.', covers: [{ requirement: '1.2.1', relation: 'partly_covers', reason: null }, { requirement: '9.9', relation: 'covers', reason: null }] },
    { parent_code: null, code: '2', title: 'Graduate follow-up', description: 'The institution follows up on its graduates.', reason: 'Nothing about graduates.', covers: [{ requirement: '3.9.1', relation: 'covers', reason: null }] },
  ] : []),
});

let iqfVersion: string;
let v: Awaited<ReturnType<typeof draftWithSources>>;
const mappingsOf = async () => (await as('alo', (c) => getMappings(c, v.versionId))).mappings;
const mappingOf = (m: Awaited<ReturnType<typeof mappingsOf>>, ext: string, int: string) => m.find((x) => x.externalCode === ext && x.internalCode === int);

beforeAll(async () => {
  w = await buildWorld('iqfmap');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  iqfVersion = (await as('admin', (c) => setUpQualityFramework(c))).versions[0]!.id;
  for (const [code, title, description] of [
    ['1', 'Mission and governance', ''], ['1.1', 'Mission, vision and values', 'The institution states its mission, vision and values.'], ['1.2', 'Integrity and ethics', ''],
    ['2', 'Teaching and learning', ''], ['2.1', 'Assessment of learning', 'How student learning is assessed.'],
  ] as const) await as('admin', (c) => addQualityItem(c, iqfVersion, { code, title, description }));
  await as('admin', (c) => publishQualityVersion(c, iqfVersion));
}, 120000);
afterEach(() => { setAiModelForTests(null); setEmbedderForTests(null); });
afterAll(() => w.close());

describe('IQF mapping after an analysis run', () => {
  it('suggests links and new IQF items, all pending and AI-made, and writes nothing into the quality framework', async () => {
    v = await draftWithSources('A');
    const script = firstScript();
    const fake = createFakeAiModel([mappingResponder(fixtureResponder(), script)]);
    setAiModelForTests(fake.model);
    const run = await as('alo', (c) => startAnalysis(c, v.versionId));
    expect(run.promptVersions).toMatchObject({ map: 'v1', newiqf: 'v1' });
    // The 15 jobs of steps C and D, the two of step H (the guide is surveyed and holds no configuration), then embed, one map batch and one propose_new chunk.
    expect(await drain()).toBe(20);
    expect(fake.calls).toHaveLength(12);

    const done = await as('alo', (c) => getAnalysisRun(c, run.id));
    expect(done).toMatchObject({ status: 'succeeded', error: null, usage: { calls: 12 } });
    expect(done.report.mapping).toMatchObject({
      skipped: null, retrieval: 'lexical only', requirements: 7, judged: 7, skippedDecided: 0, mapped: 4, noSuggestion: 3, newItems: 3,
      links: { covers: 1, partly_covers: 2, related: 2, kept: 0 },
      embeddings: { used: false, embedded: 0, reused: 0, note: expect.stringMatching(/Lexical only/) },
      unplacedCodes: ['1.1.1', '1.2.1', '1.9', '3.9.1'], stopped: null,
    });
    // The candidates are the IQF's items, at most 8 each, padded with top-level items when words found too few.
    expect(script.seen!.map.flat().every((r) => r.candidates.length <= 8 && r.candidates.length >= 1)).toBe(true);
    expect(script.seen!.map[0]!.find((r) => r.code === '1.1')!.candidates).toContain('1.1');
    expect((done.report.mapping as { shortlist: { size: number } }).shortlist.size).toBe(8);

    // Suggested links: pending, AI-made, with the model's reason; none approved.
    const m = await mappingsOf();
    expect(m).toHaveLength(5);
    expect(m.every((x) => x.origin === 'ai' && x.reviewStatus === 'pending')).toBe(true);
    expect(mappingOf(m, '1.1', '1.1')).toMatchObject({ relation: 'covers', rationale: expect.stringMatching(/"/) });
    expect(mappingOf(m, '1.2', '1.2')).toMatchObject({ relation: 'partly_covers' });
    expect(mappingOf(m, '1.2.1', '1')).toMatchObject({ relation: 'related' });
    expect(await q(`select count(*)::int n from requirement_mapping where review_status <> 'pending' or reviewed_by is not null`)).toEqual([{ n: 0 }]);

    // Suggested new items: pending proposals; a code that was taken got the next free one; an unknown requirement is dropped.
    const p = await as('alo', (c) => listIqfProposals(c, v.versionId));
    expect(p.draftVersionId).toBeNull(); // the quality framework is published: no draft yet
    expect(p.proposals.map((x) => [x.code, x.status, x.parentCode, x.levelLabel, x.links.map((l) => `${l.externalCode}:${l.relation}`)])).toEqual([
      // The IQF has two levels: an item proposed under a sub-standard goes under its standard, with the next free code.
      ['1.3', 'pending', '1', 'Sub-standard', ['1.1.1:covers']],
      ['1.4', 'pending', '1', 'Sub-standard', ['1.2.1:partly_covers']],
      ['3', 'pending', null, 'Standard', ['3.9.1:covers']],
    ]);
    expect(p.proposals[1]).toMatchObject({ parentTitle: 'Mission and governance', title: 'Academic freedom policy' });
    expect(p.proposals[0]!.links[0]).toMatchObject({ externalRequirementId: expect.any(String), reason: 'Asks for publication and review.' });

    // The quality framework itself is untouched (the database also refuses the worker: see packages/db).
    expect((await as('alo', (c) => listRequirements(c, iqfVersion))).map((r) => r.code)).toEqual(['1', '1.1', '1.2', '2', '2.1']);
    const jobs = await q(`select result from job where type = 'analyse' and payload->>'runId' = $1`, [run.id]);
    expect(jobs.flatMap((j) => j.result.ai ?? []).map((c: { task: string }) => c.task).filter((t: string) => t === 'map' || t === 'newiqf').sort()).toEqual(['map', 'newiqf']);
  }, 120000);

  it('accepts "covers" in bulk only, accepts or rejects one link at a time, and refuses to add an item while the quality framework has no draft', async () => {
    const m = await mappingsOf();
    await expect(as('contrib', (c) => acceptCoverSuggestions(c, v.versionId, m.map((x) => x.id)))).rejects.toThrow(ForbiddenError);
    expect(await as('alo', (c) => acceptCoverSuggestions(c, v.versionId, m.map((x) => x.id)))).toEqual({ accepted: 1, skipped: 4 });
    const after = await mappingsOf();
    expect(mappingOf(after, '1.1', '1.1')).toMatchObject({ reviewStatus: 'approved', relation: 'covers' });
    expect(after.filter((x) => x.reviewStatus === 'pending')).toHaveLength(4);
    expect(await q(`select reviewed_by from requirement_mapping where external_code = '1.1'`)).toEqual([{ reviewed_by: w.ids.alo }]);
    // Again: nothing pending says "covers" any more.
    expect(await as('alo', (c) => acceptCoverSuggestions(c, v.versionId, m.map((x) => x.id)))).toEqual({ accepted: 0, skipped: 5 });

    await as('alo', (c) => reviewMapping(c, mappingOf(after, '1.2', '1.2')!.id, 'rejected'));
    expect(mappingOf(await mappingsOf(), '1.2', '1.2')).toMatchObject({ reviewStatus: 'rejected' });

    const p = await as('alo', (c) => listIqfProposals(c, v.versionId));
    const first = p.proposals.find((x) => x.code === '1.3')!;
    await expect(as('alo', (c) => acceptIqfProposal(c, first.id))).rejects.toThrow(/no draft version.*Start a new version of the quality framework/);
    await expect(as('contrib', (c) => acceptIqfProposal(c, first.id))).rejects.toThrow(ForbiddenError);
    expect(await q(`select count(*)::int n from requirement where framework_version_id = $1`, [iqfVersion])).toEqual([{ n: 5 }]);
  }, 120000);

  let draft: string;
  it('accepting a suggested item (with edits) creates it in the quality framework\'s draft, as AI-made and not yet approved, with its links accepted', async () => {
    draft = (await as('alo', (c) => newQualityVersion(c))).id;
    const p = await as('alo', (c) => listIqfProposals(c, v.versionId));
    expect(p.draftVersionId).toBe(draft);
    const item = p.proposals.find((x) => x.code === '1.4')!;
    const accepted = await as('alo', (c) => acceptIqfProposal(c, item.id, { title: 'Academic freedom', code: '1.5' }));
    expect(accepted).toMatchObject({ status: 'accepted', code: '1.5', title: 'Academic freedom', parentCode: '1' });
    const row = (await q(`select r.*, p.code as parent_code from requirement r join requirement p on p.id = r.parent_id where r.id = $1`, [accepted.acceptedRequirementId]))[0];
    expect(row).toMatchObject({
      framework_version_id: draft, code: '1.5', title: 'Academic freedom', origin: 'ai', review_status: 'pending', reviewed_by: null, parent_code: '1',
      level_label: 'Sub-standard', official_text: 'The institution has a policy on academic freedom and reviews it.',
    });
    const links = await mappingsOf();
    expect(mappingOf(links, '1.2.1', '1.5')).toMatchObject({ relation: 'partly_covers', origin: 'ai', reviewStatus: 'approved', rationale: null });
    // A person cannot accept it twice, nor take a code that is already used.
    await expect(as('alo', (c) => acceptIqfProposal(c, item.id))).rejects.toThrow(/already accepted/);
    const other = p.proposals.find((x) => x.code === '1.3')!;
    await expect(as('alo', (c) => acceptIqfProposal(c, other.id, { code: '1.5' }))).rejects.toThrow(ConflictError);
    await expect(as('alo', (c) => acceptIqfProposal(c, other.id, { parentCode: '7.7' }))).rejects.toThrow(/no item coded 7.7/);
    // Dismissing is a decision too.
    const last = p.proposals.find((x) => x.code === '3')!;
    expect((await as('alo', (c) => dismissIqfProposal(c, last.id))).status).toBe('dismissed');
    await expect(as('alo', (c) => dismissIqfProposal(c, last.id))).rejects.toThrow(/already dismissed/);
    expect((await q(`select decided_by from iqf_item_proposal where id = $1`, [last.id]))[0]).toEqual({ decided_by: w.ids.alo });
  }, 120000);

  it('a re-run refreshes only untouched suggestions: accepted, rejected and dismissed ones stay, and nothing is duplicated', async () => {
    const before = await mappingsOf();
    const script: MappingScript = {
      fit: { '1': { '1': 'covers' }, '1.1': { '1.1': 'covers' }, '1.2': { '1.2': 'covers', '1.1': 'related' }, '1.2.1': { '1': 'related' } },
      newItems: (codes) => (codes.includes('1.9') ? [
        { parent_code: '1', code: '1.9', title: 'Records of governance', description: 'The institution keeps records of its governance decisions.', reason: 'Nothing about records.', covers: [{ requirement: '1.9', relation: 'covers', reason: null }] },
      ] : []),
    };
    const fake = createFakeAiModel([mappingResponder(fixtureResponder(), script)]);
    setAiModelForTests(fake.model);
    const run = await as('alo', (c) => startAnalysis(c, v.versionId));
    await drain();
    const done = await as('alo', (c) => getAnalysisRun(c, run.id));
    expect(done.status).toBe('succeeded');

    const after = await mappingsOf();
    // '1' stayed pending and was refreshed to the new relation; the approved link is as it was.
    expect(mappingOf(after, '1', '1')).toMatchObject({ relation: 'covers', reviewStatus: 'pending' });
    expect(mappingOf(after, '1.1', '1.1')).toEqual(mappingOf(before, '1.1', '1.1'));
    // The rejected pair is not offered again; 1.2's other candidate is a fresh suggestion.
    expect(mappingOf(after, '1.2', '1.2')).toMatchObject({ reviewStatus: 'rejected', relation: 'partly_covers' });
    expect(script.seen!.map[0]!.find((r) => r.code === '1.2')!.candidates).not.toContain('1.2');
    expect(mappingOf(after, '1.2', '1.1')).toMatchObject({ relation: 'related', reviewStatus: 'pending', origin: 'ai' });
    // The accepted new item's links belong to requirements a person has settled: not judged again.
    expect(script.seen!.map[0]!.map((r) => r.code)).not.toContain('1.2.1');
    expect(after.filter((x) => x.externalCode === '1.2.1')).toHaveLength(2);
    expect(done.report.mapping).toMatchObject({ judged: 5, skippedDecided: 2, links: { kept: 1 } });

    // Suggested new items: only the requirement nobody has settled gets one; the accepted and the dismissed stay as they were.
    expect(script.seen!.newiqf.map((s) => s.codes)).toEqual([['1.1.1', '1.2', '1.9']]); // 1.2: its only covering suggestion was rejected
    expect(script.seen!.newiqf[0]!.outline).toContain('1.1 Mission, vision and values');
    const p = await as('alo', (c) => listIqfProposals(c, v.versionId));
    expect(p.proposals.map((x) => [x.code, x.status])).toEqual([['1.5', 'accepted'], ['1.9', 'pending'], ['3', 'dismissed']]);
    // The suggestion of the first run that was not repeated is replaced, not left beside the new ones.
    expect(await q(`select status from iqf_item_proposal where code = '1.3'`)).toEqual([{ status: 'superseded' }]);
    expect(done.report.mapping).toMatchObject({ newItems: 1, unplacedCodes: ['1.1.1', '1.2', '1.9'] });
  }, 120000);

  it('a person\'s own link is never replaced, and a suggestion a person edited is left as they edited it', async () => {
    const d = await draftWithSources('M');
    const ext = await as('alo', (c) => listRequirements(c, d.versionId));
    expect(ext).toHaveLength(0);
    setAiModelForTests(createFakeAiModel([mappingResponder(fixtureResponder(), firstScript())]).model);
    await as('alo', (c) => startAnalysis(c, d.versionId));
    await drain();
    const m = (await as('alo', (c) => getMappings(c, d.versionId))).mappings;
    const mine = mappingOf(m, '1.2', '1.2')!;
    // A person changes the relation of a suggestion: it is now theirs.
    await w.db.su.query(`select set_config('app.user_id', $1, false)`, [w.ids.alo]);
    await as('alo', async (c) => { const { updateMapping } = await import('../../mapping/mapping.js'); await updateMapping(c, mine.id, { relation: 'covers' }); });
    expect((await q(`select edited_by_person from requirement_mapping where id = $1`, [mine.id]))[0]).toEqual({ edited_by_person: true });
    setAiModelForTests(createFakeAiModel([mappingResponder(fixtureResponder(), { fit: { '1.2': { '1.2': 'related' } } })]).model);
    await as('alo', (c) => startAnalysis(c, d.versionId));
    await drain();
    expect(mappingOf((await as('alo', (c) => getMappings(c, d.versionId))).mappings, '1.2', '1.2')).toMatchObject({ relation: 'covers', reviewStatus: 'pending' });
  }, 120000);

  it('uses embeddings when they are on (and only reuses unchanged vectors), and falls back to words alone when the endpoint fails', async () => {
    const d = await draftWithSources('E');
    const embedAccount = (await w.db.su.query(
      `insert into ai_account (institution_id, name, provider, base_url) values ($1, 'Embeddings', 'openai_compatible', 'http://embed.invalid/v1') returning id`, [w.ids.inst])).rows[0].id as string;
    await w.db.su.query(
      `insert into ai_setting (institution_id, model, enabled, embed_enabled, embed_account_id, embed_model, embed_dimension) values ($1, 'm', true, true, $2, 'emb', 32)`, [w.ids.inst, embedAccount]);
    try {
      const embedder = createFakeEmbedder();
      setEmbedderForTests(embedder);
      setAiModelForTests(createFakeAiModel([mappingResponder(fixtureResponder(), firstScript())]).model);
      const run = await as('alo', (c) => startAnalysis(c, d.versionId));
      await drain();
      const done = await as('alo', (c) => getAnalysisRun(c, run.id));
      expect(done.status).toBe('succeeded');
      const mapping = done.report.mapping as { retrieval: string; embeddings: { used: boolean; embedded: number; reused: number }; mapped: number };
      expect(mapping.retrieval).toBe('hybrid');
      expect(mapping.embeddings).toMatchObject({ used: true, embedded: 7 + 5, reused: 0 });
      expect(mapping.mapped).toBeGreaterThan(0);
      // Only framework text was embedded: the requirements and the IQF's items.
      expect(embedder.calls.flat().some((t) => /mission/i.test(t))).toBe(true);
      expect((await q(`select distinct owner_type from embedding`)).map((r) => r.owner_type)).toEqual(['requirement']);
      // A second run on the same texts embeds nothing new.
      setAiModelForTests(createFakeAiModel([mappingResponder(fixtureResponder(), firstScript())]).model);
      const again = await as('alo', (c) => startAnalysis(c, d.versionId));
      await drain();
      expect((await as('alo', (c) => getAnalysisRun(c, again.id))).report.mapping).toMatchObject({ retrieval: 'hybrid', embeddings: { embedded: 0, reused: 12 } });

      // The endpoint fails: the run still works, on words alone, and says so.
      setEmbedderForTests(() => { throw new Error('endpoint down'); });
      await w.db.su.query(`delete from embedding`);
      setAiModelForTests(createFakeAiModel([mappingResponder(fixtureResponder(), firstScript())]).model);
      const failed = await as('alo', (c) => startAnalysis(c, d.versionId));
      await drain();
      const report = (await as('alo', (c) => getAnalysisRun(c, failed.id)));
      expect(report.status).toBe('succeeded');
      expect(report.report.mapping).toMatchObject({ retrieval: 'lexical only', embeddings: { used: false, note: expect.stringMatching(/Lexical only.*endpoint down/) } });
    } finally {
      await w.db.su.query(`delete from ai_setting where institution_id = $1`, [w.ids.inst]);
      await w.db.su.query(`delete from ai_account where institution_id = $1`, [w.ids.inst]);
    }
  }, 120000);

  it('the spend limit ends the mapping, not the run: the requirements stay and the run finishes, saying so', async () => {
    // $1 per call; the 10 calls of steps C, D and H leave room for the map call only with a limit above 10; at 9.5 the map call is refused.
    await w.db.su.query(`insert into ai_setting (institution_id, model, enabled, cap_unit, max_cost_usd_per_run, input_usd_per_mtok, output_usd_per_mtok) values ($1, 'm', true, 'usd', 9.5, 100000, 0)`, [w.ids.inst]);
    try {
      const d = await draftWithSources('B1');
      const fake = createFakeAiModel([mappingResponder(fixtureResponder(), firstScript())]);
      setAiModelForTests(fake.model);
      const run = await as('alo', (c) => startAnalysis(c, d.versionId));
      await drain();
      const done = await as('alo', (c) => getAnalysisRun(c, run.id));
      expect(done).toMatchObject({ status: 'succeeded', error: null });
      expect(done.report.mapping).toMatchObject({ stopped: 'budget', mapped: 0, newItems: 0 });
      expect((done.report.stats as { requirements: number }).requirements).toBe(7);
      expect(fake.calls).toHaveLength(10);
      expect((await as('alo', (c) => getMappings(c, d.versionId))).mappings).toHaveLength(0);

      // Limit 10.5: the map call goes through, the new-items call is refused; the links stay.
      await w.db.su.query(`update ai_setting set max_cost_usd_per_run = 10.5 where institution_id = $1`, [w.ids.inst]);
      const e = await draftWithSources('B2');
      setAiModelForTests(createFakeAiModel([mappingResponder(fixtureResponder(), firstScript())]).model);
      const r2 = await as('alo', (c) => startAnalysis(c, e.versionId));
      await drain();
      const second = await as('alo', (c) => getAnalysisRun(c, r2.id));
      expect(second.status).toBe('succeeded');
      expect(second.report.mapping).toMatchObject({ stopped: 'budget', mapped: 4, newItems: 0 });
      expect((await as('alo', (c) => getMappings(c, e.versionId))).mappings).toHaveLength(5);
      expect((await as('alo', (c) => listIqfProposals(c, e.versionId))).proposals).toEqual([]);
    } finally {
      await w.db.su.query(`delete from ai_setting where institution_id = $1`, [w.ids.inst]);
    }
  }, 120000);

  it('says why when there is nothing to map onto', async () => {
    const w2 = await buildWorld('iqfmapnone');
    try {
      const as2 = <T>(who: string, fn: (c: Ctx) => Promise<T>) => w2.as(who, (c) => fn({ ...c, queue, afterCommit: (f) => { void f(); } }));
      const d = await as2('alo', async (c) => {
        const acc = await createAccreditor(c, { name: 'Invented Council N', shortName: 'INN', type: 'institutional' });
        const fw = await createFramework(c, { accreditorId: acc.id, name: 'S', scope: 'institution' });
        const ver = await createVersion(c, { frameworkId: fw.id, edition: 'N' });
        const hb = await addSourceDocument(c, { versionId: ver.id, title: FIXTURE_HANDBOOK.title, role: 'standards', authority: 'binding' });
        for (const [i, text] of FIXTURE_HANDBOOK.pages.entries()) await addSourcePage(c, { documentId: hb.id, pageNo: i + 1, text, method: 'pdf_text' });
        return ver.id;
      });
      const fake = createFakeAiModel([mappingResponder(fixtureResponder(), firstScript())]);
      setAiModelForTests(fake.model);
      const run = await as2('alo', (c) => startAnalysis(c, d));
      while (sent.length) await runJob(w2.pool, 'analyse', sent.shift(), handlers, { store: w2.store, queue });
      const done = await as2('alo', (c) => getAnalysisRun(c, run.id));
      expect(done.status).toBe('succeeded');
      expect(done.report.mapping).toMatchObject({ skipped: expect.stringMatching(/no quality framework/), judged: 0, newItems: 0 });
      expect(fake.calls.every((c) => !JSON.stringify(c).includes('REQUIREMENTS_JSON'))).toBe(true);
    } finally {
      await w2.close();
    }
  }, 120000);
});
