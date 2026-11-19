// Programs from a workbook or the API's bulk upsert (the owner, 2026-11-16, 2026-11-18). A row with an ID updates that record (its code may
// change); one without is matched by Program code (PEOs and PLOs by their code within the program); anything else is added. Nothing absent is
// removed: a PEO or PLO is retired with its Status, a program with Active. An empty cell leaves the field as it is. A row missing a required
// field is saved and flagged; one that cannot be placed is skipped with the reason. With `apply` false nothing is written.
import { and, eq, inArray } from 'drizzle-orm';
import { institution, learningOutcome, orgUnit, outcomeLink, program } from '@ams/db';
import {
  BLOOM_LEVELS, DEGREE_LEVELS, OUTCOME_STATUSES, PROGRAM_MODES, PROGRAM_TYPES, languageInfo, programMissing, sheetCell, UpsertProgramsSchema,
  type Program, type ProgramsExport, type UpdateOutcome, type UpdateProgram, type UpsertPrograms, type UpsertProgramsResult, type UpsertProgramsRow,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { assertPermitted } from '../permissions.js';
import { createProgram, toProgram, updateProgram } from './programs.js';
import { createOutcome, removeOutcomeLink, setOutcomeLink, updateOutcome } from '../outcomes/outcomes.js';

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEVEL_WORDS: Record<string, (typeof DEGREE_LEVELS)[number]> = Object.fromEntries(DEGREE_LEVELS.map((d) => [key(d), d]));
const MODE_WORDS: Record<string, (typeof PROGRAM_MODES)[number]> = { oncampus: 'on_campus', campus: 'on_campus', fulltime: 'on_campus', parttime: 'on_campus', online: 'online', blended: 'blended', hybrid: 'blended' };
const intOf = (s: string) => (s === '' ? undefined : Number.isFinite(Number(s)) ? Math.round(Number(s)) : NaN);
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1).replace(/_/g, '-') : s);
const PATH = ' › ';

export type UnitRow = { id: string; parentId: string | null; nameEn: string; code: string | null; active: boolean };
/** Each unit's place in the org chart, as "College › Department". */
export function unitPaths(units: UnitRow[]): Map<string, string> {
  const byId = new Map(units.map((u) => [u.id, u]));
  const out = new Map<string, string>();
  const path = (u: UnitRow, seen = new Set<string>()): string => {
    if (out.has(u.id)) return out.get(u.id)!;
    const parent = u.parentId && !seen.has(u.parentId) ? byId.get(u.parentId) : undefined;
    const p = parent ? `${path(parent, new Set([...seen, u.id]))}${PATH}${u.nameEn}` : u.nameEn;
    out.set(u.id, p);
    return p;
  };
  for (const u of units) path(u);
  return out;
}

export async function upsertPrograms(ctx: Ctx, input: UpsertPrograms): Promise<UpsertProgramsResult> {
  await assertPermitted(ctx, 'program:write', { type: 'any' });
  const { workbook, apply } = UpsertProgramsSchema.parse(input);
  const units: UnitRow[] = await ctx.tx.select({ id: orgUnit.id, parentId: orgUnit.parentId, nameEn: orgUnit.nameEn, code: orgUnit.code, active: orgUnit.active }).from(orgUnit);
  const paths = unitPaths(units);
  const existing = await ctx.tx.select().from(program);
  const byId = new Map(existing.map((p) => [p.id, p]));
  const byCode = new Map(existing.filter((p) => p.code).map((p) => [key(p.code!), p]));
  const out: UpsertProgramsRow[] = [];
  const res = { added: 0, updated: 0, unchanged: 0, skipped: 0 };
  const note = (r: UpsertProgramsRow) => { out.push(r); res[r.action === 'add' ? 'added' : r.action === 'update' ? 'updated' : r.action === 'unchanged' ? 'unchanged' : 'skipped'] += 1; };
  /** Program code (as the file gives it) -> the program's id (null while it is only to be added) and its record, for the PEO and PLO rows. */
  const placed = new Map<string, { id: string | null; record: Partial<Program> }>();
  /** A unit by its code, its org-chart path ("College › Department") or its name when that is unique. */
  const unitOf = (text: string) => {
    const t = key(text);
    const exact = units.filter((u) => (u.code && key(u.code) === t) || key(paths.get(u.id) ?? '') === t);
    return exact.length ? exact : units.filter((u) => key(u.nameEn) === t);
  };

  // ---- Programs
  for (const [i, r] of workbook.programs.entries()) {
    const c = (h: string) => sheetCell(r, h);
    const code = c('Program code'); const idText = c('ID'); const row = i + 2;
    const skip = (message: string) => note({ sheet: 'Programs', row, code: code || idText, action: 'skip', message });
    if (!code && !idText) { skip('no Program code'); continue; }
    let cur: (typeof existing)[number] | undefined;
    if (idText) {
      cur = UUID.test(idText) ? byId.get(idText) : undefined;
      if (!cur) { skip(`no program with the ID ${idText} (leave the ID empty to add a program)`); continue; }
    } else cur = byCode.get(key(code));
    // A code already used by another program cannot be taken.
    const holder = code ? byCode.get(key(code)) : undefined;
    if (cur && holder && holder.id !== cur.id) { skip(`the Program code ${code} belongs to another program (${holder.nameEn})`); continue; }
    const unitText = c('Unit');
    let unitMatches = unitText ? unitOf(unitText) : [];
    // Two units can share a path; when the program already sits in one of them, it stays there.
    if (unitMatches.length > 1 && cur && unitMatches.some((u) => u.id === cur.orgUnitId)) unitMatches = unitMatches.filter((u) => u.id === cur.orgUnitId);
    if (unitText && unitMatches.length !== 1) { skip(unitMatches.length ? `the unit "${unitText}" matches ${unitMatches.length} units: pick it from the list (its path)` : `no unit "${unitText}" in the org chart`); continue; }
    const levelText = c('Program level');
    const level = levelText ? LEVEL_WORDS[key(levelText)] : undefined;
    if (levelText && !level) { skip(`unknown program level "${levelText}"`); continue; }
    const nameEn = c('Name (English)');
    if (!cur && (!code || !nameEn || !unitMatches.length || !level)) { skip(`a new program needs ${[!code && 'Program code', !nameEn && 'Name (English)', !unitMatches.length && 'Unit', !level && 'Program level'].filter(Boolean).join(', ')}`); continue; }
    const typeText = c('Type'); const ptype = typeText ? PROGRAM_TYPES.find((x) => key(x) === key(typeText)) : undefined;
    if (typeText && !ptype) { skip(`unknown type "${typeText}" (Degree or Minor)`); continue; }
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
    // The code changes only for a row found by its ID (or a new one); a row found by its code keeps the stored spelling.
    if (code && (idText || !cur)) patch.code = code;
    if (c('SIS code')) patch.externalId = c('SIS code');
    if (mode) patch.mode = mode;
    if (ptype) patch.programType = ptype;
    if (nums.credits !== undefined) patch.credits = nums.credits;
    if (nums.contactHours !== undefined) patch.contactHours = nums.contactHours;
    if (nums.durationYears !== undefined) patch.durationYears = nums.durationYears;
    if (c('Language')) patch.languageOfInstruction = c('Language');
    if (c('Mission')) patch.mission = c('Mission');
    if (c('Vision')) patch.vision = c('Vision');
    if (['yes', 'true', '1', 'active'].includes(activeText)) patch.active = true;
    if (['no', 'false', '0', 'inactive'].includes(activeText)) patch.active = false;
    const warn = modeText && !mode ? ` Unknown mode "${modeText}" (On-campus, Online or Blended) left as it was.` : '';
    const label = code || cur?.code || idText;
    if (cur) {
      const now = toProgram(cur);
      const changed = (Object.keys(patch) as (keyof UpdateProgram)[]).filter((k) => (now as unknown as Record<string, unknown>)[k] !== patch[k]);
      const record = { ...now, ...patch } as Program;
      placed.set(key(label), { id: cur.id, record });
      if (cur.code && key(cur.code) !== key(label)) placed.set(key(cur.code), { id: cur.id, record });
      if (code) byCode.set(key(code), cur);
      if (!changed.length) { note({ sheet: 'Programs', row, code: label, action: 'unchanged', message: warn.trim() }); continue; }
      if (apply) await updateProgram(ctx, cur.id, Object.fromEntries(changed.map((k) => [k, patch[k]])) as UpdateProgram);
      const renamed = patch.code !== undefined && cur.code && patch.code !== cur.code ? ` (code was ${cur.code})` : '';
      note({ sheet: 'Programs', row, code: label, action: 'update', message: `Changes: ${changed.join(', ')}${renamed}.${warn}` });
    } else {
      let id: string | null = null;
      if (apply) {
        const rest = { ...patch }; delete rest.active;
        const made = await createProgram(ctx, { ...rest, orgUnitId: unitMatches[0]!.id, nameEn, degreeLevel: level!, tags: [], ...(rest.nameAr ? { nameAr: rest.nameAr } : {}) } as Parameters<typeof createProgram>[1]);
        id = made.id;
      }
      byCode.set(key(code), { id: id ?? '', code, nameEn } as (typeof existing)[number]);
      placed.set(key(code), { id, record: patch as Partial<Program> });
      note({ sheet: 'Programs', row, code, action: 'add', message: warn.trim() });
    }
  }

  // ---- PEOs and PLOs (by their ID, else their code within the program)
  const ilos = await ctx.tx.select({ id: learningOutcome.id, code: learningOutcome.code }).from(learningOutcome).where(eq(learningOutcome.kind, 'ilo'));
  /** A PLO's ILOs column ("ILO1; ILO3"): the ILOs it names, those it does not know, or null for an empty cell (links left as they are). */
  const ilosOf = (text: string) => {
    if (!text.trim()) return null;
    const codes = text.split(/[;,\n]/).map((x) => x.trim()).filter(Boolean);
    const found = codes.map((c) => ilos.find((i) => key(i.code) === key(c)));
    return { ids: [...new Set(found.filter((x): x is { id: string; code: string } => !!x).map((x) => x.id))], unknown: codes.filter((_, n) => !found[n]) };
  };
  const linkedIlos = async (ploId: string) => (ilos.length ? (await ctx.tx.select({ toId: outcomeLink.toId }).from(outcomeLink)
    .where(and(eq(outcomeLink.fromId, ploId), inArray(outcomeLink.toId, ilos.map((i) => i.id))))).map((l) => l.toId) : []);
  const counts = new Map<string, { peos: number; plos: number }>();
  const outcomesOf = new Map<string, (typeof learningOutcome.$inferSelect)[]>();
  const loadOutcomes = async (programId: string) => {
    if (!outcomesOf.has(programId)) outcomesOf.set(programId, await ctx.tx.select().from(learningOutcome).where(eq(learningOutcome.programId, programId)));
    return outcomesOf.get(programId)!;
  };
  for (const [sheet, kind, rowsOf] of [['PEOs', 'peo', workbook.peos], ['PLOs', 'plo', workbook.plos]] as const) {
    for (const [i, r] of rowsOf.entries()) {
      const c = (h: string) => sheetCell(r, h);
      const pcode = c('Program code'); const ocode = c('Code'); const text = c('Statement (English)'); const idText = c('ID'); const row = i + 2;
      const label = `${pcode} ${ocode}`.trim() || idText;
      const skip = (message: string) => note({ sheet, row, code: label, action: 'skip', message });
      let target = pcode ? placed.get(key(pcode)) : undefined;
      if (!target && pcode) { const p = byCode.get(key(pcode)); if (p?.id) target = { id: p.id, record: {} }; }
      // An ID alone finds its program.
      let cur: (typeof learningOutcome.$inferSelect) | undefined;
      if (idText) {
        if (UUID.test(idText)) {
          const [o] = await ctx.tx.select().from(learningOutcome).where(eq(learningOutcome.id, idText));
          if (o && o.kind === kind && (!target?.id || o.programId === target.id)) { cur = o; if (!target) target = { id: o.programId, record: {} }; }
        }
        if (!cur) { skip(`no ${kind === 'peo' ? 'PEO' : 'PLO'} with the ID ${idText}${pcode ? ` in ${pcode}` : ''} (leave the ID empty to add one)`); continue; }
      }
      if (!target) { skip(pcode ? `no program with the code ${pcode}` : 'no Program code'); continue; }
      if (!cur && (!ocode || !text)) { skip(`a new ${kind === 'peo' ? 'PEO' : 'PLO'} needs ${[!ocode && 'Code', !text && 'Statement (English)'].filter(Boolean).join(', ')}`); continue; }
      const mine = target.id ? await loadOutcomes(target.id) : [];
      if (!cur && ocode) cur = mine.find((o) => o.kind === kind && key(o.code) === key(ocode));
      // A code already used by another outcome of the program cannot be taken.
      const clash = ocode ? mine.find((o) => o.kind === kind && key(o.code) === key(ocode) && o.id !== cur?.id) : undefined;
      if (clash) { skip(`the code ${ocode} is already used by another ${kind === 'peo' ? 'PEO' : 'PLO'} of the program`); continue; }
      const statusText = key(c('Status')); const status = statusText ? OUTCOME_STATUSES.find((st) => key(st) === statusText) : undefined;
      if (statusText && !status) { skip(`unknown status "${c('Status')}" (Draft, Approved or Retired)`); continue; }
      const bloomText = kind === 'plo' ? c('Bloom level') : '';
      const bloom = bloomText ? BLOOM_LEVELS.find((b) => key(b) === key(bloomText)) : undefined;
      const ar = c('Statement (Arabic)');
      const keyOf = key(pcode || '') || [...placed.entries()].find(([, v]) => v.id === target!.id)?.[0] || '';
      if (status !== 'retired') { const cn = counts.get(keyOf) ?? { peos: 0, plos: 0 }; cn[kind === 'peo' ? 'peos' : 'plos'] += 1; counts.set(keyOf, cn); }
      const bloomNote = bloomText && !bloom ? `Unknown Bloom level "${bloomText}" left as it was.` : '';
      const want = kind === 'plo' ? ilosOf(c('ILOs')) : null;
      const iloNote = want?.unknown.length ? `Unknown ILO${want.unknown.length === 1 ? '' : 's'} ${want.unknown.join(', ')} left out.` : '';
      /** Sets the PLO's ILO links to exactly those named (only when the cell has some). */
      const syncIlos = async (ploId: string, have: string[]) => {
        if (!want) return;
        for (const id of want.ids.filter((x) => !have.includes(x))) await setOutcomeLink(ctx, { fromId: ploId, toId: id });
        for (const id of have.filter((x) => !want.ids.includes(x))) await removeOutcomeLink(ctx, ploId, id);
      };
      if (cur) {
        const patch: UpdateOutcome = {};
        if (ocode && idText && cur.code !== ocode) patch.code = ocode;
        if (text && cur.textEn !== text) patch.textEn = text;
        if (ar && cur.textAr !== ar) patch.textAr = ar;
        if (bloom && cur.bloomLevel !== bloom) patch.bloomLevel = bloom;
        if (status && cur.status !== status) patch.status = status;
        const have = want ? await linkedIlos(cur.id) : [];
        const ilosChange = !!want && (want.ids.length !== have.length || want.ids.some((x) => !have.includes(x)));
        const changes = [...Object.keys(patch), ...(ilosChange ? ['ILOs'] : [])];
        if (!changes.length) { note({ sheet, row, code: label, action: 'unchanged', message: [bloomNote, iloNote].filter(Boolean).join(' ') }); continue; }
        if (apply) { if (Object.keys(patch).length) await updateOutcome(ctx, cur.id, patch); if (ilosChange) await syncIlos(cur.id, have); }
        note({ sheet, row, code: label, action: 'update', message: [`Changes: ${changes.join(', ')}${patch.code ? ` (code was ${cur.code})` : ''}.`, bloomNote, iloNote].filter(Boolean).join(' ') });
      } else {
        if (apply && target.id) {
          const made = await createOutcome(ctx, { kind, programId: target.id, code: ocode, textEn: text, ...(ar ? { textAr: ar } : {}), ...(bloom ? { bloomLevel: bloom } : {}) });
          if (status && status !== 'draft') await updateOutcome(ctx, made.id, { status });
          await syncIlos(made.id, []);
        }
        note({ sheet, row, code: label, action: 'add', message: [bloomNote, iloNote].filter(Boolean).join(' ') });
      }
    }
  }

  // ---- What each program in the file still lacks (flagged, not refused)
  for (const r of out.filter((x) => x.sheet === 'Programs' && x.action !== 'skip')) {
    const p = placed.get(key(r.code));
    if (!p) continue;
    const have = p.id ? (await loadOutcomes(p.id)).filter((o) => o.status !== 'retired') : [];
    const fromFile = counts.get(key(r.code)) ?? { peos: 0, plos: 0 };
    const missing = programMissing(p.record as Program, { peos: Math.max(have.filter((x) => x.kind === 'peo').length, fromFile.peos), plos: Math.max(have.filter((x) => x.kind === 'plo').length, fromFile.plos) });
    if (missing.length) r.message = `${r.message ? `${r.message} ` : ''}Missing: ${missing.join(', ')}.`;
  }
  return { applied: apply, ...res, rows: out };
}

const LEVEL_LABEL: Record<string, string> = Object.fromEntries(DEGREE_LEVELS.map((d) => [d, cap(d)]));
const MODE_LABEL: Record<string, string> = { on_campus: 'On-campus', online: 'Online', blended: 'Blended' };

/**
 * The programs the caller sees, with their PEOs and PLOs, as the template's rows (each with its ID), and the institution's choices for the
 * template's dropdowns: its units as org-chart paths and its languages. Also the API's read of everything at once.
 */
export async function exportPrograms(ctx: Ctx): Promise<ProgramsExport> {
  await assertPermitted(ctx, 'program:read', { type: 'any' });
  const unitRows: UnitRow[] = await ctx.tx.select({ id: orgUnit.id, parentId: orgUnit.parentId, nameEn: orgUnit.nameEn, code: orgUnit.code, active: orgUnit.active }).from(orgUnit);
  const paths = unitPaths(unitRows);
  const progs = (await ctx.tx.select().from(program)).sort((a, b) => a.nameEn.localeCompare(b.nameEn));
  const outcomes = await ctx.tx.select().from(learningOutcome);
  const iloCode = new Map(outcomes.filter((o) => o.kind === 'ilo').map((o) => [o.id, o.code]));
  const links = iloCode.size ? await ctx.tx.select({ fromId: outcomeLink.fromId, toId: outcomeLink.toId }).from(outcomeLink).where(inArray(outcomeLink.toId, [...iloCode.keys()])) : [];
  const [inst] = await ctx.tx.select({ secondary: institution.secondaryLanguage }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  const secondary = languageInfo(inst?.secondary)?.nameEn;
  const wb: ProgramsExport = {
    programs: [], peos: [], plos: [],
    lists: {
      units: unitRows.filter((u) => u.active).map((u) => paths.get(u.id)!).sort((a, b) => a.localeCompare(b)),
      languages: ['English', ...(secondary ? [secondary] : []), 'Bilingual'],
      ilos: outcomes.filter((o) => o.kind === 'ilo' && o.status !== 'retired').map((o) => o.code).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    },
  };
  for (const p of progs) {
    const code = p.code ?? '';
    wb.programs.push({
      ID: p.id, 'Program code': code, 'Name (English)': p.nameEn, 'Name (Arabic)': p.nameAr ?? '', Unit: paths.get(p.orgUnitId) ?? '', 'Program level': LEVEL_LABEL[p.degreeLevel] ?? p.degreeLevel, Type: p.programType === 'minor' ? 'Minor' : 'Degree',
      'SIS code': p.externalId ?? '', Mode: p.mode ? MODE_LABEL[p.mode] ?? p.mode : '', Credits: p.credits, Years: p.durationYears === null ? null : Number(p.durationYears),
      'Contact hours': p.contactHours, Language: p.languageOfInstruction ?? '', Mission: p.mission ?? '', Vision: p.vision ?? '', Active: p.active ? 'Yes' : 'No',
    });
    const mine = outcomes.filter((o) => o.programId === p.id).sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code, 'en', { numeric: true }));
    const base = (o: (typeof outcomes)[number]) => ({ ID: o.id, 'Program code': code, 'Program name': p.nameEn, Code: o.code, 'Statement (English)': o.textEn, 'Statement (Arabic)': o.textAr ?? '' });
    for (const o of mine.filter((x) => x.kind === 'peo')) wb.peos.push({ ...base(o), Status: cap(o.status) });
    for (const o of mine.filter((x) => x.kind === 'plo')) {
      const ilosOfPlo = links.filter((l) => l.fromId === o.id).map((l) => iloCode.get(l.toId)!).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      wb.plos.push({ ...base(o), 'Bloom level': o.bloomLevel ? cap(o.bloomLevel) : '', ILOs: ilosOfPlo.join('; '), Status: cap(o.status) });
    }
  }
  return wb;
}
