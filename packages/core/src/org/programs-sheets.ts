// Programs from a workbook or the API's bulk upsert (the owner, 2026-11-16): rows matched by Program code (PEOs and PLOs by their code within
// the program) are updated, others added, nothing absent is removed. An empty cell leaves the field as it is. A row missing a required field
// is saved and flagged; one that cannot be placed (no code, English name, unit or level) is skipped with the reason. With `apply` false
// nothing is written: the result says what would happen.
import { eq } from 'drizzle-orm';
import { learningOutcome, orgUnit, program } from '@ams/db';
import {
  BLOOM_LEVELS, DEGREE_LEVELS, PROGRAM_MODES, programMissing, sheetCell, UpsertProgramsSchema,
  type Program, type UpdateProgram, type UpsertPrograms, type UpsertProgramsResult, type UpsertProgramsRow,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { assertPermitted } from '../permissions.js';
import { createProgram, toProgram, updateProgram } from './programs.js';
import { createOutcome, updateOutcome } from '../outcomes/outcomes.js';

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const LEVEL_WORDS: Record<string, (typeof DEGREE_LEVELS)[number]> = Object.fromEntries(DEGREE_LEVELS.flatMap((d) => [[d, d], [key(d), d]]));
const MODE_WORDS: Record<string, (typeof PROGRAM_MODES)[number]> = { oncampus: 'on_campus', campus: 'on_campus', fulltime: 'on_campus', parttime: 'on_campus', online: 'online', blended: 'blended', hybrid: 'blended' };
const intOf = (s: string) => (s === '' ? undefined : Number.isFinite(Number(s)) ? Math.round(Number(s)) : NaN);

export async function upsertPrograms(ctx: Ctx, input: UpsertPrograms): Promise<UpsertProgramsResult> {
  await assertPermitted(ctx, 'program:write', { type: 'any' });
  const { workbook, apply } = UpsertProgramsSchema.parse(input);
  const units = await ctx.tx.select({ id: orgUnit.id, nameEn: orgUnit.nameEn, code: orgUnit.code, active: orgUnit.active }).from(orgUnit);
  const existing = await ctx.tx.select().from(program);
  const byCode = new Map(existing.filter((p) => p.code).map((p) => [key(p.code!), p]));
  const out: UpsertProgramsRow[] = [];
  const res = { added: 0, updated: 0, unchanged: 0, skipped: 0 };
  const note = (r: UpsertProgramsRow) => { out.push(r); res[r.action === 'add' ? 'added' : r.action === 'update' ? 'updated' : r.action === 'unchanged' ? 'unchanged' : 'skipped'] += 1; };
  /** Program code -> the program's id (null while it is only to be added), for the PEO and PLO rows. */
  const placed = new Map<string, { id: string | null; record: Partial<Program> }>();

  // ---- Programs
  for (const [i, r] of workbook.programs.entries()) {
    const c = (h: string) => sheetCell(r, h);
    const code = c('Program code'); const row = i + 2;
    const skip = (message: string) => note({ sheet: 'Programs', row, code, action: 'skip', message });
    if (!code) { skip('no Program code'); continue; }
    const cur = byCode.get(key(code));
    const unitText = c('Unit');
    const unitMatches = unitText ? units.filter((u) => (u.code && key(u.code) === key(unitText)) || key(u.nameEn) === key(unitText)) : [];
    if (unitText && unitMatches.length !== 1) { skip(unitMatches.length ? `the unit "${unitText}" matches ${unitMatches.length} units: use its code` : `no unit "${unitText}" in the org chart`); continue; }
    const levelText = c('Program level');
    const level = levelText ? LEVEL_WORDS[key(levelText)] : undefined;
    if (levelText && !level) { skip(`unknown program level "${levelText}"`); continue; }
    const nameEn = c('Name (English)');
    if (!cur && (!nameEn || !unitMatches.length || !level)) { skip(`a new program needs ${[!nameEn && 'Name (English)', !unitMatches.length && 'Unit', !level && 'Program level'].filter(Boolean).join(', ')}`); continue; }
    const modeText = c('Mode'); const mode = modeText ? MODE_WORDS[key(modeText)] : undefined;
    const nums = { credits: intOf(c('Credits')), contactHours: intOf(c('Contact hours')), durationYears: c('Years') === '' ? undefined : Number(c('Years')) };
    const badNum = Object.entries(nums).find(([, v]) => v !== undefined && Number.isNaN(v));
    if (badNum) { skip(`${badNum[0] === 'durationYears' ? 'Years' : badNum[0] === 'contactHours' ? 'Contact hours' : 'Credits'} is not a number`); continue; }
    const activeText = key(c('Active'));
    const patch: UpdateProgram = {};
    if (nameEn) patch.nameEn = nameEn;
    if (c('Name (Arabic)')) patch.nameAr = c('Name (Arabic)');
    if (unitMatches[0]) patch.orgUnitId = unitMatches[0].id;
    if (level) patch.degreeLevel = level;
    patch.code = code;
    if (c('SIS code')) patch.externalId = c('SIS code');
    if (mode) patch.mode = mode;
    if (nums.credits !== undefined) patch.credits = nums.credits;
    if (nums.contactHours !== undefined) patch.contactHours = nums.contactHours;
    if (nums.durationYears !== undefined) patch.durationYears = nums.durationYears;
    if (c('Language')) patch.languageOfInstruction = c('Language');
    if (c('Mission')) patch.mission = c('Mission');
    if (c('Vision')) patch.vision = c('Vision');
    if (['yes', 'true', '1', 'active'].includes(activeText)) patch.active = true;
    if (['no', 'false', '0', 'inactive'].includes(activeText)) patch.active = false;
    const warn = modeText && !mode ? ` Unknown mode "${modeText}" (On-campus, Online or Blended) left as it was.` : '';
    if (cur) {
      const now = toProgram(cur);
      const changed = (Object.keys(patch) as (keyof UpdateProgram)[]).filter((k) => (now as unknown as Record<string, unknown>)[k] !== patch[k]);
      const record = { ...now, ...patch } as Program;
      placed.set(key(code), { id: cur.id, record });
      if (!changed.length) { note({ sheet: 'Programs', row, code, action: 'unchanged', message: warn.trim() }); continue; }
      if (apply) await updateProgram(ctx, cur.id, Object.fromEntries(changed.map((k) => [k, patch[k]])) as UpdateProgram);
      note({ sheet: 'Programs', row, code, action: 'update', message: `Changes: ${changed.join(', ')}.${warn}` });
    } else {
      let id: string | null = null;
      if (apply) {
        const rest = { ...patch }; delete rest.active;
        id = (await createProgram(ctx, { ...rest, orgUnitId: unitMatches[0]!.id, nameEn, degreeLevel: level!, tags: [], ...(rest.nameAr ? { nameAr: rest.nameAr } : {}) } as Parameters<typeof createProgram>[1])).id;
        byCode.set(key(code), { id } as typeof existing[number]);
      }
      placed.set(key(code), { id, record: patch as Partial<Program> });
      note({ sheet: 'Programs', row, code, action: 'add', message: warn.trim() });
    }
  }

  // ---- PEOs and PLOs (by their code within the program)
  const counts = new Map<string, { peos: number; plos: number }>();
  for (const [sheet, kind, rowsOf] of [['PEOs', 'peo', workbook.peos], ['PLOs', 'plo', workbook.plos]] as const) {
    for (const [i, r] of rowsOf.entries()) {
      const c = (h: string) => sheetCell(r, h);
      const pcode = c('Program code'); const ocode = c('Code'); const text = c('Statement (English)'); const row = i + 2;
      const label = `${pcode} ${ocode}`.trim();
      const skip = (message: string) => note({ sheet, row, code: label, action: 'skip', message });
      if (!pcode || !ocode || !text) { skip(`needs ${[!pcode && 'Program code', !ocode && 'Code', !text && 'Statement (English)'].filter(Boolean).join(', ')}`); continue; }
      let target = placed.get(key(pcode));
      if (!target) { const p = byCode.get(key(pcode)); if (p?.id) target = { id: p.id, record: {} }; }
      if (!target) { skip(`no program with the code ${pcode}`); continue; }
      const cn = counts.get(key(pcode)) ?? { peos: 0, plos: 0 }; cn[kind === 'peo' ? 'peos' : 'plos'] += 1; counts.set(key(pcode), cn);
      const bloomText = kind === 'plo' ? c('Bloom level') : '';
      const bloom = bloomText ? BLOOM_LEVELS.find((b) => key(b) === key(bloomText)) : undefined;
      const ar = c('Statement (Arabic)');
      const cur = target.id ? (await ctx.tx.select().from(learningOutcome).where(eq(learningOutcome.programId, target.id))).find((o) => o.kind === kind && key(o.code) === key(ocode)) : undefined;
      if (cur) {
        const changed = cur.textEn !== text || (ar && cur.textAr !== ar) || (bloom && cur.bloomLevel !== bloom);
        if (!changed) { note({ sheet, row, code: label, action: 'unchanged', message: '' }); continue; }
        if (apply) await updateOutcome(ctx, cur.id, { textEn: text, ...(ar ? { textAr: ar } : {}), ...(bloom ? { bloomLevel: bloom } : {}) });
        note({ sheet, row, code: label, action: 'update', message: '' });
      } else {
        if (apply && target.id) await createOutcome(ctx, { kind, programId: target.id, code: ocode, textEn: text, ...(ar ? { textAr: ar } : {}), ...(bloom ? { bloomLevel: bloom } : {}) });
        note({ sheet, row, code: label, action: 'add', message: bloomText && !bloom ? `Unknown Bloom level "${bloomText}" left empty.` : '' });
      }
    }
  }

  // ---- What each program in the file still lacks (flagged, not refused)
  for (const r of out.filter((x) => x.sheet === 'Programs' && x.action !== 'skip')) {
    const p = placed.get(key(r.code))!;
    const have = p.id ? await ctx.tx.select({ kind: learningOutcome.kind }).from(learningOutcome).where(eq(learningOutcome.programId, p.id)) : [];
    const fromFile = counts.get(key(r.code)) ?? { peos: 0, plos: 0 };
    const missing = programMissing(p.record as Program, { peos: Math.max(have.filter((x) => x.kind === 'peo').length, fromFile.peos), plos: Math.max(have.filter((x) => x.kind === 'plo').length, fromFile.plos) });
    if (missing.length) r.message = `${r.message ? `${r.message} ` : ''}Missing: ${missing.join(', ')}.`;
  }
  return { applied: apply, ...res, rows: out };
}

const LEVEL_LABEL: Record<string, string> = { associate: 'Associate', bachelor: 'Bachelor', master: 'Master', doctorate: 'Doctorate', diploma: 'Diploma', certificate: 'Certificate' };
const MODE_LABEL: Record<string, string> = { on_campus: 'On-campus', online: 'Online', blended: 'Blended' };

/** The programs the caller sees, with their PEOs and PLOs, as the template's rows (the export, and the API's read of everything at once). */
export async function exportPrograms(ctx: Ctx): Promise<import('@ams/shared').ProgramsWorkbook> {
  await assertPermitted(ctx, 'program:read', { type: 'any' });
  const units = new Map((await ctx.tx.select({ id: orgUnit.id, nameEn: orgUnit.nameEn, code: orgUnit.code }).from(orgUnit)).map((u) => [u.id, u]));
  const progs = (await ctx.tx.select().from(program)).sort((a, b) => a.nameEn.localeCompare(b.nameEn));
  const outcomes = progs.length ? await ctx.tx.select().from(learningOutcome) : [];
  const wb: import('@ams/shared').ProgramsWorkbook = { programs: [], peos: [], plos: [] };
  for (const p of progs) {
    const code = p.code ?? '';
    const u = units.get(p.orgUnitId);
    wb.programs.push({
      'Program code': code, 'Name (English)': p.nameEn, 'Name (Arabic)': p.nameAr ?? '', Unit: u?.code || u?.nameEn || '', 'Program level': LEVEL_LABEL[p.degreeLevel] ?? p.degreeLevel,
      'SIS code': p.externalId ?? '', Mode: p.mode ? MODE_LABEL[p.mode] ?? p.mode : '', Credits: p.credits, Years: p.durationYears === null ? null : Number(p.durationYears),
      'Contact hours': p.contactHours, Language: p.languageOfInstruction ?? '', Mission: p.mission ?? '', Vision: p.vision ?? '', Active: p.active ? 'Yes' : 'No',
    });
    const mine = outcomes.filter((o) => o.programId === p.id && o.status !== 'retired').sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code, 'en', { numeric: true }));
    for (const o of mine.filter((x) => x.kind === 'peo')) wb.peos.push({ 'Program code': code, Code: o.code, 'Statement (English)': o.textEn, 'Statement (Arabic)': o.textAr ?? '' });
    for (const o of mine.filter((x) => x.kind === 'plo')) wb.plos.push({ 'Program code': code, Code: o.code, 'Statement (English)': o.textEn, 'Statement (Arabic)': o.textAr ?? '', 'Bloom level': o.bloomLevel ?? '' });
  }
  return wb;
}
