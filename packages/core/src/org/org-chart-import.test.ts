// The org chart from a picture (TASK-073): the production import target end to end with a fake model (no network), and its
// apply/reverse rules directly: units matched by name (Arabic folded) and never duplicated, a unit a person edited or locked is
// left alone, parents resolved among the accepted units, types fall back to "other", source "image", Undo to the Trash, Redo.
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
import { ocrPromptVersionFor } from '../documents/reading.js';
import { applyImport, decideImportProposals, listImportProposals, redoImportApply, undoImportApply } from '../documents/proposals.js';
import { listImportTargets, startImport } from '../documents/runs.js';
import { describeScope } from '../documents/scopes.js';
import { findImportTarget, type TargetScope } from '../documents/targets.js';
import { createOrgUnit, listOrgUnits, updateOrgUnit } from './units.js';
import { ORG_CHART_TARGET_KIND, OrgChartImportItemSchema, orgChartTarget, type OrgChartImportItem } from './org-chart-import.js';

let w: World;
const sent: (JobEnvelope & { type: JobType })[] = [];
const queue: JobQueue = { send: async (type, e) => { sent.push({ ...e, type }); } };
const as = <T>(who: string, fn: (c: Ctx) => Promise<T>) => w.as(who, (c) => fn({ ...c, queue, afterCommit: (f) => { void f(); }, undo: () => undefined }));
const q = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows;
const scope: TargetScope = { kind: 'org_chart', id: null, label: 'Org chart', runId: crypto.randomUUID() };

async function drain() {
  while (sent.length) {
    const [{ type, ...env }] = sent.splice(0, 1) as [JobEnvelope & { type: JobType }];
    await runJob(w.pool, type, env, handlers, { store: w.store, queue });
  }
}

/**
 * The fake reading model: the outline the vision model wrote reads one box per line, "[level] English | Arabic | head Name | type";
 * the parent of a box is the nearest box above it with a smaller level. One item per line, citing the line.
 */
function chartResponder() {
  return (options: unknown): object => {
    const prompt = (options as { prompt?: { role: string; content: unknown }[] }).prompt ?? [];
    const user = prompt.filter((m) => m.role === 'user').map((m) => (Array.isArray(m.content) ? m.content.map((c) => (c as { text?: string }).text ?? '').join('') : String(m.content))).join('\n');
    const items: object[] = [];
    const parts = user.split(/=== Page (\d+) ===/);
    for (let i = 1; i < parts.length; i += 2) {
      const stack: { level: number; name: string }[] = [];
      for (const m of parts[i + 1]!.matchAll(/^\[(\d)\] (.+?)[ \t]*$/gm)) {
        const level = Number(m[1]);
        while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
        const [name, ...cols] = m[2]!.split(' | ');
        const col = (prefix: string) => cols.find((c) => c.startsWith(`${prefix} `))?.slice(prefix.length + 1) ?? null;
        items.push({
          item: { nameEn: name, nameAr: cols.find((c) => !/^(head|type) /.test(c)) ?? null, type: col('type'), parentName: stack[stack.length - 1]?.name ?? null, headName: col('head'), boxText: m[0] },
          source: { page: Number(parts[i]), quote: m[0] }, confidence: name!.startsWith('Unsure') ? 0.3 : 0.9, flags: [],
        });
        stack.push({ level, name: name! });
      }
    }
    return { items };
  };
}

const item = (over: Partial<OrgChartImportItem> = {}): OrgChartImportItem => OrgChartImportItemSchema.parse({ nameEn: 'Faculty of Health', type: 'college', ...over });
const apply = (items: OrgChartImportItem[], who = 'alo') =>
  as(who, (c) => orgChartTarget.apply(c, items.map((it, i) => ({ proposalId: `p${i}`, item: it, edited: false, label: it.nameEn, source: { documentId: null, documentName: null, page: 1, quote: null, quoteVerified: true } })), scope));
const unitRows = () => q(`select name_en, name_ar, type, source, head_name, active, (select name_en from org_unit p where p.id = u.parent_id) as parent from org_unit u order by name_en`);

beforeAll(async () => {
  w = await buildWorld('orgchartimport');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
}, 120000);
afterEach(() => setAiModelForTests(null));
afterAll(async () => { await w.close(); });

describe('the target', () => {
  it('is registered for the org_chart scope with the reading model, a versioned prompt and a schema', async () => {
    expect(findImportTarget(ORG_CHART_TARGET_KIND)).toBe(orgChartTarget);
    expect(orgChartTarget.scopeKinds).toEqual(['org_chart']);
    expect(orgChartTarget.aiRole).toBe('reading');
    expect(PROMPTS.import_org_chart.v1).toMatch(/organization chart/);
    expect(PROMPTS.ocr.v2).toMatch(/indented outline/);
    expect((await as('alo', (c) => listImportTargets(c, 'org_chart', null))).map((t) => t.kind)).toEqual(['org_chart']);
    expect(await as('alo', (c) => describeScope(c, 'org_chart', null))).toBe('Org chart');
    expect(OrgChartImportItemSchema.safeParse({ nameEn: '' }).success).toBe(false);
    expect(OrgChartImportItemSchema.parse({ nameEn: 'X' })).toMatchObject({ nameAr: null, type: null, parentName: null, headName: null, boxText: null });
  });

  it('reads an org-chart upload with the outline prompt and any other upload with the plain one', async () => {
    const bytes = pdf(['A page of text with enough words in it to count as a page of text for the reader.']);
    const chart = await as('alo', (c) => uploadDocument(c, { scopeKind: 'org_chart', scopeId: null, fileName: 'chart.pdf', mime: 'application/pdf', bytes }));
    const progs = await as('alo', (c) => uploadDocument(c, { scopeKind: 'programs', scopeId: null, fileName: 'p.pdf', mime: 'application/pdf', bytes }));
    sent.length = 0;
    expect(await as('alo', (c) => ocrPromptVersionFor(c, { importDocumentId: chart.id }))).toBe('v2');
    expect(await as('alo', (c) => ocrPromptVersionFor(c, { importDocumentId: progs.id }))).toBe('v1');
    expect(await as('alo', (c) => ocrPromptVersionFor(c, { sourceDocumentId: chart.id }))).toBe('v1');
  });

  it('flags what is unclear and names and merges items', () => {
    expect(orgChartTarget.validate!(item({ parentName: 'Board', boxText: '[2] Faculty of Health' }), scope, undefined as never)).toEqual([]);
    expect(orgChartTarget.validate!(item(), scope, undefined as never)).toEqual([
      'The box text was not cited; check this unit against the picture.', 'No parent box was found: it would be added at the top level.',
    ]);
    expect(orgChartTarget.validate!(item({ parentName: 'Board', boxText: 'Dean [parent unclear]' }), scope, undefined as never)).toEqual(['The AI could not tell which box this hangs from.']);
    expect(orgChartTarget.proposalLabel(item())).toBe('Faculty of Health');
    expect(orgChartTarget.dedupeKey!(item({ nameEn: 'Faculty  of health', parentName: 'Board' }))).toBe(orgChartTarget.dedupeKey!(item({ nameEn: 'Faculty of Health', parentName: 'board' })));
    expect(orgChartTarget.dedupeKey!(item({ parentName: 'Other' }))).not.toBe(orgChartTarget.dedupeKey!(item({ parentName: 'Board' })));
  });
});

describe('a run end to end', () => {
  let runId: string;
  let applyId: string;

  it('reads a chart, proposes units with parents, heads and flags, and applies the accepted ones as the person', async () => {
    const bytes = pdf([
      '[1] Board of Trustees\n[2] Faculty of Health | Kulliyat Alsihha | head Dr Hana | type college\n[3] Nursing Department | type department\n[2] Faculty of Law | type faculty_of_nothing\n'
      + 'The chart of the university with enough words to count as a page of text for the reader.',
      '[3] Unsure Office\nThe second page of the chart with enough words to count as a page of text for the reader.',
    ]);
    const d = await as('alo', (c) => uploadDocument(c, { scopeKind: 'org_chart', scopeId: null, fileName: 'chart.pdf', mime: 'application/pdf', bytes }));
    setAiModelForTests(createFakeAiModel([chartResponder()]).model);
    await expect(as('contrib', (c) => startImport(c, { scopeKind: 'org_chart', scopeId: null, targetKind: 'org_chart', documentIds: [d.id] }))).rejects.toThrow(ForbiddenError);
    const run = await as('alo', (c) => startImport(c, { scopeKind: 'org_chart', scopeId: null, targetKind: 'org_chart', documentIds: [d.id] }));
    runId = run.id;
    await drain();
    expect((await q(`select prompt_version, status, report->'runtime' as rt from import_run where id = $1`, [runId]))[0]).toMatchObject({ prompt_version: 'v1', status: 'succeeded', rt: { role: 'reading' } });
    const list = (await as('alo', (c) => listImportProposals(c, runId))).proposals;
    expect(list.map((p) => [p.label, p.quoteVerified])).toEqual([['Board of Trustees', true], ['Faculty of Health', true], ['Nursing Department', true], ['Faculty of Law', true], ['Unsure Office', true]]);
    expect(list[0]!.flags).toContain('No parent box was found: it would be added at the top level.');
    expect(list[4]!.flags).toContain('The AI was not sure about this one.');
    expect(list[1]!.effective).toMatchObject({ nameAr: 'Kulliyat Alsihha', headName: 'Dr Hana', parentName: 'Board of Trustees', type: 'college' });
    // The run wrote nothing to the real records.
    expect((await unitRows()).map((u) => u.name_en)).toEqual(['Engineering']);
    // Accept all but one: the unit under the skipped one cannot be placed.
    const skipUnsure = list.filter((p) => p.label !== 'Unsure Office');
    await as('alo', (c) => decideImportProposals(c, runId, { ids: skipUnsure.map((p) => p.id), decision: 'accept' }));

    const res = await as('alo', (c) => applyImport(c, runId));
    expect(res.applied).toBe(4);
    applyId = res.applyId!;
    const rows = await unitRows();
    expect(rows.filter((r) => r.name_en !== 'Engineering')).toEqual([
      { name_en: 'Board of Trustees', name_ar: null, type: 'other', source: 'image', head_name: null, active: true, parent: null },
      { name_en: 'Faculty of Health', name_ar: 'Kulliyat Alsihha', type: 'college', source: 'image', head_name: 'Dr Hana', active: true, parent: 'Board of Trustees' },
      { name_en: 'Faculty of Law', name_ar: null, type: 'other', source: 'image', head_name: null, active: true, parent: 'Board of Trustees' },
      { name_en: 'Nursing Department', name_ar: null, type: 'department', source: 'image', head_name: null, active: true, parent: 'Faculty of Health' },
    ]);
    expect((await q(`select created_by, edited_by_person from org_unit where name_en = 'Faculty of Health'`))[0]).toEqual({ created_by: w.ids.alo, edited_by_person: false });
  }, 120000);

  it('undoes to the Trash, redoes from it, and refuses when a person added or changed something since', async () => {
    await as('alo', (c) => undoImportApply(c, applyId));
    expect((await unitRows()).map((u) => u.name_en)).toEqual(['Engineering']);
    expect((await q(`select count(*)::int n from trash_item where kind = 'org_unit'`))[0].n).toBeGreaterThan(0);
    await as('alo', (c) => redoImportApply(c, applyId));
    expect((await unitRows()).map((u) => u.name_en)).toEqual(['Board of Trustees', 'Engineering', 'Faculty of Health', 'Faculty of Law', 'Nursing Department']);

    const nursing = (await as('alo', (c) => listOrgUnits(c))).find((u) => u.nameEn === 'Nursing Department')!;
    await as('alo', (c) => createOrgUnit(c, { parentId: nursing.id, type: 'other', nameEn: 'A Person Added This' }));
    await expect(as('alo', (c) => undoImportApply(c, applyId))).rejects.toThrow(/added under a unit this import made/);
    expect((await unitRows()).map((u) => u.name_en)).toContain('Nursing Department');
    await q(`delete from org_unit where name_en = 'A Person Added This'`);
    await as('alo', (c) => updateOrgUnit(c, nursing.id, { nameEn: 'Nursing Dept' }));
    await expect(as('alo', (c) => undoImportApply(c, applyId))).rejects.toThrow(/was changed or removed since/);
  });
});

describe('apply rules', () => {
  it('never duplicates: matches by name with Arabic folded, leaves a locked or person-edited unit alone, and skips with the reason', async () => {
    const eng = (await q(`select id from org_unit where name_en = 'Engineering'`))[0].id as string;
    await q(`update org_unit set name_ar = 'كلية الهندسة', locked = true where id = $1`, [eng]);
    await q(`insert into org_unit (institution_id, type, name_en, name_ar, edited_by_person) values ($1, 'college', 'Business', 'كلية الأعمال', true)`, [w.ids.inst]);
    const before = (await unitRows()).length;
    const res = await apply([
      item({ nameEn: 'Engineering' }),
      item({ nameEn: 'Faculty of Business', nameAr: 'كلية الاعمال' }),
      item({ nameEn: 'Business' }),
      item({ nameEn: 'Business' }),
    ]);
    expect(res.outcomes.map((o) => o.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
    expect((res.outcomes[0] as { reason: string }).reason).toMatch(/locked/);
    expect((res.outcomes[1] as { reason: string }).reason).toMatch(/a person edited it/);
    expect((res.outcomes[2] as { reason: string }).reason).toMatch(/twice/);
    expect((await unitRows()).length).toBe(before);
  });

  it('puts a new unit under a parent that is in the chart or among the accepted units, and skips one whose parent is nowhere', async () => {
    const res = await apply([
      item({ nameEn: 'Library', type: 'DEPARTMENT', parentName: 'Registry Office' }),
      item({ nameEn: 'Registry Office', type: null, parentName: 'كلية الهندسة' }),
      item({ nameEn: 'Orphan', parentName: 'Nowhere At All' }),
      item({ nameEn: 'Loop A', parentName: 'Loop B' }),
      item({ nameEn: 'Loop B', parentName: 'Loop A' }),
    ]);
    expect(res.outcomes.map((o) => o.status)).toEqual(['applied', 'applied', 'skipped', 'skipped', 'skipped']);
    expect((res.outcomes[2] as { reason: string }).reason).toMatch(/"Nowhere At All" is not in the org chart/);
    expect((res.outcomes[3] as { reason: string }).reason).toMatch(/could not be worked out/);
    const rows = await unitRows();
    expect(rows.find((r) => r.name_en === 'Registry Office')).toMatchObject({ parent: 'Engineering', type: 'other', source: 'image' });
    expect(rows.find((r) => r.name_en === 'Library')).toMatchObject({ parent: 'Registry Office', type: 'department' });
  });

  it('moves an existing unit nobody edited under the parent the picture shows, and Undo moves it back', async () => {
    const unit = await as('alo', (c) => createOrgUnit(c, { parentId: null, type: 'department', nameEn: 'Stray Unit' }));
    const out = await as('alo', async (c) => {
      const r = await orgChartTarget.apply(c, [{ proposalId: 'm', item: item({ nameEn: 'Stray Unit', parentName: 'Registry Office' }), edited: false, label: 'Stray Unit', source: { documentId: null, documentName: null, page: 1, quote: null, quoteVerified: true } }], scope);
      return r;
    });
    expect(out.outcomes[0]).toMatchObject({ status: 'applied', ref: { moved: true } });
    expect((await unitRows()).find((r) => r.name_en === 'Stray Unit')!.parent).toBe('Registry Office');
    const undone = await as('alo', (c) => orgChartTarget.reverse(c, out.inverse, scope));
    expect((await unitRows()).find((r) => r.name_en === 'Stray Unit')!.parent).toBeNull();
    await as('alo', (c) => orgChartTarget.reverse(c, undone, scope));
    expect((await unitRows()).find((r) => r.name_en === 'Stray Unit')!.parent).toBe('Registry Office');
    expect(unit.id).toBeTruthy();
  });

  it('a unit the person may not add is left alone with the reason', async () => {
    const before = (await unitRows()).length;
    const res = await apply([item({ nameEn: 'Anything' })], 'contrib');
    expect(res.outcomes).toEqual([{ proposalId: 'p0', status: 'skipped', reason: 'you may not add units at the top level' }]);
    expect((await unitRows()).length).toBe(before);
  });
});
