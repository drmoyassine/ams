// "Draft the framework" (TASK-111): headings per window, ONE organise call across the documents, review, apply, Undo/Redo.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobEnvelope, JobType, UndoDescriptor } from '@ams/shared';
import type { Ctx, JobQueue } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createFakeAiModel, setAiModelForTests } from '../ai/index.js';
import { handlers } from '../jobs/handlers.js';
import { runJob } from '../jobs/run.js';
import { applyImport, decideImportProposals, listImportProposals, redoImportApply, undoImportApply } from '../documents/proposals.js';
import { getImportRun, listImportTargets, startImport } from '../documents/runs.js';
import { newVersionFrom } from './versions.js';
import { addSourceDocument, addSourcePage } from './sources.js';
import { setUpQualityFramework } from './internal.js';
import { listRequirements } from './requirements.js';
import { IQF_TREE_TARGET_KIND } from './iqf-tree-import.js';

let w: World;
const sent: (JobEnvelope & { type: JobType })[] = [];
const queue: JobQueue = { send: async (type, e) => { sent.push({ ...e, type }); } };
const reported: UndoDescriptor[] = [];
const as = <T>(who: string, fn: (c: Ctx) => Promise<T>) =>
  w.as(who, (c) => fn({ ...c, queue, afterCommit: (f) => { void f(); }, undo: (d) => { reported.push(d); } }));
async function drain() {
  let n = 0;
  while (sent.length && n++ < 200) {
    const [{ type, ...env }] = sent.splice(0, 1) as [JobEnvelope & { type: JobType }];
    await runJob(w.pool, type, env, handlers, { store: w.store, queue });
  }
}
const promptText = (options: unknown) => ((options as { prompt?: { role: string; content: unknown }[] }).prompt ?? [])
  .filter((m) => m.role === 'user').map((m) => (Array.isArray(m.content) ? m.content.map((c) => (c as { text?: string }).text ?? '').join('') : String(m.content))).join('\n');

/** Outline windows: every "Article N: Title" line is a heading; the organise call: one standard per document, one sub-standard per heading. */
function responder() {
  return (options: unknown): object => {
    const text = promptText(options);
    if (!text.includes('Headings found in them')) {
      return { items: [...text.matchAll(/^(Article (\d+)): (.+)$/gm)].map((m) => ({ item: { level: 1, number: m[1], title: m[3], about: null }, source: { page: 1, quote: m[0] }, confidence: 0.9, flags: [] })) };
    }
    const entries = [...text.matchAll(/^\[(\d+)\] (.+?) · p\.\d+ · level \d · (.+?)(?: — .*)?$/gm)];
    return {
      items: [
        { level: 'standard', code: 'S1', title: 'Institutional effectiveness', description: 'How the institution plans and assesses.', from: [], confidence: 0.8, flags: [] },
        ...entries.map((m, i) => ({ level: 'sub_standard', code: `S1.${i + 1}`, title: m[3]!.replace(/^Article \d+ /, ''), parent_code: 'S1', from: [Number(m[1])], confidence: 0.9, flags: [] })),
      ],
    };
  };
}

let versionId: string;
beforeAll(async () => {
  w = await buildWorld('iqftree');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  versionId = (await as('alo', (c) => setUpQualityFramework(c))).versions[0]!.id;
}, 120000);
afterEach(() => setAiModelForTests(null));
afterAll(() => w.close());

describe('draft the framework from documents', () => {
  it('is offered on the institution\'s own framework only', async () => {
    expect((await as('alo', (c) => listImportTargets(c, 'framework_version', versionId))).map((t) => t.kind)).toContain(IQF_TREE_TARGET_KIND);
    const external = (await as('admin', (c) => newVersionFrom(c, w.ids.wscuc!, { edition: '2040' }))).version.id;
    expect((await as('alo', (c) => listImportTargets(c, 'framework_version', external))).map((t) => t.kind)).not.toContain(IQF_TREE_TARGET_KIND);
  });

  it('reads headings, drafts the tree in one call, applies it, and takes it back and forth', async () => {
    const a = await as('alo', (c) => addSourceDocument(c, { versionId, title: 'Assessment policy', role: 'policy_procedure', authority: 'informational' }));
    const b = await as('alo', (c) => addSourceDocument(c, { versionId, title: 'Planning policy', role: 'policy_procedure', authority: 'informational' }));
    await as('alo', (c) => addSourcePage(c, { documentId: a.id, pageNo: 1, text: 'Article 1: Learning outcomes assessment\nSome words about it.', method: 'pdf_text' }));
    await as('alo', (c) => addSourcePage(c, { documentId: b.id, pageNo: 1, text: 'Article 1: Strategic planning cycle\nArticle 2: Annual review\nSome words.', method: 'pdf_text' }));
    const fake = createFakeAiModel([responder()]);
    setAiModelForTests(fake.model);
    const run = await as('alo', (c) => startImport(c, { scopeKind: 'framework_version', scopeId: versionId, targetKind: IQF_TREE_TARGET_KIND, documentIds: [a.id, b.id] }));
    await drain();
    expect(await as('alo', (c) => getImportRun(c, run.id))).toMatchObject({ status: 'succeeded' });
    const { proposals } = await as('alo', (c) => listImportProposals(c, run.id));
    expect(proposals.map((p) => p.label)).toEqual([
      'S1 Institutional effectiveness', 'S1.1 Learning outcomes assessment', 'S1.2 Strategic planning cycle', 'S1.3 Annual review',
    ]);
    // Each sub-standard cites its first heading, quote-checked on the page.
    expect(proposals[1]).toMatchObject({ documentName: 'Assessment policy', pageNo: 1, quoteVerified: true });
    await as('alo', (c) => decideImportProposals(c, run.id, { ids: proposals.map((p) => p.id), decision: 'accept' }));
    const done = await as('alo', (c) => applyImport(c, run.id));
    expect(done.applied).toBeGreaterThanOrEqual(3);
    const tree = await as('alo', (c) => listRequirements(c, versionId));
    expect(tree.filter((r) => r.levelLabel === 'Sub-standard').every((r) => r.parentId !== null)).toBe(true);
    const std = tree.find((r) => r.code === 'S1');
    expect(std).toMatchObject({ levelLabel: 'Standard', title: 'Institutional effectiveness' });

    const before = tree.length;
        await as('alo', (c) => undoImportApply(c, done.applyId!));
    expect((await as('alo', (c) => listRequirements(c, versionId))).length).toBeLessThan(before);
    await as('alo', (c) => redoImportApply(c, done.applyId!));
    expect((await as('alo', (c) => listRequirements(c, versionId))).length).toBe(before);
    // The outline rows are gone once the run is done.
    const left = await w.db.su.query(`select count(*)::int as n from import_proposal where run_id = $1 and target_kind like '%:outline'`, [run.id]);
    expect(left.rows[0].n).toBe(0);
  }, 120000);
});
