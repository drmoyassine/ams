// Programs from documents (TASK-076, v3 DEC-043). The import target for the `programs` scope, in two steps: each window of pages yields
// the FACTS it states about programs (each with its quote); one more call puts the facts of every document together into one item per
// program and matches each to the institution's existing programs by meaning ("ACCOUNTING Bac" is "Bachelor of Business Administration
// - Accounting"). A person reviews each program beside its source: which program it is (or new), and field by field what changes.
// Apply creates the new programs and updates the matched ones (fields, PEOs and PLOs by code; never deleting anything) through the
// ordinary services as that person; one inverse takes the whole apply back and Redo puts it again, refused when a person changed since.
import { and, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { learningOutcome, orgUnit, program } from '@ams/db';
import { DEGREE_LEVELS, PROGRAM_MODES, type UpdateProgram } from '@ams/shared';
import { ConflictError, ForbiddenError, ValidationError, type Ctx } from '../ctx.js';
import { normalizeQuoteText } from '../framework/quote-match.js';
import { registerImportTarget, type ApplyItem, type ApplyOutcome, type ImportTarget, type OutlineEntry } from '../documents/targets.js';
import { createOutcome, updateOutcome } from '../outcomes/outcomes.js';
import { createProgram, listPrograms, updateProgram } from './programs.js';
import { unitPaths, type UnitRow } from './programs-sheets.js';
import { createOrgUnit, updateOrgUnit } from './units.js';
import { listOrgUnitTypes } from './unit-types.js';

// Every field is present in a stored proposal (null when the document does not state it), so the review shows a cell for each to fill in.
const opt = <T extends z.ZodType>(t: T) => t.nullish().default(null);

/**
 * The degree level as the AMS stores it, from however a person or the model wrote it: any case, and the usual words and
 * abbreviations (Bachelor's, BSc, B.A., MBA, PhD, …). Anything else is left as written so the schema can say it does not fit.
 */
const DEGREE_WORDS: [RegExp, (typeof DEGREE_LEVELS)[number]][] = [
  [/^(associate|associates|associate'?s|a\.?a\.?|a\.?s\.?)( degree)?$/i, 'associate'],
  [/^(bachelor|bachelors|bachelor'?s|undergraduate|b\.?\s?sc\.?|b\.?\s?a\.?|b\.?\s?s\.?|b\.?\s?eng\.?|b\.?\s?ed\.?|bba|llb)( degree)?$/i, 'bachelor'],
  [/^(master|masters|master'?s|m\.?\s?sc\.?|m\.?\s?a\.?|m\.?\s?s\.?|m\.?\s?eng\.?|m\.?\s?ed\.?|mba|llm|graduate)( degree)?$/i, 'master'],
  [/^(doctorate|doctoral|doctor|ph\.?\s?d\.?|d\.?\s?phil\.?|ed\.?\s?d\.?)( degree)?$/i, 'doctorate'],
  [/^(diploma|higher diploma|postgraduate diploma|pg diploma)$/i, 'diploma'],
  [/^(certificate|graduate certificate|postgraduate certificate)$/i, 'certificate'],
];
export function normalizeDegreeLevel(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t) return null;
  return DEGREE_WORDS.find(([re]) => re.test(t))?.[1] ?? t;
}

const MODE_TEXT: Record<string, (typeof PROGRAM_MODES)[number]> = {
  oncampus: 'on_campus', campus: 'on_campus', fulltime: 'on_campus', parttime: 'on_campus', fulltimeandparttime: 'on_campus', regular: 'on_campus', inperson: 'on_campus',
  online: 'online', distance: 'online', distancelearning: 'online', elearning: 'online', blended: 'blended', hybrid: 'blended',
};
/** The mode as the AMS stores it, from however it is written ("Full-time" is on campus); anything else is dropped (null). */
export function normalizeMode(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const k = v.toLowerCase().replace(/[^a-z]/g, '');
  return k ? (MODE_TEXT[k] ?? (PROGRAM_MODES as readonly string[]).find((m) => m.replace('_', '') === k) ?? null) : null;
}
const num = (int: boolean) => z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : Number(v.replace(/[^\d.]/g, ''))) : v), (int ? z.number().int() : z.number()).positive().nullish()).default(null);

/** A PEO or PLO as the document states it; its code when printed (an existing outcome with the same code is updated). */
const OutcomeItem = z.object({ code: opt(z.string().trim()), text: z.string().trim().min(1), textAr: opt(z.string().trim()) });

/**
 * One program the documents describe (v3): the program it is when the institution already has it (`matchProgramId`, proposed by the AI
 * and changed by the person), everything the documents state about it, and `keep`: the fields (and "peo:CODE" / "plo:CODE") a person
 * chose to leave as they are on the existing program. Older runs' items (v2) still parse.
 */
export const ProgramImportItemSchema = z.object({
  matchProgramId: opt(z.uuid()),
  matchReason: opt(z.string().trim()),
  nameEn: z.string().trim().min(1),
  nameAr: opt(z.string().trim()),
  degreeLevel: z.preprocess(normalizeDegreeLevel, z.enum(DEGREE_LEVELS).nullish()).default(null),
  code: opt(z.string().trim()),
  externalId: opt(z.string().trim()),
  /** The owning unit as the document names it, or its org-chart path; matched to the org chart, or proposed as a new unit. */
  unitName: opt(z.string().trim()),
  unitType: opt(z.string().trim().min(1)),
  mode: z.preprocess(normalizeMode, z.enum(PROGRAM_MODES).nullish()).default(null),
  credits: num(true),
  durationYears: num(false),
  contactHours: num(true),
  languageOfInstruction: opt(z.string().trim()),
  mission: opt(z.string().trim()),
  vision: opt(z.string().trim()),
  discipline: opt(z.string().trim()),
  peos: z.array(OutcomeItem).default([]),
  plos: z.array(OutcomeItem).default([]),
  keep: z.array(z.string()).default([]),
});
export type ProgramImportItem = z.infer<typeof ProgramImportItemSchema>;

export const PROGRAMS_TARGET_KIND = 'programs';

/** Names compare as NFC, folded Arabic (alef forms, tatweel, diacritics) and lower case: the AMS side of matching. */
const fold = (s: string | null | undefined) => (s ? normalizeQuoteText(s) : '');


// ---- Step 1: the facts of each window ----------------------------------------------------------------------------------------

export const FACT_FIELDS = ['name_en', 'name_ar', 'degree_level', 'code', 'sis_code', 'unit', 'mode', 'credits', 'years', 'contact_hours', 'language', 'mission', 'vision', 'discipline', 'peo', 'plo'] as const;
const FactSchema = z.object({
  program: z.string().trim().min(1),
  field: z.enum(FACT_FIELDS),
  value: z.string().trim().min(1),
  code: opt(z.string().trim()),
});
type Fact = z.infer<typeof FactSchema>;

// ---- Step 2: one item per program, matched ------------------------------------------------------------------------------------

const AnswerOutcome = z.object({ code: z.string().nullish(), text: z.string(), text_ar: z.string().nullish() });
const AnswerItemSchema = z.object({
  match: z.string().nullish(), match_reason: z.string().nullish(),
  name_en: z.string().nullish(), name_ar: z.string().nullish(), degree_level: z.string().nullish(), code: z.string().nullish(), sis_code: z.string().nullish(),
  unit: z.string().nullish(), mode: z.string().nullish(), credits: z.union([z.number(), z.string()]).nullish(), years: z.union([z.number(), z.string()]).nullish(),
  contact_hours: z.union([z.number(), z.string()]).nullish(), language: z.string().nullish(), mission: z.string().nullish(), vision: z.string().nullish(), discipline: z.string().nullish(),
  peos: z.array(AnswerOutcome).default([]), plos: z.array(AnswerOutcome).default([]),
  from: z.array(z.number().int()).default([]),
  confidence: z.number().min(0).max(1).nullish(),
  flags: z.array(z.string()).default([]),
});
type AnswerItem = z.infer<typeof AnswerItemSchema>;
const AnswerSchema = z.object({ items: z.array(AnswerItemSchema) });

/** The existing programs as the organise call sees them (P1, P2, …), and what `build` resolves the references with. */
interface Known { ref: string; id: string; code: string | null; nameEn: string; nameAr: string | null; degreeLevel: string }
const PATH = ' › ';
const pathText = (s: string) => s.replace(/\s*(?:›|»|>|\/)\s*/g, PATH).trim();

async function knownPrograms(ctx: Ctx): Promise<{ text: string; data: Known[] }> {
  const [programs, units] = await Promise.all([listPrograms(ctx), ctx.tx.select({ id: orgUnit.id, parentId: orgUnit.parentId, nameEn: orgUnit.nameEn, code: orgUnit.code, active: orgUnit.active }).from(orgUnit)]);
  const paths = unitPaths(units as UnitRow[]);
  const outcomes = programs.length ? await ctx.tx.select({ programId: learningOutcome.programId, kind: learningOutcome.kind, code: learningOutcome.code, textEn: learningOutcome.textEn })
    .from(learningOutcome).where(and(inArray(learningOutcome.programId, programs.map((p) => p.id)), inArray(learningOutcome.kind, ['peo', 'plo']))) : [];
  const data: Known[] = programs.slice(0, 400).map((p, i) => ({ ref: `P${i + 1}`, id: p.id, code: p.code, nameEn: p.nameEn, nameAr: p.nameAr, degreeLevel: p.degreeLevel }));
  const lines = programs.slice(0, 400).map((p, i) => {
    const mine = outcomes.filter((o) => o.programId === p.id);
    const outs = (k: string) => mine.filter((o) => o.kind === k).slice(0, 15).map((o) => `${o.code} ${o.textEn.slice(0, 90)}`).join(' | ');
    return [`P${i + 1} · code ${p.code ?? '(none)'} · ${p.degreeLevel} · ${p.nameEn}${p.nameAr ? ` / ${p.nameAr}` : ''} · unit ${paths.get(p.orgUnitId) ?? '?'}${p.active ? '' : ' · inactive'}`,
      ...(mine.some((o) => o.kind === 'peo') ? [`   PEOs: ${outs('peo')}`] : []), ...(mine.some((o) => o.kind === 'plo') ? [`   PLOs: ${outs('plo')}`] : [])].join('\n');
  });
  const chart = [...paths.entries()].filter(([id]) => units.find((u) => u.id === id)?.active).map(([, p]) => p).sort().slice(0, 300);
  return {
    text: [programs.length ? lines.join('\n') : 'The institution has no programs yet.', '', 'The org chart (one unit per line):', ...(chart.length ? chart : ['(empty)'])].join('\n'),
    data,
  };
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.normalize('NFC').trim() : null);
const numText = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? v : null);

function buildItem(a: AnswerItem, sources: OutlineEntry<Fact>[], data: unknown): { item: ProgramImportItem; confidence?: number | null; flags?: string[] } {
  const known = (Array.isArray(data) ? data : []) as Known[];
  const flags = [...a.flags];
  const fact = (f: Fact['field']) => sources.find((s) => s.item.field === f)?.item.value ?? null;
  const nameEn = str(a.name_en) ?? str(fact('name_en')) ?? sources[0]?.item.program ?? 'Unnamed program';
  const base = {
    nameEn, nameAr: str(a.name_ar), degreeLevel: str(a.degree_level), code: str(a.code), externalId: str(a.sis_code), unitName: str(a.unit) ? pathText(str(a.unit)!) : null,
    mode: str(a.mode), credits: numText(a.credits), durationYears: numText(a.years), contactHours: numText(a.contact_hours), languageOfInstruction: str(a.language),
    mission: str(a.mission), vision: str(a.vision), discipline: str(a.discipline),
    peos: a.peos.filter((o) => str(o.text)).map((o) => ({ code: str(o.code), text: str(o.text)!, textAr: str(o.text_ar) })),
    plos: a.plos.filter((o) => str(o.text)).map((o) => ({ code: str(o.code), text: str(o.text)!, textAr: str(o.text_ar) })),
  };
  let match = a.match ? known.find((k) => k.ref.toLowerCase() === a.match!.trim().toLowerCase()) : undefined;
  let reason = str(a.match_reason);
  if (a.match && !match) flags.push(`The AI named an existing program (${a.match}) that is not on the list; choose the program in the review.`);
  // A backstop the AI's judgement cannot miss: the same code, or the same name at the same level.
  if (!match) {
    const level = normalizeDegreeLevel(base.degreeLevel);
    const same = known.find((k) => (base.code && k.code && fold(k.code) === fold(base.code)) || ((fold(k.nameEn) === fold(nameEn) || (k.nameAr && base.nameAr && fold(k.nameAr) === fold(base.nameAr))) && (!level || k.degreeLevel === level)));
    if (same) { match = same; reason = `Same ${base.code && same.code && fold(same.code) === fold(base.code) ? 'code' : 'name'} as ${same.code ?? same.nameEn}.`; flags.push('Matched by its code or name, not by the AI: check it.'); }
  }
  const parsed = ProgramImportItemSchema.safeParse({ ...base, matchProgramId: match?.id ?? null, matchReason: reason });
  if (parsed.success) return { item: parsed.data, confidence: a.confidence ?? null, flags };
  // A value that does not fit (a degree level the AMS does not know, a number that is not one) is dropped with a flag, not the program.
  const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
  const cleaned = Object.fromEntries(Object.entries({ ...base, matchProgramId: match?.id ?? null, matchReason: reason }).map(([k, v]) => [k, bad.has(k) ? (Array.isArray(v) ? [] : null) : v]));
  for (const k of bad) flags.push(`The document's ${k} did not fit and was left empty.`);
  return { item: ProgramImportItemSchema.parse(cleaned), confidence: a.confidence ?? null, flags };
}

// ---- The record fields a matched program can take, and how they read ----------------------------------------------------------

export const PROGRAM_IMPORT_FIELDS = ['nameEn', 'nameAr', 'degreeLevel', 'code', 'externalId', 'unitName', 'mode', 'credits', 'durationYears', 'contactHours', 'languageOfInstruction', 'mission', 'vision', 'discipline'] as const;
type ImportField = (typeof PROGRAM_IMPORT_FIELDS)[number];
const FIELD_LABEL: Record<ImportField, string> = {
  nameEn: 'Name (English)', nameAr: 'Name (Arabic)', degreeLevel: 'Program level', code: 'Program code', externalId: 'SIS code', unitName: 'Unit', mode: 'Mode', credits: 'Credits',
  durationYears: 'Years', contactHours: 'Contact hours', languageOfInstruction: 'Language', mission: 'Mission', vision: 'Vision', discipline: 'Discipline',
};
const same = (a: unknown, b: unknown) => (typeof a === 'string' && typeof b === 'string' ? fold(a) === fold(b) : a === b);
const outKey = (o: { code: string | null; text: string }) => (o.code ? `c:${fold(o.code)}` : `t:${fold(o.text)}`);

type ProgramRow = typeof program.$inferSelect;
type OutcomeRow = typeof learningOutcome.$inferSelect;
interface Plan {
  /** The record's changes (field -> [now, proposed]) for a matched program; every stated field for a new one. */
  fields: { field: ImportField; now: unknown; next: unknown }[];
  outcomes: { kind: 'peo' | 'plo'; key: string; code: string | null; now: OutcomeRow | null; text: string; textAr: string | null }[];
}

/** What applying the item would change on its program (or write, for a new one), without what the person chose to keep. */
function planOf(item: ProgramImportItem, cur: ProgramRow | null, unitPath: string | null, outs: OutcomeRow[]): Plan {
  const keep = new Set(item.keep);
  const fields: Plan['fields'] = [];
  for (const f of PROGRAM_IMPORT_FIELDS) {
    const next = item[f];
    if (next === null || next === undefined || keep.has(f)) continue;
    const now = cur ? (f === 'unitName' ? unitPath : (cur as unknown as Record<string, unknown>)[f] ?? null) : null;
    if (cur && same(now, f === 'unitName' ? pathText(String(next)) : next)) continue;
    fields.push({ field: f, now, next });
  }
  const outcomes: Plan['outcomes'] = [];
  for (const kind of ['peo', 'plo'] as const) {
    const mine = outs.filter((o) => o.kind === kind);
    for (const o of kind === 'peo' ? item.peos : item.plos) {
      const key = outKey(o);
      if (keep.has(`${kind}:${o.code ?? o.text}`)) continue;
      const now = mine.find((m) => (o.code ? fold(m.code) === fold(o.code) : fold(m.textEn) === fold(o.text))) ?? null;
      if (now && fold(now.textEn) === fold(o.text) && (!o.textAr || fold(now.textAr) === fold(o.textAr))) continue;
      outcomes.push({ kind, key, code: o.code, now, text: o.text, textAr: o.textAr });
    }
  }
  return { fields, outcomes };
}

async function loadState(ctx: Ctx) {
  const units = await ctx.tx.select({ id: orgUnit.id, parentId: orgUnit.parentId, nameEn: orgUnit.nameEn, nameAr: orgUnit.nameAr, code: orgUnit.code, active: orgUnit.active }).from(orgUnit);
  const paths = unitPaths(units as UnitRow[]);
  const programs = await ctx.tx.select().from(program);
  const outs = programs.length ? await ctx.tx.select().from(learningOutcome).where(and(inArray(learningOutcome.programId, programs.map((p) => p.id)), inArray(learningOutcome.kind, ['peo', 'plo']))) : [];
  /** A unit by its org-chart path, its code, or its (English or Arabic) name when that is unique. */
  const unitOf = (text: string) => {
    const t = fold(pathText(text));
    const exact = units.filter((u) => u.active && ((u.code && fold(u.code) === t) || fold(paths.get(u.id) ?? '') === t));
    if (exact.length) return exact;
    return units.filter((u) => u.active && (fold(u.nameEn) === t || (u.nameAr && fold(u.nameAr) === t) || fold(u.nameEn) === fold(t.split(PATH).at(-1) ?? '')));
  };
  return { units, paths, programs, outs, unitOf };
}

const describe_ = (plan: Plan) => [
  ...plan.fields.map((f) => FIELD_LABEL[f.field]),
  ...(['peo', 'plo'] as const).flatMap((k) => {
    const list = plan.outcomes.filter((o) => o.kind === k);
    const add = list.filter((o) => !o.now).length; const upd = list.length - add;
    return [...(add ? [`${add} new ${k.toUpperCase()}${add === 1 ? '' : 's'}`] : []), ...(upd ? [`${upd} ${k.toUpperCase()} text${upd === 1 ? '' : 's'}`] : [])];
  }),
];

// ---- Apply and reverse: one list of "set these values" steps, undone and redone the same way --------------------------------

interface Step { table: 'program' | 'outcome' | 'unit'; id: string; label: string; before: Record<string, unknown>; after: Record<string, unknown> }
interface InverseV3 { v: 3; steps: Step[]; state: 'applied' | 'undone' }
/** The v2 apply's inverse (create-only), kept so its Undo still works. */
interface CreatedProgram { id: string; snap: { orgUnitId: string; nameEn: string; nameAr: string | null; degreeLevel: string; discipline: string | null; tags: string[] } }
interface InverseV2 { programs: CreatedProgram[]; units: string[]; to: 'inactive' | 'active' }

const norm = (v: unknown) => (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v ?? null);

async function setStep(ctx: Ctx, s: Step, to: 'before' | 'after') {
  const from = to === 'before' ? s.after : s.before;
  const values = to === 'before' ? s.before : s.after;
  const row = s.table === 'program' ? (await ctx.tx.select().from(program).where(inArray(program.id, [s.id])))[0]
    : s.table === 'outcome' ? (await ctx.tx.select().from(learningOutcome).where(inArray(learningOutcome.id, [s.id])))[0]
    : (await ctx.tx.select().from(orgUnit).where(inArray(orgUnit.id, [s.id])))[0];
  if (!row) throw new ConflictError(`Cannot ${to === 'before' ? 'undo' : 'redo'}: ${s.label} is not there any more.`);
  for (const [k, v] of Object.entries(from)) {
    if (norm((row as Record<string, unknown>)[k]) !== norm(v)) throw new ConflictError(`Cannot ${to === 'before' ? 'undo' : 'redo'}: ${s.label} was changed since.`);
  }
  if (s.table === 'program') await updateProgram(ctx, s.id, values as UpdateProgram);
  else if (s.table === 'outcome') await updateOutcome(ctx, s.id, values as never);
  else await updateOrgUnit(ctx, s.id, values as never);
}

async function applyV3(ctx: Ctx, items: ApplyItem<ProgramImportItem>[]) {
  const st = await loadState(ctx);
  const unitTypes = new Set((await listOrgUnitTypes(ctx)).map((t) => t.key));
  const outcomes: ApplyOutcome[] = [];
  const steps: Step[] = [];
  const skip = (proposalId: string, reason: string) => outcomes.push({ proposalId, status: 'skipped', reason });
  const byId = new Map(st.programs.map((p) => [p.id, p]));
  const touched = new Set<string>();
  for (const it of items) {
    const p = it.item;
    const cur = p.matchProgramId ? byId.get(p.matchProgramId) ?? null : null;
    if (p.matchProgramId && !cur) { skip(it.proposalId, 'the program it was matched to is not there any more; choose it again or make it new'); continue; }
    if (cur && touched.has(cur.id)) { skip(it.proposalId, `another accepted item already updates ${cur.code ?? cur.nameEn} in this apply; merge them or match this one elsewhere`); continue; }
    // The unit: an existing one, or (for a new program, or a change the person kept) a new unit under the path's known part.
    let unitId: string | null = null;
    let unitNote = '';
    const wantsUnit = p.unitName && !p.keep.includes('unitName');
    if (wantsUnit) {
      const found = st.unitOf(p.unitName!);
      if (found.length > 1 && cur && found.some((u) => u.id === cur.orgUnitId)) unitId = cur.orgUnitId;
      else if (found.length === 1) unitId = found[0]!.id;
      else if (found.length > 1) { if (!cur) { skip(it.proposalId, `the unit "${p.unitName}" matches ${found.length} units; write its path ("College › Department")`); continue; } unitNote = ` The unit "${p.unitName}" matches several units and was left as it is.`; }
      else {
        const parts = pathText(p.unitName!).split(PATH);
        const parent = parts.length > 1 ? st.unitOf(parts.slice(0, -1).join(PATH)) : [];
        try {
          const made = await createOrgUnit(ctx, { parentId: parent.length === 1 ? parent[0]!.id : null, type: unitTypes.has(p.unitType ?? '') ? (p.unitType as string) : 'other', nameEn: parts.at(-1)!.normalize('NFC') });
          unitId = made.id;
          st.units.push({ id: made.id, parentId: made.parentId, nameEn: made.nameEn, nameAr: made.nameAr, code: made.code, active: true });
          st.paths.set(made.id, pathText(p.unitName!));
          steps.push({ table: 'unit', id: made.id, label: `the unit "${made.nameEn}"`, before: { active: false }, after: { active: true } });
        } catch (e) {
          if (!(e instanceof ForbiddenError)) throw e;
          if (!cur) { skip(it.proposalId, `the unit "${p.unitName}" is not in the org chart and you may not add units`); continue; }
          unitNote = ` The unit "${p.unitName}" is not in the org chart and was left as it is.`;
        }
      }
    }
    // A code another program holds is not taken.
    const holder = p.code && !p.keep.includes('code') ? st.programs.find((x) => x.code && fold(x.code) === fold(p.code) && x.id !== cur?.id) : undefined;
    const outs = cur ? st.outs.filter((o) => o.programId === cur.id) : [];
    const plan = planOf({ ...p, keep: [...p.keep, ...(holder ? ['code'] : [])] }, cur, cur ? st.paths.get(cur.orgUnitId) ?? null : null, outs);
    const patch: Record<string, unknown> = {};
    for (const f of plan.fields) { if (f.field === 'unitName') { if (unitId && unitId !== cur?.orgUnitId) patch.orgUnitId = unitId; } else patch[f.field] = f.next; }
    const codeNote = holder ? ` The code ${p.code} belongs to ${holder.nameEn} and was not used.` : '';
    try {
      let programId: string;
      if (cur) {
        if (Object.keys(patch).length) {
          const before = Object.fromEntries(Object.keys(patch).map((k) => [k, (cur as unknown as Record<string, unknown>)[k] ?? null]));
          await updateProgram(ctx, cur.id, patch as UpdateProgram);
          steps.push({ table: 'program', id: cur.id, label: `the program "${cur.nameEn}"`, before, after: patch });
        }
        programId = cur.id;
      } else {
        if (!p.degreeLevel) { skip(it.proposalId, 'a new program needs its level; choose one in the review and apply again'); continue; }
        if (!unitId) { skip(it.proposalId, 'a new program needs its unit; name one in the review and apply again'); continue; }
        const { orgUnitId: _o, ...rest } = patch as Record<string, unknown>; void _o;
        delete rest.unitName;
        const made = await createProgram(ctx, { ...(rest as object), orgUnitId: unitId, nameEn: p.nameEn.normalize('NFC'), degreeLevel: p.degreeLevel, tags: [], ...(p.nameAr ? { nameAr: p.nameAr.normalize('NFC') } : {}) } as Parameters<typeof createProgram>[1]);
        st.programs.push(made as unknown as ProgramRow); byId.set(made.id, made as unknown as ProgramRow);
        steps.push({ table: 'program', id: made.id, label: `the program "${made.nameEn}"`, before: { active: false }, after: { active: true } });
        programId = made.id;
      }
      touched.add(programId);
      const nextCode = (kind: 'peo' | 'plo') => { const used = new Set(st.outs.filter((o) => o.programId === programId && o.kind === kind).map((o) => fold(o.code))); let n = 1; while (used.has(fold(`${kind.toUpperCase()}${n}`))) n++; return `${kind.toUpperCase()}${n}`; };
      for (const o of plan.outcomes) {
        if (o.now) {
          const after = { textEn: o.text, ...(o.textAr ? { textAr: o.textAr } : {}) };
          const before = { textEn: o.now.textEn, ...(o.textAr ? { textAr: o.now.textAr } : {}) };
          await updateOutcome(ctx, o.now.id, after);
          steps.push({ table: 'outcome', id: o.now.id, label: `${o.now.code}`, before, after });
        } else {
          const code = o.code && !st.outs.some((x) => x.programId === programId && x.kind === o.kind && fold(x.code) === fold(o.code)) ? o.code : nextCode(o.kind);
          const made = await createOutcome(ctx, { kind: o.kind, programId, code, textEn: o.text, ...(o.textAr ? { textAr: o.textAr } : {}) });
          st.outs.push({ id: made.id, programId, kind: o.kind, code, textEn: o.text, textAr: o.textAr } as OutcomeRow);
          steps.push({ table: 'outcome', id: made.id, label: code, before: { status: 'retired' }, after: { status: 'draft' } });
        }
      }
      const what = describe_(plan);
      outcomes.push({ proposalId: it.proposalId, status: 'applied', ref: { programId, updated: !!cur, changes: what, note: (codeNote + unitNote).trim() || null } });
    } catch (e) {
      if (e instanceof ValidationError || e instanceof ConflictError) { skip(it.proposalId, e.message); continue; }
      throw e;
    }
  }
  return { outcomes, inverse: { v: 3, steps, state: 'applied' } satisfies InverseV3 };
}

export const programsTarget: ImportTarget<ProgramImportItem> = {
  kind: PROGRAMS_TARGET_KIND, label: 'Programs', itemsLabel: 'programs', scopeKinds: ['programs'],
  description: 'Reads every document together: the programs they describe, matched to the programs you have (by meaning, not spelling), with their record, PEOs and PLOs. You confirm each match and each change.',
  schema: ProgramImportItemSchema,
  promptTask: 'import_programs_organise', promptVersion: 'v1',
  buildPrompt: () => '',
  organise: {
    outline: {
      schema: FactSchema, promptTask: 'import_programs_facts', promptVersion: 'v1',
      buildPrompt: (w) => [
        'Find every fact about an academic program in these pages.',
        `Document: ${w.documentName}. Language: ${w.language}. This window: pages ${w.firstPage} to ${w.lastPage}.`,
        '', w.pages,
      ].join('\n'),
    },
    promptTask: 'import_programs_organise', promptVersion: 'v1',
    context: (ctx) => knownPrograms(ctx),
    buildPrompt: ({ documents, entries, context }) => [
      'Documents:', ...documents.map((d) => `- ${d.name} (language: ${d.language})`),
      '', 'Facts found in them:',
      ...(entries as OutlineEntry<Fact>[]).map((e) => `[${e.n}] ${e.item.program} · ${e.item.field}${e.item.code ? ` ${e.item.code}` : ''}: ${e.item.value}`),
      '', 'The institution\'s programs as they are now:', context,
    ].join('\n'),
    answer: AnswerSchema,
    from: (a: AnswerItem) => a.from,
    build: (a: AnswerItem, sources: OutlineEntry<Fact>[], data?: unknown) => buildItem(a, sources, data),
  },
  async validate(item, _scope, ctx) {
    const why: string[] = [];
    const st = await loadState(ctx);
    const cur = item.matchProgramId ? st.programs.find((p) => p.id === item.matchProgramId) ?? null : null;
    if (item.matchProgramId && !cur) why.push('The program it was matched to is not there any more.');
    if (!cur) {
      if (!item.degreeLevel) why.push('No program level was found (a new program needs one).');
      if (!item.unitName) why.push('No owning unit was found (a new program needs one).');
      else if (!st.unitOf(item.unitName).length) why.push(`The unit "${item.unitName}" is not in the org chart: it would be added.`);
      // A new program that looks like one the institution has: ask, never decide.
      const words = (s: string) => new Set(fold(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3 && !['bachelor', 'master', 'science', 'program', 'programme', 'degree', 'arts'].includes(w)));
      const mine = words(item.nameEn);
      const like = st.programs.find((p) => [...words(p.nameEn)].some((w) => mine.has(w)) && (!item.degreeLevel || p.degreeLevel === item.degreeLevel));
      if (like) why.push(`It is proposed as new, but looks like ${like.code ? `${like.code} ` : ''}${like.nameEn}: choose that program if it is the same.`);
    } else {
      const outs = st.outs.filter((o) => o.programId === cur.id);
      const plan = planOf(item, cur, st.paths.get(cur.orgUnitId) ?? null, outs);
      const what = describe_(plan);
      why.push(what.length ? `Updates ${cur.code ?? cur.nameEn}: ${what.join(', ')}.` : `Matches ${cur.code ?? cur.nameEn}; nothing would change.`);
      const holder = item.code ? st.programs.find((x) => x.code && fold(x.code) === fold(item.code) && x.id !== cur.id) : undefined;
      if (holder && !item.keep.includes('code')) why.push(`The code ${item.code} belongs to ${holder.nameEn}: it will not be used.`);
    }
    return why;
  },
  async fieldChoices(ctx) {
    const [types, st] = await Promise.all([listOrgUnitTypes(ctx), loadState(ctx)]);
    return {
      options: { unitType: types.map((t) => t.key) },
      suggestions: { unitName: st.units.filter((u) => u.active).map((u) => st.paths.get(u.id) ?? u.nameEn).sort((a, b) => a.localeCompare(b)) },
    };
  },
  proposalLabel: (item) => item.nameEn,
  dedupeKey: (item) => (item.matchProgramId ? `m|${item.matchProgramId}` : `n|${fold(item.nameEn)}|${item.degreeLevel ?? ''}`),

  async apply(ctx, items) { return applyV3(ctx, items); },

  /** Undo sets back what the apply set (new programs, units and outcomes switched off); Redo sets it again. Refused when a person changed something since. */
  async reverse(ctx, raw) {
    if ((raw as InverseV3).v === 3) {
      const inv = raw as InverseV3;
      const to = inv.state === 'applied' ? 'before' : 'after';
      for (const s of to === 'before' ? [...inv.steps].reverse() : inv.steps) await setStep(ctx, s, to);
      return { ...inv, state: inv.state === 'applied' ? 'undone' : 'applied' } satisfies InverseV3;
    }
    const inv = raw as InverseV2;
    if (inv.programs.length) {
      const rows = await ctx.tx.select().from(program).where(inArray(program.id, inv.programs.map((p) => p.id)));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const c of inv.programs) {
        const r = byId.get(c.id);
        const ok = r && r.orgUnitId === c.snap.orgUnitId && r.nameEn === c.snap.nameEn && r.nameAr === c.snap.nameAr && r.degreeLevel === c.snap.degreeLevel
          && r.discipline === c.snap.discipline && r.tags.join('\u0000') === c.snap.tags.join('\u0000') && r.active === (inv.to === 'inactive');
        if (!ok) throw new ConflictError(`Cannot ${inv.to === 'inactive' ? 'undo' : 'redo'}: the program "${c.snap.nameEn}" was changed since.`);
      }
    }
    const active = inv.to === 'active';
    const doPrograms = async () => { for (const c of inv.programs) await updateProgram(ctx, c.id, { active }); };
    const doUnits = async () => { for (const id of active ? inv.units : [...inv.units].reverse()) await updateOrgUnit(ctx, id, { active }); };
    if (active) { await doUnits(); await doPrograms(); } else { await doPrograms(); await doUnits(); }
    return { ...inv, to: active ? 'inactive' : 'active' } satisfies InverseV2;
  },
};

registerImportTarget(programsTarget);
