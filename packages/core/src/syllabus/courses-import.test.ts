// Courses from documents (DEC-044): facts per window, one organise call that matches each course to the institution's courses ("MCE410"
// is "MCE 410"), and apply as DEC-042 wants it: the record and the programs it serves at once, the content (credits, CLOs) into the
// course's draft; nothing deleted; Undo and Redo of all of it.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobEnvelope, JobType } from '@ams/shared';
import { ForbiddenError, type Ctx, type JobQueue } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createFakeAiModel, setAiModelForTests } from '../ai/index.js';
import { PROMPTS } from '../ai/prompts/index.js';
import { handlers } from '../jobs/handlers.js';
import { runJob } from '../jobs/run.js';
import { pdf } from '../framework/parse-fixtures.js';
import { uploadDocument } from '../documents/documents.js';
import { applyImport, decideImportProposals, listImportProposals, redoImportApply, undoImportApply } from '../documents/proposals.js';
import { listImportTargets, startImport } from '../documents/runs.js';
import { findImportTarget, type OutlineEntry } from '../documents/targets.js';
import { COURSES_TARGET_KIND, coursesTarget, CourseImportItemSchema, normalizeBloom } from './courses-import.js';
import { courseContentNow } from './syllabus.js';

let w: World;
const sent: (JobEnvelope & { type: JobType })[] = [];
const queue: JobQueue = { send: async (type, e) => { sent.push({ ...e, type }); } };
const as = <T>(who: string, fn: (c: Ctx) => Promise<T>) => w.as(who, (c) => fn({ ...c, queue, afterCommit: (f) => { void f(); }, undo: () => undefined }));
const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;
async function drain() {
  let n = 0;
  while (sent.length && n++ < 200) {
    const [{ type, ...env }] = sent.splice(0, 1) as [JobEnvelope & { type: JobType }];
    await runJob(w.pool, type, env, handlers, { store: w.store, queue });
  }
}
const promptText = (options: unknown) => ((options as { prompt?: { role: string; content: unknown }[] }).prompt ?? [])
  .filter((m) => m.role === 'user').map((m) => (Array.isArray(m.content) ? m.content.map((c) => (c as { text?: string }).text ?? '').join('') : String(m.content))).join('\n');

/** Windows: one fact per "Fact: course | field | value [| code]" line. Organise: one item per course; matched by its code without spaces. */
function responder() {
  return (options: unknown): object => {
    const text = promptText(options);
    if (!text.includes('Facts found in them')) {
      const items: object[] = [];
      const parts = text.split(/=== Page (\d+) ===/);
      for (let i = 1; i < parts.length; i += 2) {
        for (const m of parts[i + 1]!.matchAll(/^Fact: ([^|\n]+?) \| (\w+) \| ([^|\n]+?)(?: \| (\S+))?$/gm)) items.push({ item: { course: m[1], field: m[2], value: m[3], code: m[4] ?? null }, source: { page: Number(parts[i]), quote: m[0] }, confidence: 0.9, flags: [] });
      }
      return { items };
    }
    const facts = [...text.matchAll(/^\[(\d+)\] (.+?) · (\w+)(?: (\S+))?: (.+)$/gm)].map((m) => ({ n: Number(m[1]), course: m[2]!, field: m[3]!, code: m[4] ?? null, value: m[5]! }));
    const known = [...text.matchAll(/^(C\d+) · code (.+?) · /gm)].map((m) => ({ ref: m[1]!, code: m[2]!.replace(/\s/g, '') }));
    return {
      items: [...new Set(facts.map((f) => f.course))].map((name) => {
        const mine = facts.filter((f) => f.course === name);
        const v = (field: string) => mine.find((f) => f.field === field)?.value ?? null;
        const match = known.find((k) => k.code === (v('code') ?? '').replace(/\s/g, ''));
        return {
          match: match?.ref ?? null, match_reason: match ? 'Same code.' : 'New code.', code: v('code'), title: v('title'), unit: v('unit'), credits: v('credits'), year: v('year'),
          programs: mine.filter((f) => f.field === 'program').map((f) => f.value), clos: mine.filter((f) => f.field === 'clo').map((f) => ({ code: f.code, text: f.value, bloom: 'Analyze' })),
          from: mine.map((f) => f.n), confidence: 0.85, flags: [],
        };
      }),
    };
  };
}

beforeAll(async () => {
  w = await buildWorld('coursesimport');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await q(`update program set code = 'BSME' where id = $1`, [w.ids.mech]);
  const unit = (await q(`select id from org_unit where name_en = 'Engineering'`))[0].id;
  w.ids.course = (await q(`insert into course (institution_id, org_unit_id, code, title_en) values ($1, $2, 'MCE 410', 'Heat Transfer') returning id`, [w.ids.inst, unit]))[0].id;
}, 120000);
afterEach(() => setAiModelForTests(null));
afterAll(async () => { await w.close(); });

describe('the item', () => {
  it('reads Bloom levels however written, is registered with versioned prompts, and backs up the AI on the code', async () => {
    expect(['Analyze', 'analysis', 'Comprehension', 'Knowledge', 'synthesis', 'whatever'].map(normalizeBloom)).toEqual(['analyze', 'analyze', 'understand', 'remember', 'create', null]);
    expect(CourseImportItemSchema.parse({ titleEn: 'X', credits: '3 credit hours', level: 'Year 4' })).toMatchObject({ credits: 3, level: 4, clos: [], programs: [], keep: [] });
    expect(findImportTarget(COURSES_TARGET_KIND)).toBe(coursesTarget);
    expect(PROMPTS.import_courses_organise.v1).toMatch(/"ECE420" is "ECE 420"/);
    expect((await as('alo', (c) => listImportTargets(c, 'courses', null))).map((t) => t.kind)).toEqual(['courses']);
    const out = coursesTarget.organise!.build({ match: null, code: 'mce-410', title: 'Heat transfer', clos: [], from: [], flags: [] } as never, [] as OutlineEntry<never>[], [{ ref: 'C1', id: w.ids.course, code: 'MCE 410', titleEn: 'Heat Transfer' }]);
    expect(out.item.matchCourseId).toBe(w.ids.course);
    expect(out.flags).toContain('Matched by its code, not by the AI: check it.');
  });
});

describe('a run end to end', () => {
  let applyId: string;
  it('matches MCE410 to MCE 410: places it in BSME at once, puts credits and the CLO into its draft; adds MCE 499 as new', async () => {
    const bytes = pdf([
      ['Fact: MCE410 Heat Transfer | code | MCE410', 'Fact: MCE410 Heat Transfer | credits | 3', 'Fact: MCE410 Heat Transfer | program | BSME', 'Fact: MCE410 Heat Transfer | year | 4',
        'Fact: MCE410 Heat Transfer | clo | Analyse conduction in solids. | CLO1', 'The course catalogue of the university with enough words to count as a page of text.'].join('\n'),
      ['Fact: MCE 499 Capstone | code | MCE 499', 'Fact: MCE 499 Capstone | title | Capstone Design', 'Fact: MCE 499 Capstone | unit | Engineering', 'Fact: MCE 499 Capstone | credits | 3',
        'Fact: MCE 499 Capstone | program | BS Mechanical Engineering', 'The second page of the catalogue with enough words to count as a page of text.'].join('\n'),
    ]);
    const d = await as('alo', (c) => uploadDocument(c, { scopeKind: 'courses', scopeId: null, fileName: 'catalogue.pdf', mime: 'application/pdf', bytes }));
    setAiModelForTests(createFakeAiModel([responder()]).model);
    await expect(as('contrib', (c) => startImport(c, { scopeKind: 'courses', scopeId: null, targetKind: 'courses', documentIds: [d.id] }))).rejects.toThrow(ForbiddenError);
    const runId = (await as('alo', (c) => startImport(c, { scopeKind: 'courses', scopeId: null, targetKind: 'courses', documentIds: [d.id] }))).id;
    await drain();
    expect((await q(`select status from import_run where id = $1`, [runId]))[0].status).toBe('succeeded');
    const list = (await as('alo', (c) => listImportProposals(c, runId))).proposals;
    expect(list.map((p) => p.label)).toEqual(['MCE410 MCE410 Heat Transfer', 'MCE 499 Capstone Design']);
    expect(list[0]!.effective).toMatchObject({ matchCourseId: w.ids.course, credits: 3, level: 4, programs: ['BSME'], clos: [{ code: 'CLO1', bloom: 'analyze' }] });
    expect(list[0]!.flags).toContain('Updates MCE 410: now: Year of study; adds to BSME; into the draft: Title, Credit hours, 1 new CLO.');
    expect(list[1]!.effective).toMatchObject({ matchCourseId: null, code: 'MCE 499' });
    await as('alo', (c) => decideImportProposals(c, runId, { ids: list.map((p) => p.id), decision: 'accept' }));
    const res = await as('alo', (c) => applyImport(c, runId));
    expect(res.applied).toBe(2);
    applyId = res.applyId!;
    // The record and the placement at once; the course's own credits wait for the draft's approval.
    expect((await q(`select level, credits, title_en from course where id = $1`, [w.ids.course]))[0]).toEqual({ level: 4, credits: null, title_en: 'Heat Transfer' });
    expect((await q(`select program_id from course_program where course_id = $1`, [w.ids.course])).map((r) => r.program_id)).toEqual([w.ids.mech]);
    const draft = await as('alo', (c) => courseContentNow(c, w.ids.course!));
    expect(draft.hasDraft).toBe(true);
    expect(draft.content.info.credits).toBe(3);
    expect(draft.content.clos.map((c) => [c.code, c.textEn, c.bloom])).toEqual([['CLO1', 'Analyse conduction in solids.', 'analyze']]);
    const capstone = (await q(`select id, title_en, credits, active from course where code = 'MCE 499'`))[0];
    expect(capstone).toMatchObject({ title_en: 'Capstone Design', credits: '3.0', active: true });
    expect((await q(`select count(*)::int n from course_program where course_id = $1 and program_id = $2`, [capstone.id, w.ids.mech]))[0].n).toBe(1);
  }, 120000);

  it('undoes all of it (placement out, draft gone, new course off) and redoes it', async () => {
    await as('alo', (c) => undoImportApply(c, applyId));
    expect((await q(`select level from course where id = $1`, [w.ids.course]))[0].level).toBeNull();
    expect((await q(`select count(*)::int n from course_program where course_id = $1`, [w.ids.course]))[0].n).toBe(0);
    expect((await as('alo', (c) => courseContentNow(c, w.ids.course!))).hasDraft).toBe(false);
    expect((await q(`select active from course where code = 'MCE 499'`))[0].active).toBe(false);
    await as('alo', (c) => redoImportApply(c, applyId));
    expect((await as('alo', (c) => courseContentNow(c, w.ids.course!))).content.info.credits).toBe(3);
    expect((await q(`select active from course where code = 'MCE 499'`))[0].active).toBe(true);
  });
});
