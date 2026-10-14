// Programs from documents (TASK-076): the production import target end to end with a fake model (no network), and its apply/reverse
// rules directly: create-only, dedupe, units matched or proposed, Arabic NFC and folding, a person's edit protected on Undo.
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
import { applyImport, decideImportProposals, listImportProposals, undoImportApply, redoImportApply } from '../documents/proposals.js';
import { listImportTargets, startImport } from '../documents/runs.js';
import type { TargetScope } from '../documents/targets.js';
import { findImportTarget } from '../documents/targets.js';
import { listPrograms, updateProgram } from './programs.js';
import { listOrgUnits } from './units.js';
import { PROGRAMS_TARGET_KIND, programsTarget, ProgramImportItemSchema, type ProgramImportItem } from './programs-import.js';

let w: World;
const sent: (JobEnvelope & { type: JobType })[] = [];
const queue: JobQueue = { send: async (type, e) => { sent.push({ ...e, type }); } };
const as = <T>(who: string, fn: (c: Ctx) => Promise<T>) => w.as(who, (c) => fn({ ...c, queue, afterCommit: (f) => { void f(); }, undo: () => undefined }));
const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;
const scope: TargetScope = { kind: 'programs', id: null, label: 'Programs', runId: crypto.randomUUID() };

async function drain() {
  while (sent.length) {
    const [{ type, ...env }] = sent.splice(0, 1) as [JobEnvelope & { type: JobType }];
    await runJob(w.pool, type, env, handlers, { store: w.store, queue });
  }
}

/** The fake model: one item per "Program: English | level | unit" line of the pages it is shown, citing the line. */
function programsResponder() {
  return (options: unknown): object => {
    const prompt = (options as { prompt?: { role: string; content: unknown }[] }).prompt ?? [];
    const user = prompt.filter((m) => m.role === 'user').map((m) => (Array.isArray(m.content) ? m.content.map((c) => (c as { text?: string }).text ?? '').join('') : String(m.content))).join('\n');
    const items: object[] = [];
    const parts = user.split(/=== Page (\d+) ===/);
    for (let i = 1; i < parts.length; i += 2) {
      for (const m of parts[i + 1]!.matchAll(/Program: ([^|\n]+?)[ \t]*\|[ \t]*(\w*)[ \t]*\|[ \t]*([^|\n]*?)[ \t]*(?:\|[ \t]*code (\w+))?$/gm)) {
        items.push({
          item: { nameEn: m[1], degreeLevel: m[2] || null, unitName: m[3] || null, code: m[4] ?? null },
          source: { page: Number(parts[i]), quote: m[0] }, confidence: 0.9, flags: [],
        });
      }
    }
    return { items };
  };
}

const item = (over: Partial<ProgramImportItem> = {}): ProgramImportItem => ProgramImportItemSchema.parse({ nameEn: 'BSc Nursing', degreeLevel: 'bachelor', unitName: 'College of Health', ...over });
const apply = (items: ProgramImportItem[], who = 'alo') =>
  as(who, (c) => programsTarget.apply(c, items.map((it, i) => ({ proposalId: `p${i}`, item: it, edited: false, label: it.nameEn, source: { documentId: null, documentName: null, page: 1, quote: null, quoteVerified: true } })), scope));

beforeAll(async () => {
  w = await buildWorld('programsimport');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
}, 120000);
afterEach(() => setAiModelForTests(null));
afterAll(async () => { await w.close(); });

describe('the target', () => {
  it('is registered for the programs scope with a versioned prompt and a schema', async () => {
    expect(findImportTarget(PROGRAMS_TARGET_KIND)).toBe(programsTarget);
    expect(programsTarget.scopeKinds).toEqual(['programs']);
    expect(PROMPTS.import_programs.v1).toMatch(/academic programs/);
    expect((await as('alo', (c) => listImportTargets(c, 'programs', null))).map((t) => t.kind)).toEqual(['programs']);
    expect(ProgramImportItemSchema.safeParse({ nameEn: '' }).success).toBe(false);
    expect(ProgramImportItemSchema.safeParse({ nameEn: 'X', degreeLevel: 'bachelor', durationYears: 4 }).success).toBe(true);
    expect(ProgramImportItemSchema.safeParse({ nameEn: 'X', degreeLevel: 'baccalaureate' }).success).toBe(false);
  });

  it('flags what is missing and names and merges items', () => {
    expect(programsTarget.validate!(item({ degreeLevel: null, unitName: null }), scope, undefined as never)).toEqual(['No degree level was found.', 'No owning unit was found.']);
    expect(programsTarget.validate!(item(), scope, undefined as never)).toEqual([]);
    expect(programsTarget.proposalLabel(item())).toBe('BSc Nursing');
    expect(programsTarget.dedupeKey!(item({ nameEn: 'BSc  Nursing' }))).not.toBeNull();
    expect(programsTarget.dedupeKey!(item({ nameAr: 'تمريض' }))).toBe(programsTarget.dedupeKey!(item()));
    expect(programsTarget.dedupeKey!(item({ degreeLevel: 'master' }))).not.toBe(programsTarget.dedupeKey!(item()));
  });
});

describe('a run end to end', () => {
  let runId: string;
  let applyId: string;

  it('reads a list, proposes programs with flags, and applies the accepted ones as the person', async () => {
    const bytes = pdf([
      'Program: BSc Nursing | bachelor | College of Health\nProgram: MSc Data Science | master | Engineering\nThe catalogue of programs of the university with enough words to count as a page of text.',
      'Program: Diploma in Welding |  | \nThe second page of the catalogue of programs of the university with enough words to count as a page.',
    ]);
    const d = await as('alo', (c) => uploadDocument(c, { scopeKind: 'programs', scopeId: null, fileName: 'catalogue.pdf', mime: 'application/pdf', bytes }));
    setAiModelForTests(createFakeAiModel([programsResponder()]).model);
    await expect(as('contrib', (c) => startImport(c, { scopeKind: 'programs', scopeId: null, targetKind: 'programs', documentIds: [d.id] }))).rejects.toThrow(ForbiddenError);
    const run = await as('alo', (c) => startImport(c, { scopeKind: 'programs', scopeId: null, targetKind: 'programs', documentIds: [d.id] }));
    runId = run.id;
    await drain();
    expect((await q(`select prompt_version, status from import_run where id = $1`, [runId]))[0]).toEqual({ prompt_version: 'v1', status: 'succeeded' });
    const list = (await as('alo', (c) => listImportProposals(c, runId))).proposals;
    expect(list.map((p) => [p.label, p.quoteVerified])).toEqual([['BSc Nursing', true], ['MSc Data Science', true], ['Diploma in Welding', true]]);
    expect(list[2]!.flags).toEqual(['No degree level was found.', 'No owning unit was found.']);
    // The run wrote nothing to the real records.
    expect((await as('alo', (c) => listPrograms(c))).map((p) => p.nameEn)).toEqual(['BS Mechanical Engineering']);
    await as('alo', (c) => decideImportProposals(c, runId, { ids: list.map((p) => p.id), decision: 'accept' }));

    const res = await as('alo', (c) => applyImport(c, runId));
    expect(res.applied).toBe(2);
    expect(res.skipped).toEqual([{ proposalId: expect.any(String), label: 'Diploma in Welding', reason: expect.stringContaining('no degree level') }]);
    applyId = res.applyId!;
    const programs = await as('alo', (c) => listPrograms(c));
    expect(programs.map((p) => p.nameEn)).toEqual(['BS Mechanical Engineering', 'BSc Nursing', 'MSc Data Science']);
    const units = await as('alo', (c) => listOrgUnits(c));
    // "Engineering" matched the existing unit; "College of Health" was proposed as a new unit.
    expect(units.map((u) => u.nameEn).sort()).toEqual(['College of Health', 'Engineering']);
    expect(programs.find((p) => p.nameEn === 'MSc Data Science')!.orgUnitId).toBe(units.find((u) => u.nameEn === 'Engineering')!.id);
    expect((await q(`select created_by from program where name_en = 'BSc Nursing'`))[0].created_by).toBe(w.ids.alo);
  }, 120000);

  it('undoes and redoes the programs and the unit it added, and refuses when a person changed a program since', async () => {
    await as('alo', (c) => undoImportApply(c, applyId));
    expect((await as('alo', (c) => listPrograms(c))).filter((p) => p.active).map((p) => p.nameEn)).toEqual(['BS Mechanical Engineering']);
    expect((await as('alo', (c) => listOrgUnits(c))).filter((u) => u.active).map((u) => u.nameEn)).toEqual(['Engineering']);
    await as('alo', (c) => redoImportApply(c, applyId));
    const active = (await as('alo', (c) => listPrograms(c))).filter((p) => p.active);
    expect(active.map((p) => p.nameEn)).toEqual(['BS Mechanical Engineering', 'BSc Nursing', 'MSc Data Science']);

    const nursing = active.find((p) => p.nameEn === 'BSc Nursing')!;
    await as('alo', (c) => updateProgram(c, nursing.id, { discipline: 'Health sciences' }));
    await expect(as('alo', (c) => undoImportApply(c, applyId))).rejects.toThrow(/was changed since/);
    // Nothing was switched off.
    expect((await as('alo', (c) => listPrograms(c))).filter((p) => p.active)).toHaveLength(3);
  });
});

describe('apply rules', () => {
  it('skips what exists (active or not, in either language), matches units by Arabic fold, and merges nothing twice', async () => {
    const unitId = (await q(`select id from org_unit where name_en = 'Engineering'`))[0].id as string;
    await q(`update org_unit set name_ar = 'كلية الهندسة' where id = $1`, [unitId]);
    await q(`insert into program (institution_id, org_unit_id, name_en, name_ar, degree_level, active) values ($1, $2, 'BSc Old Program', 'برنامج قديم', 'bachelor', false)`, [w.ids.inst, unitId]);
    // Decomposed Arabic (letters + combining marks / different alef) must still match, and what is stored is NFC.
    const decomposed = 'ألهندسة المدنية'; // alef + hamza above: not NFC
    const res = await apply([
      item({ nameEn: 'BSc Old Program', unitName: 'Engineering' }),
      item({ nameEn: 'Something Else', nameAr: 'برنامج قديم', unitName: 'Engineering' }),
      item({ nameEn: 'BEng Civil', nameAr: decomposed, unitName: 'كلية الهندسة', discipline: 'Civil' }),
      item({ nameEn: 'beng civil', unitName: 'Engineering' }),
    ]);
    expect(res.outcomes.map((o) => o.status)).toEqual(['skipped', 'skipped', 'applied', 'skipped']);
    const [civil] = (await as('alo', (c) => listPrograms(c))).filter((p) => p.nameEn === 'BEng Civil');
    expect(civil!.nameAr).toBe(decomposed.normalize('NFC'));
    expect(civil!.orgUnitId).toBe(unitId);
    expect((await q(`select count(*)::int n from org_unit`))[0].n).toBe(2);
  });

  it('a person without program:write cannot apply, and an item without a degree level is left alone with the reason', async () => {
    await expect(apply([item({ nameEn: 'Anything', unitName: 'Engineering' })], 'contrib')).rejects.toThrow(ForbiddenError);
    const before = (await as('alo', (c) => listPrograms(c))).length;
    const res = await apply([item({ nameEn: 'Is Skipped', degreeLevel: null })]);
    expect(res.outcomes).toEqual([{ proposalId: 'p0', status: 'skipped', reason: expect.stringContaining('degree level') }]);
    expect((await as('alo', (c) => listPrograms(c))).length).toBe(before);
  });
});
