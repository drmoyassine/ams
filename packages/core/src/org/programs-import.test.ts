// Programs from documents, v3 (DEC-043): facts per window, then one organise call that puts them together per program and matches
// each to the institution's programs by meaning; the review's match and "keep" choices; apply that creates new programs and updates the
// matched ones (fields, PEOs and PLOs by code, never deleting); Undo and Redo of all of it, refused after a person's change.
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
import { applyImport, decideImportProposals, editImportProposal, fieldOptionsOf, listImportProposals, redoImportApply, undoImportApply } from '../documents/proposals.js';
import { listImportTargets, startImport } from '../documents/runs.js';
import { findImportTarget, type OutlineEntry, type TargetScope } from '../documents/targets.js';
import { listPrograms, updateProgram } from './programs.js';
import { listOrgUnits } from './units.js';
import { normalizeDegreeLevel, normalizeMode, PROGRAMS_TARGET_KIND, programsTarget, ProgramImportItemSchema, type ProgramImportItem } from './programs-import.js';

let w: World;
const sent: (JobEnvelope & { type: JobType })[] = [];
const queue: JobQueue = { send: async (type, e) => { sent.push({ ...e, type }); } };
const as = <T>(who: string, fn: (c: Ctx) => Promise<T>) => w.as(who, (c) => fn({ ...c, queue, afterCommit: (f) => { void f(); }, undo: () => undefined }));
const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;
const scope: TargetScope = { kind: 'programs', id: null, label: 'Programs', runId: crypto.randomUUID() };
async function drain() {
  let n = 0;
  while (sent.length && n++ < 200) {
    const [{ type, ...env }] = sent.splice(0, 1) as [JobEnvelope & { type: JobType }];
    await runJob(w.pool, type, env, handlers, { store: w.store, queue });
  }
}
const promptText = (options: unknown) => ((options as { prompt?: { role: string; content: unknown }[] }).prompt ?? [])
  .filter((m) => m.role === 'user').map((m) => (Array.isArray(m.content) ? m.content.map((c) => (c as { text?: string }).text ?? '').join('') : String(m.content))).join('\n');

/**
 * The fake model. Windows: one fact per "Fact: program | field | value [| code]" line. Organise: one item per program named in the facts;
 * a program whose name shares a word of 5+ letters with an existing program at the same level is matched to it (the model's judgement).
 */
function responder() {
  return (options: unknown): object => {
    const text = promptText(options);
    if (!text.includes('Facts found in them')) {
      const items: object[] = [];
      const parts = text.split(/=== Page (\d+) ===/);
      for (let i = 1; i < parts.length; i += 2) {
        for (const m of parts[i + 1]!.matchAll(/^Fact: ([^|\n]+?) \| (\w+) \| ([^|\n]+?)(?: \| (\S+))?$/gm)) {
          items.push({ item: { program: m[1], field: m[2], value: m[3], code: m[4] ?? null }, source: { page: Number(parts[i]), quote: m[0] }, confidence: 0.9, flags: [] });
        }
      }
      return { items };
    }
    const facts = [...text.matchAll(/^\[(\d+)\] (.+?) · (\w+)(?: (\S+))?: (.+)$/gm)].map((m) => ({ n: Number(m[1]), program: m[2]!, field: m[3]!, code: m[4] ?? null, value: m[5]! }));
    const known = [...text.matchAll(/^(P\d+) · code \S+ · (\w+) · (.+?)(?: \/ .+?)? · unit/gm)].map((m) => ({ ref: m[1]!, level: m[2]!, name: m[3]! }));
    const names = [...new Set(facts.map((f) => f.program))];
    return {
      items: names.map((name) => {
        const mine = facts.filter((f) => f.program === name);
        const v = (field: string) => mine.find((f) => f.field === field)?.value ?? null;
        const level = v('degree_level');
        const words = new Set(name.toLowerCase().split(/\W+/).filter((x) => x.length >= 5));
        const match = known.find((k) => k.level === (level ?? 'bachelor') && k.name.toLowerCase().split(/\W+/).some((x) => words.has(x)));
        return {
          match: match?.ref ?? null, match_reason: match ? `Same discipline and level as ${match.name}.` : 'No program like it.',
          name_en: v('name_en') ?? name, degree_level: level, code: v('code'), unit: v('unit'), mode: v('mode'), credits: v('credits'), mission: v('mission'),
          peos: mine.filter((f) => f.field === 'peo').map((f) => ({ code: f.code, text: f.value })), plos: mine.filter((f) => f.field === 'plo').map((f) => ({ code: f.code, text: f.value })),
          from: mine.map((f) => f.n), confidence: 0.8, flags: [],
        };
      }),
    };
  };
}

const item = (over: Partial<ProgramImportItem> = {}): ProgramImportItem => ProgramImportItemSchema.parse({ nameEn: 'BSc Nursing', degreeLevel: 'bachelor', unitName: 'Engineering', ...over });
const apply = (items: ProgramImportItem[], who = 'alo') =>
  as(who, (c) => programsTarget.apply(c, items.map((it, i) => ({ proposalId: `p${i}`, item: it, edited: false, label: it.nameEn, source: { documentId: null, documentName: null, page: 1, quote: null, quoteVerified: true } })), scope));

beforeAll(async () => {
  w = await buildWorld('programsimport');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
}, 120000);
afterEach(() => setAiModelForTests(null));
afterAll(async () => { await w.close(); });

describe('the item', () => {
  it('reads levels and modes however they are written, keeps v2 items readable, and offers the fixed lists to the review', () => {
    expect(['Bachelor', 'BSc', 'MBA', 'PhD', ''].map(normalizeDegreeLevel)).toEqual(['bachelor', 'bachelor', 'master', 'doctorate', null]);
    expect(['Full-time', 'part time', 'On-campus', 'Online', 'distance learning', 'Hybrid', 'evening', ''].map(normalizeMode)).toEqual(['on_campus', 'on_campus', 'on_campus', 'online', 'online', 'blended', null, null]);
    // A v2 item (mode as free text, no outcomes) still parses.
    expect(ProgramImportItemSchema.parse({ nameEn: 'X', degreeLevel: 'bachelor', mode: 'full-time', durationYears: 4 })).toMatchObject({ mode: 'on_campus', peos: [], plos: [], keep: [], matchProgramId: null });
    expect(ProgramImportItemSchema.parse({ nameEn: 'X', credits: '132 credit hours' }).credits).toBe(132);
    expect(fieldOptionsOf(ProgramImportItemSchema).mode).toEqual(['on_campus', 'online', 'blended']);
  });

  it('is registered for the programs scope with versioned prompts', async () => {
    expect(findImportTarget(PROGRAMS_TARGET_KIND)).toBe(programsTarget);
    expect(PROMPTS.import_programs_facts.v1).toMatch(/ONE item per fact/);
    expect(PROMPTS.import_programs_organise.v1).toMatch(/Decide by meaning, not spelling/);
    expect((await as('alo', (c) => listImportTargets(c, 'programs', null))).map((t) => t.kind)).toEqual(['programs']);
  });

  it('backs up the AI: an item with the same code or name as an existing program is matched, and flagged to check', () => {
    const known = [{ ref: 'P1', id: '00000000-0000-4000-8000-000000000001', code: 'ACC', nameEn: 'Accounting', nameAr: null, degreeLevel: 'bachelor' }];
    const src: OutlineEntry<never>[] = [];
    const build = programsTarget.organise!.build;
    const a = { match: null, name_en: 'Bachelor of Business Administration - Accounting', degree_level: 'bachelor', code: 'acc', peos: [], plos: [], from: [], flags: [] };
    const out = build(a as never, src, known);
    expect(out.item.matchProgramId).toBe(known[0]!.id);
    expect(out.flags).toContain('Matched by its code or name, not by the AI: check it.');
    expect(build({ ...a, match: 'P9' } as never, src, known).flags?.[0]).toMatch(/not on the list/);
  });
});

describe('a run end to end', () => {
  let runId: string;
  let applyId: string;

  it('reads facts, matches "Mechanical Engineering BSc" to the existing BS Mechanical Engineering, proposes BBA Accounting as new, and applies both', async () => {
    const bytes = pdf([
      ['Fact: Mechanical Engineering BSc | credits | 132', 'Fact: Mechanical Engineering BSc | mission | To graduate engineers who design.', 'Fact: Mechanical Engineering BSc | plo | Apply engineering design. | SO1',
        'Fact: Mechanical Engineering BSc | peo | Graduates lead in industry. | PEO1', 'The catalogue of programs of the university with enough words to count as a page of text.'].join('\n'),
      ['Fact: ACCOUNTING Bac | name_en | Bachelor of Business Administration - Accounting', 'Fact: ACCOUNTING Bac | degree_level | bachelor', 'Fact: ACCOUNTING Bac | code | BBA-ACC',
        'Fact: ACCOUNTING Bac | unit | Engineering > Accounting Department', 'Fact: ACCOUNTING Bac | mode | Full-time', 'The second page of the catalogue with enough words to count as a page of text.'].join('\n'),
    ]);
    const d = await as('alo', (c) => uploadDocument(c, { scopeKind: 'programs', scopeId: null, fileName: 'catalogue.pdf', mime: 'application/pdf', bytes }));
    setAiModelForTests(createFakeAiModel([responder()]).model);
    await expect(as('contrib', (c) => startImport(c, { scopeKind: 'programs', scopeId: null, targetKind: 'programs', documentIds: [d.id] }))).rejects.toThrow(ForbiddenError);
    runId = (await as('alo', (c) => startImport(c, { scopeKind: 'programs', scopeId: null, targetKind: 'programs', documentIds: [d.id] }))).id;
    await drain();
    expect((await q(`select status from import_run where id = $1`, [runId]))[0].status).toBe('succeeded');
    const list = (await as('alo', (c) => listImportProposals(c, runId))).proposals;
    expect(list.map((p) => p.label)).toEqual(['Mechanical Engineering BSc', 'Bachelor of Business Administration - Accounting']);
    const [mech, acc] = list as [typeof list[0], typeof list[0]];
    expect(mech.effective).toMatchObject({ matchProgramId: w.ids.mech, credits: 132, plos: [{ code: 'SO1', text: 'Apply engineering design.' }] });
    expect(mech.flags).toContain('Updates BS Mechanical Engineering: Name (English), Credits, Mission, 1 new PEO, 1 new PLO.');
    expect(acc.effective).toMatchObject({ matchProgramId: null, mode: 'on_campus', code: 'BBA-ACC', unitName: 'Engineering › Accounting Department' });
    expect(acc.flags).toContain('The unit "Engineering › Accounting Department" is not in the org chart: it would be added.');
    // The person keeps the existing English name of the matched program.
    await as('alo', (c) => editImportProposal(c, mech.id, { ...(mech.effective as object), keep: ['nameEn'] }));
    await as('alo', (c) => decideImportProposals(c, runId, { ids: list.map((p) => p.id), decision: 'accept' }));
    const res = await as('alo', (c) => applyImport(c, runId));
    expect(res.applied).toBe(2);
    applyId = res.applyId!;
    const programs = await as('alo', (c) => listPrograms(c));
    expect(programs.find((p) => p.id === w.ids.mech)).toMatchObject({ nameEn: 'BS Mechanical Engineering', credits: 132, mission: 'To graduate engineers who design.' });
    const bba = programs.find((p) => p.code === 'BBA-ACC')!;
    expect(bba).toMatchObject({ nameEn: 'Bachelor of Business Administration - Accounting', degreeLevel: 'bachelor', mode: 'on_campus' });
    const units = await as('alo', (c) => listOrgUnits(c));
    const dept = units.find((u) => u.nameEn === 'Accounting Department')!;
    expect(dept.parentId).toBe(units.find((u) => u.nameEn === 'Engineering')!.id);
    expect(bba.orgUnitId).toBe(dept.id);
    expect(await q(`select kind, code, text_en from learning_outcome where program_id = $1 order by kind`, [w.ids.mech])).toEqual([
      { kind: 'peo', code: 'PEO1', text_en: 'Graduates lead in industry.' }, { kind: 'plo', code: 'SO1', text_en: 'Apply engineering design.' }]);
  }, 120000);

  it('undoes everything it set (fields back, new outcomes retired, new program and unit off) and redoes it; a person\'s change since refuses', async () => {
    await as('alo', (c) => undoImportApply(c, applyId));
    const mech = (await as('alo', (c) => listPrograms(c))).find((p) => p.id === w.ids.mech)!;
    expect([mech.credits, mech.mission]).toEqual([null, null]);
    expect((await q(`select distinct status from learning_outcome where program_id = $1`, [w.ids.mech])).map((r) => r.status)).toEqual(['retired']);
    expect((await as('alo', (c) => listPrograms(c))).find((p) => p.code === 'BBA-ACC')!.active).toBe(false);
    expect((await as('alo', (c) => listOrgUnits(c))).find((u) => u.nameEn === 'Accounting Department')!.active).toBe(false);
    await as('alo', (c) => redoImportApply(c, applyId));
    expect((await as('alo', (c) => listPrograms(c))).find((p) => p.id === w.ids.mech)!.credits).toBe(132);
    await as('alo', (c) => updateProgram(c, w.ids.mech!, { credits: 130 }));
    await expect(as('alo', (c) => undoImportApply(c, applyId))).rejects.toThrow(/was changed since/);
    expect((await as('alo', (c) => listPrograms(c))).find((p) => p.code === 'BBA-ACC')!.active).toBe(true);
  });
});

describe('apply rules', () => {
  it('updates a PLO by its code, adds one without a code under the next free code, and never deletes', async () => {
    const res = await apply([item({ matchProgramId: w.ids.mech, nameEn: 'BS Mechanical Engineering', unitName: null, plos: [{ code: 'so1', text: 'Apply engineering design and analysis.', textAr: null }, { code: null, text: 'Communicate effectively.', textAr: null }] })]);
    expect(res.outcomes[0]).toMatchObject({ status: 'applied', ref: { updated: true, changes: ['1 new PLO', '1 PLO text'] } });
    expect(await q(`select code, text_en from learning_outcome where program_id = $1 and kind = 'plo' order by code`, [w.ids.mech])).toEqual([
      { code: 'PLO1', text_en: 'Communicate effectively.' }, { code: 'SO1', text_en: 'Apply engineering design and analysis.' }]);
    expect((await q(`select count(*)::int n from learning_outcome where program_id = $1 and kind = 'peo'`, [w.ids.mech]))[0].n).toBe(1);
  });

  it('does not take a code another program holds, refuses two items for one program, and leaves a new program without a level alone', async () => {
    const res = await apply([
      item({ matchProgramId: w.ids.mech, nameEn: 'BS Mechanical Engineering', unitName: null, code: 'BBA-ACC' }),
      item({ matchProgramId: w.ids.mech, nameEn: 'Mech again', unitName: null }),
      item({ nameEn: 'Is Skipped', degreeLevel: null }),
    ]);
    expect(res.outcomes.map((o) => o.status)).toEqual(['applied', 'skipped', 'skipped']);
    expect(res.outcomes[0]).toMatchObject({ ref: { note: 'The code BBA-ACC belongs to Bachelor of Business Administration - Accounting and was not used.' } });
    expect(res.outcomes[1]).toMatchObject({ reason: expect.stringContaining('already updates') });
    expect(res.outcomes[2]).toMatchObject({ reason: expect.stringContaining('needs its level') });
    await expect(apply([item({ nameEn: 'Anything' })], 'contrib')).rejects.toThrow(ForbiddenError);
  });

  it('flags a new program that looks like an existing one', async () => {
    const flags = await as('alo', async (c) => programsTarget.validate!(item({ nameEn: 'Mechanical Engineering (new track)' }), scope, c));
    expect(flags.join(' ')).toMatch(/looks like BS Mechanical Engineering/);
  });
});
