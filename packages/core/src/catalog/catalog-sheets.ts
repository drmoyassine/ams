// The catalog's structure in the academic workbook (DEC-045, DEC-046): Concentrations, Requirement blocks, Elective slots, GenEd areas and
// Catalog settings. The academic workbook calls this in two stages around the courses: `structure` (settings, areas, concentrations, block
// credits: what the study plan names) and `late` (the areas' pools and the elective slots: what needs the courses). Rows write directly (the
// workbook's preview is the whole apply inside a savepoint that is taken back). A row that cannot be applied is skipped with the reason.
import { eq } from 'drizzle-orm';
import { concentration, course, genedArea, genedAreaCourse, program, programBlock, studyPlanSlot } from '@ams/db';
import { BLOCK_LABEL, CATALOG_SHEETS, GENED_CREDITS_SETTING, REQUIREMENT_BLOCKS, sheetCell, type CatalogWorkbook, type RequirementBlock, type UpsertCatalogRow } from '@ams/shared';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Ctx } from '../ctx.js';
import {
  createConcentration, createGenedArea, createStudySlot, getCatalogSettings, setAreaCourses, setCatalogSettings, setProgramBlock, updateConcentration, updateGenedArea, updateStudySlot,
} from './catalog.js';

const key = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numOf = (s: string) => (s === '' ? undefined : Number.isFinite(Number(s)) ? Number(s) : NaN);
const blockOf = (text: string): RequirementBlock | undefined => REQUIREMENT_BLOCKS.find((b) => key(b) === key(text) || key(BLOCK_LABEL[b]) === key(text));
const same = (a: unknown, b: unknown) => (typeof a === 'string' || typeof b === 'string' ? key(String(a ?? '')) === key(String(b ?? '')) : (a ?? null) === (b ?? null));
const isSkip = (e: unknown): e is Error => e instanceof ForbiddenError || e instanceof ValidationError || e instanceof ConflictError || e instanceof NotFoundError || (e instanceof Error && /integrity|duplicate|unique|already/i.test(e.message));

export type CatalogStage = 'structure' | 'late';

export async function upsertCatalog(ctx: Ctx, wb: CatalogWorkbook, stage: CatalogStage): Promise<UpsertCatalogRow[]> {
  const out: UpsertCatalogRow[] = [];
  const programs = await ctx.tx.select({ id: program.id, code: program.code, nameEn: program.nameEn }).from(program);
  const programOf = (code: string) => programs.find((p) => p.code && key(p.code) === key(code));
  let concentrations = await ctx.tx.select().from(concentration);
  const concOf = (programId: string, text: string) => concentrations.find((c) => c.programId === programId && (key(c.code) === key(text) || key(c.nameEn) === key(text)));
  let areas = await ctx.tx.select().from(genedArea);
  const areaOf = (text: string) => areas.find((a) => key(a.code) === key(text) || key(a.nameEn) === key(text));
  const rowFor = <T extends { sheet: string }>(r: T) => out.push(r as never);

  if (stage === 'structure') {
    // ---- Catalog settings
    for (const [i, r] of wb.catalog.entries()) {
      const row = i + 2; const name = sheetCell(r, 'Setting'); const value = sheetCell(r, 'Value');
      if (!value) continue; // an empty setting leaves it as it is
      const res = (action: UpsertCatalogRow['action'], message = '') => rowFor({ sheet: CATALOG_SHEETS.catalog.name, row, code: name, action, message });
      if (key(name) !== key(GENED_CREDITS_SETTING)) { res('skip', `unknown setting "${name}" (${GENED_CREDITS_SETTING})`); continue; }
      const n = numOf(value);
      if (n === undefined || Number.isNaN(n) || n < 0) { res('skip', 'the value is a number of credits'); continue; }
      try {
        if ((await getCatalogSettings(ctx)).genedCredits === n) { res('unchanged'); continue; }
        await setCatalogSettings(ctx, { genedCredits: n }); res('update');
      } catch (e) { if (!isSkip(e)) throw e; res('skip', e.message); }
    }
    // ---- GenEd areas (the pool is set later, once the courses exist)
    for (const [i, r] of wb.genedAreas.entries()) {
      const c = (h: string) => sheetCell(r, h); const row = i + 2; const code = c('Code'); const idText = c('ID');
      const res = (action: UpsertCatalogRow['action'], message = '') => rowFor({ sheet: CATALOG_SHEETS.genedAreas.name, row, code: code || idText, action, message });
      if (!code && !idText) { res('skip', 'no Code'); continue; }
      const cur = idText ? areas.find((a) => a.id === idText) : areas.find((a) => key(a.code) === key(code));
      if (idText && !cur) { res('skip', `no area with the ID ${idText} (leave the ID empty to add one)`); continue; }
      const min = numOf(c('Minimum credits'));
      if (min !== undefined && (Number.isNaN(min) || min < 0)) { res('skip', 'Minimum credits is a number'); continue; }
      try {
        if (!cur) {
          if (!c('Name (English)')) { res('skip', 'a new area needs Name (English)'); continue; }
          const made = await createGenedArea(ctx, { code, nameEn: c('Name (English)'), ...(c('Name (Arabic)') ? { nameAr: c('Name (Arabic)') } : {}), minCredits: min ?? 0 });
          areas = await ctx.tx.select().from(genedArea); void made; res('add'); continue;
        }
        const patch: Record<string, unknown> = {};
        if (code && (idText || false) && !same(cur.code, code)) patch.code = code;
        if (c('Name (English)') && !same(cur.nameEn, c('Name (English)'))) patch.nameEn = c('Name (English)');
        if (c('Name (Arabic)') && !same(cur.nameAr, c('Name (Arabic)'))) patch.nameAr = c('Name (Arabic)');
        if (min !== undefined && Number(cur.minCredits) !== min) patch.minCredits = min;
        if (!Object.keys(patch).length) { res('unchanged'); continue; }
        await updateGenedArea(ctx, cur.id, patch); areas = await ctx.tx.select().from(genedArea); res('update', `Changes: ${Object.keys(patch).join(', ')}.`);
      } catch (e) { if (!isSkip(e)) throw e; res('skip', e.message); }
    }
    // ---- Concentrations
    for (const [i, r] of wb.concentrations.entries()) {
      const c = (h: string) => sheetCell(r, h); const row = i + 2; const code = c('Code'); const pc = c('Program code'); const idText = c('ID');
      const res = (action: UpsertCatalogRow['action'], message = '') => rowFor({ sheet: CATALOG_SHEETS.concentrations.name, row, code: `${pc} ${code}`.trim() || idText, action, message });
      const prog = programOf(pc);
      if (!prog) { res('skip', pc ? `no program with the code ${pc}` : 'no Program code'); continue; }
      if (!code && !idText) { res('skip', 'no Code'); continue; }
      const cur = idText ? concentrations.find((k) => k.id === idText) : concentrations.find((k) => k.programId === prog.id && key(k.code) === key(code));
      if (idText && !cur) { res('skip', `no concentration with the ID ${idText} (leave the ID empty to add one)`); continue; }
      const activeText = key(c('Active'));
      try {
        if (!cur) {
          if (!c('Name (English)')) { res('skip', 'a new concentration needs Name (English)'); continue; }
          await createConcentration(ctx, { programId: prog.id, code, nameEn: c('Name (English)'), ...(c('Name (Arabic)') ? { nameAr: c('Name (Arabic)') } : {}) });
          concentrations = await ctx.tx.select().from(concentration); res('add'); continue;
        }
        const patch: Record<string, unknown> = {};
        if (code && idText && !same(cur.code, code)) patch.code = code;
        if (c('Name (English)') && !same(cur.nameEn, c('Name (English)'))) patch.nameEn = c('Name (English)');
        if (c('Name (Arabic)') && !same(cur.nameAr, c('Name (Arabic)'))) patch.nameAr = c('Name (Arabic)');
        if (['yes', 'true', '1', 'active'].includes(activeText) && !cur.active) patch.active = true;
        if (['no', 'false', '0', 'inactive'].includes(activeText) && cur.active) patch.active = false;
        if (!Object.keys(patch).length) { res('unchanged'); continue; }
        await updateConcentration(ctx, cur.id, patch); concentrations = await ctx.tx.select().from(concentration); res('update', `Changes: ${Object.keys(patch).join(', ')}.`);
      } catch (e) { if (!isSkip(e)) throw e; res('skip', e.message); }
    }
    // ---- Requirement blocks: core and elective credits of a block, per program (or concentration)
    const blocks = await ctx.tx.select().from(programBlock);
    for (const [i, r] of wb.blocks.entries()) {
      const c = (h: string) => sheetCell(r, h); const row = i + 2; const pc = c('Program code');
      const label = `${pc} ${c('Block')}${c('Concentration') ? ` ${c('Concentration')}` : ''}`.trim();
      const res = (action: UpsertCatalogRow['action'], message = '') => rowFor({ sheet: CATALOG_SHEETS.blocks.name, row, code: label, action, message });
      const prog = programOf(pc);
      if (!prog) { res('skip', pc ? `no program with the code ${pc}` : 'no Program code'); continue; }
      const block = blockOf(c('Block'));
      if (!block) { res('skip', `unknown block "${c('Block')}" (${REQUIREMENT_BLOCKS.map((b) => BLOCK_LABEL[b]).join(', ')})`); continue; }
      const conc = c('Concentration') ? concOf(prog.id, c('Concentration')) : undefined;
      if (c('Concentration') && !conc) { res('skip', `no concentration "${c('Concentration')}" in ${prog.code}`); continue; }
      if (block === 'concentration' && !conc) { res('skip', 'the concentration block needs its Concentration'); continue; }
      if (block !== 'concentration' && conc) { res('skip', 'only the concentration block has a Concentration'); continue; }
      const credits = { core: numOf(c('Core credits')), elective: numOf(c('Elective credits')) };
      if ([credits.core, credits.elective].some((n) => n !== undefined && (Number.isNaN(n) || n < 0))) { res('skip', 'Core credits and Elective credits are numbers'); continue; }
      let changed = 0; let seen = 0;
      try {
        for (const [requirement, n] of [['core', credits.core], ['elective', credits.elective]] as const) {
          if (n === undefined) continue;
          seen++;
          const cur = blocks.find((b) => b.programId === prog.id && b.block === block && b.requirement === requirement && (b.concentrationId ?? null) === (conc?.id ?? null));
          if (cur && Number(cur.credits) === n) continue;
          await setProgramBlock(ctx, { programId: prog.id, block, requirement, credits: n, ...(conc ? { concentrationId: conc.id } : {}) }); changed++;
        }
        res(!seen ? 'skip' : changed ? 'update' : 'unchanged', seen ? '' : 'no Core credits or Elective credits');
      } catch (e) { if (!isSkip(e)) throw e; res('skip', e.message); }
    }
  } else {
    // ---- The areas' pools: exactly the courses listed, when the cell is not empty
    const courses = await ctx.tx.select({ id: course.id, code: course.code }).from(course);
    const pools = await ctx.tx.select().from(genedAreaCourse);
    for (const [i, r] of wb.genedAreas.entries()) {
      const row = i + 2; const code = sheetCell(r, 'Code'); const idText = sheetCell(r, 'ID'); const list = sheetCell(r, 'Courses');
      if (!list) continue;
      const area = idText ? areas.find((a) => a.id === idText) : areas.find((a) => key(a.code) === key(code));
      if (!area) continue;
      const names = list.split(/[;,\n]/).map((x) => x.trim()).filter(Boolean);
      const found = names.map((n) => ({ n, c: courses.find((x) => key(x.code) === key(n)) }));
      const unknown = found.filter((f) => !f.c).map((f) => f.n);
      const ids = [...new Set(found.filter((f) => f.c).map((f) => f.c!.id))];
      const now = pools.filter((p) => p.areaId === area.id).map((p) => p.courseId);
      const label = `${area.code} courses`;
      try {
        if (ids.length === now.length && ids.every((x) => now.includes(x))) { rowFor({ sheet: CATALOG_SHEETS.genedAreas.name, row, code: label, action: 'unchanged', message: unknown.length ? `No course ${unknown.join(', ')}.` : '' }); continue; }
        await setAreaCourses(ctx, area.id, ids);
        rowFor({ sheet: CATALOG_SHEETS.genedAreas.name, row, code: label, action: 'update', message: `${ids.length} course${ids.length === 1 ? '' : 's'} in the pool${unknown.length ? `; no course ${unknown.join(', ')}` : ''}.` });
      } catch (e) { if (!isSkip(e)) throw e; rowFor({ sheet: CATALOG_SHEETS.genedAreas.name, row, code: label, action: 'skip', message: e.message }); }
    }
    // ---- Elective slots
    const slots = await ctx.tx.select().from(studyPlanSlot);
    for (const [i, r] of wb.slots.entries()) {
      const c = (h: string) => sheetCell(r, h); const row = i + 2; const pc = c('Program code'); const idText = c('ID');
      const res = (action: UpsertCatalogRow['action'], message = '') => rowFor({ sheet: CATALOG_SHEETS.slots.name, row, code: `${pc} ${c('Slot name')}`.trim() || idText, action, message });
      const prog = programOf(pc);
      if (!prog) { res('skip', pc ? `no program with the code ${pc}` : 'no Program code'); continue; }
      const block = blockOf(c('Block'));
      if (!block) { res('skip', `unknown block "${c('Block')}"`); continue; }
      const conc = c('Concentration') ? concOf(prog.id, c('Concentration')) : undefined;
      if (c('Concentration') && !conc) { res('skip', `no concentration "${c('Concentration')}" in ${prog.code}`); continue; }
      const area = c('Area') ? areaOf(c('Area')) : undefined;
      if (c('Area') && !area) { res('skip', `no General Education area "${c('Area')}"`); continue; }
      const credits = numOf(c('Credits')); const y = numOf(c('Year')); const t = numOf(c('Term'));
      if ((credits !== undefined && (Number.isNaN(credits) || credits <= 0)) || [y, t].some((n) => n !== undefined && (Number.isNaN(n) || !Number.isInteger(n)))) { res('skip', 'Credits is a positive number; Year and Term are whole numbers'); continue; }
      const cur = idText ? slots.find((s) => s.id === idText) : slots.find((s) => s.programId === prog.id && s.block === block && (s.concentrationId ?? null) === (conc?.id ?? null) && key(s.name) === key(c('Slot name')));
      if (idText && !cur) { res('skip', `no slot with the ID ${idText} (leave the ID empty to add one)`); continue; }
      try {
        if (!cur) {
          if (!c('Slot name') || credits === undefined) { res('skip', 'a new slot needs a Slot name and Credits'); continue; }
          await createStudySlot(ctx, { programId: prog.id, block, requirement: 'elective', name: c('Slot name'), credits, ...(conc ? { concentrationId: conc.id } : {}), ...(area ? { areaId: area.id } : {}), ...(c('Rule') ? { rule: c('Rule') } : {}), ...(y !== undefined ? { year: y } : {}), ...(t !== undefined ? { term: t } : {}) });
          res('add'); continue;
        }
        const patch: Record<string, unknown> = {};
        if (c('Slot name') && !same(cur.name, c('Slot name'))) patch.name = c('Slot name');
        if (c('Rule') && !same(cur.rule, c('Rule'))) patch.rule = c('Rule');
        if (credits !== undefined && Number(cur.credits) !== credits) patch.credits = credits;
        if (y !== undefined && cur.year !== y) patch.year = y;
        if (t !== undefined && cur.term !== t) patch.term = t;
        if (block !== cur.block) patch.block = block;
        if (c('Concentration') && (conc?.id ?? null) !== cur.concentrationId) patch.concentrationId = conc?.id ?? null;
        if (area && area.id !== cur.areaId) patch.areaId = area.id;
        if (!Object.keys(patch).length) { res('unchanged'); continue; }
        await updateStudySlot(ctx, cur.id, patch); res('update', `Changes: ${Object.keys(patch).join(', ')}.`);
      } catch (e) { if (!isSkip(e)) throw e; res('skip', e.message); }
    }
  }
  void UUID; void eq;
  return out;
}

/** The catalog's structure as the workbook's rows, each with its ID, and the lists the dropdowns need. */
export async function exportCatalog(ctx: Ctx): Promise<CatalogWorkbook & { lists: { areas: string[]; concentrations: string[] } }> {
  const programs = await ctx.tx.select({ id: program.id, code: program.code, nameEn: program.nameEn }).from(program);
  const code = (id: string) => programs.find((p) => p.id === id)?.code ?? '';
  const name = (id: string) => programs.find((p) => p.id === id)?.nameEn ?? '';
  const concs = await ctx.tx.select().from(concentration);
  const areas = (await ctx.tx.select().from(genedArea)).sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code));
  const pools = await ctx.tx.select().from(genedAreaCourse);
  const courses = await ctx.tx.select({ id: course.id, code: course.code }).from(course);
  const blocks = await ctx.tx.select().from(programBlock);
  const slots = await ctx.tx.select().from(studyPlanSlot);
  const settings = await getCatalogSettings(ctx);
  const byCode = (a: { program: string }, b: { program: string }) => a.program.localeCompare(b.program);
  void byCode;
  const wb: CatalogWorkbook = { concentrations: [], blocks: [], slots: [], genedAreas: [], catalog: [] };
  wb.catalog.push({ Setting: GENED_CREDITS_SETTING, Value: settings.genedCredits });
  for (const a of areas) {
    const list = pools.filter((p) => p.areaId === a.id).map((p) => courses.find((c) => c.id === p.courseId)?.code ?? '').filter(Boolean).sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
    wb.genedAreas.push({ ID: a.id, Code: a.code, 'Name (English)': a.nameEn, 'Name (Arabic)': a.nameAr ?? '', 'Minimum credits': Number(a.minCredits), Courses: list.join('; ') });
  }
  for (const k of concs.sort((a, b) => code(a.programId).localeCompare(code(b.programId)) || a.displayOrder - b.displayOrder)) {
    wb.concentrations.push({ ID: k.id, 'Program code': code(k.programId), 'Program name': name(k.programId), Code: k.code, 'Name (English)': k.nameEn, 'Name (Arabic)': k.nameAr ?? '', Active: k.active ? 'Yes' : 'No' });
  }
  const groups = new Map<string, { programId: string; concentrationId: string | null; block: RequirementBlock; core: number | null; elective: number | null }>();
  for (const b of blocks) {
    const k = `${b.programId}|${b.concentrationId ?? ''}|${b.block}`;
    const g = groups.get(k) ?? { programId: b.programId, concentrationId: b.concentrationId, block: b.block, core: null, elective: null };
    g[b.requirement] = Number(b.credits); groups.set(k, g);
  }
  for (const g of [...groups.values()].sort((a, b) => code(a.programId).localeCompare(code(b.programId)) || REQUIREMENT_BLOCKS.indexOf(a.block) - REQUIREMENT_BLOCKS.indexOf(b.block))) {
    wb.blocks.push({ 'Program code': code(g.programId), 'Program name': name(g.programId), Concentration: g.concentrationId ? concs.find((k) => k.id === g.concentrationId)?.code ?? '' : '', Block: BLOCK_LABEL[g.block], 'Core credits': g.core, 'Elective credits': g.elective });
  }
  for (const s of slots.sort((a, b) => code(a.programId).localeCompare(code(b.programId)) || (a.year ?? 99) - (b.year ?? 99) || (a.term ?? 99) - (b.term ?? 99))) {
    wb.slots.push({ ID: s.id, 'Program code': code(s.programId), 'Program name': name(s.programId), Concentration: s.concentrationId ? concs.find((k) => k.id === s.concentrationId)?.code ?? '' : '', Block: BLOCK_LABEL[s.block], 'Slot name': s.name, Rule: s.rule ?? '', Area: s.areaId ? areas.find((a) => a.id === s.areaId)?.code ?? '' : '', Credits: Number(s.credits), Year: s.year, Term: s.term });
  }
  return { ...wb, lists: { areas: areas.filter((a) => a.active).map((a) => a.code), concentrations: concs.filter((k) => k.active).map((k) => k.code) } };
}
