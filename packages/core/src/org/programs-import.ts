// Programs from documents (TASK-076, section C of docs/organization-plan.md). The import target for the `programs` scope: the AI reads
// a catalogue or a program list and proposes programs; a person reviews them beside the source page; Apply writes the accepted ones
// through the ordinary program and org-unit services, as that person, in one transaction. Create-only: a program that is already
// there (same name and degree level, active or not) is left alone and the reason is shown. One inverse takes the whole apply back.
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { program } from '@ams/db';
import { DEGREE_LEVELS, type OrgUnit } from '@ams/shared';
import { ConflictError, ForbiddenError } from '../ctx.js';
import { normalizeQuoteText } from '../framework/quote-match.js';
import { registerImportTarget, type ApplyOutcome, type ImportTarget } from '../documents/targets.js';
import { createProgram, listPrograms, updateProgram } from './programs.js';
import { createOrgUnit, listOrgUnits, updateOrgUnit } from './units.js';
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

export const ProgramImportItemSchema = z.object({
  nameEn: z.string().trim().min(1),
  nameAr: opt(z.string().trim()),
  degreeLevel: z.preprocess(normalizeDegreeLevel, z.enum(DEGREE_LEVELS).nullish()).default(null),
  discipline: opt(z.string().trim()),
  /** The owning unit as the document names it; matched to the org chart, or proposed as a new unit. */
  unitName: opt(z.string().trim()),
  unitType: opt(z.string().trim().min(1)),
  /** Stated by the document and shown in the review; the program record has no column for these yet. */
  code: opt(z.string().trim()),
  durationYears: opt(z.number().positive()),
  mode: opt(z.string().trim()),
});
export type ProgramImportItem = z.infer<typeof ProgramImportItemSchema>;

export const PROGRAMS_TARGET_KIND = 'programs';

/** Names compare as NFC, folded Arabic (alef forms, tatweel, diacritics) and lower case: the AMS side of matching. */
const fold = (s: string | null | undefined) => (s ? normalizeQuoteText(s) : '');
const nfc = (s: string | null | undefined) => (s ? s.normalize('NFC').trim() || null : null);
const keyOf = (name: string, level: string | null | undefined) => `${fold(name)}|${level ?? ''}`;

interface CreatedProgram {
  id: string;
  /** The values written, to tell later whether a person changed the program. */
  snap: { orgUnitId: string; nameEn: string; nameAr: string | null; degreeLevel: string; discipline: string | null; tags: string[] };
}
interface Inverse { programs: CreatedProgram[]; units: string[]; to: 'inactive' | 'active' }

export const programsTarget: ImportTarget<ProgramImportItem> = {
  kind: PROGRAMS_TARGET_KIND, label: 'Programs', itemsLabel: 'programs', scopeKinds: ['programs'],
  description: 'Reads the programs named in a catalogue or a program list: names in English and Arabic, degree level, owning unit and what else the document states.',
  schema: ProgramImportItemSchema,
  promptTask: 'import_programs', promptVersion: 'v2',
  buildPrompt: (w) => [
    'Find the academic programs named in these pages.',
    `Document: ${w.documentName}. Language: ${w.language}. This window: pages ${w.firstPage} to ${w.lastPage}.`,
    '', w.pages,
  ].join('\n'),
  validate(item) {
    const why: string[] = [];
    if (!item.degreeLevel) why.push('No degree level was found.');
    if (!item.unitName) why.push('No owning unit was found.');
    return why;
  },
  proposalLabel: (item) => item.nameEn,
  dedupeKey: (item) => keyOf(item.nameEn, item.degreeLevel),

  async apply(ctx, items) {
    const units = (await listOrgUnits(ctx)).filter((u) => u.active);
    const existing = new Set((await listPrograms(ctx)).flatMap((p) => [keyOf(p.nameEn, p.degreeLevel), ...(p.nameAr ? [keyOf(p.nameAr, p.degreeLevel)] : [])]));
    const unitByName = new Map<string, OrgUnit>();
    for (const u of units) { unitByName.set(fold(u.nameEn), u); if (u.nameAr) unitByName.set(fold(u.nameAr), u); }
    const unitTypes = new Set((await listOrgUnitTypes(ctx)).map((t) => t.key));
    const outcomes: ApplyOutcome[] = [];
    const created: CreatedProgram[] = [];
    const createdUnits: string[] = [];
    const skip = (proposalId: string, reason: string) => outcomes.push({ proposalId, status: 'skipped', reason });
    for (const it of items) {
      const p = it.item;
      const nameEn = p.nameEn.normalize('NFC').trim();
      const nameAr = nfc(p.nameAr);
      if (!p.degreeLevel) { skip(it.proposalId, 'no degree level; choose one in the review and apply again'); continue; }
      if (!p.unitName) { skip(it.proposalId, 'no owning unit; name one in the review and apply again'); continue; }
      if (existing.has(keyOf(nameEn, p.degreeLevel)) || (nameAr && existing.has(keyOf(nameAr, p.degreeLevel)))) {
        skip(it.proposalId, 'a program with this name and degree level already exists'); continue;
      }
      let unit = unitByName.get(fold(p.unitName));
      if (!unit) {
        // An unknown unit becomes a proposed unit: it is added to the org chart with this apply, and goes away with an undo.
        try {
          unit = await createOrgUnit(ctx, { parentId: null, type: unitTypes.has(p.unitType ?? '') ? (p.unitType as string) : 'other', nameEn: p.unitName.normalize('NFC').trim() });
        } catch (e) {
          if (!(e instanceof ForbiddenError)) throw e;
          skip(it.proposalId, `the unit "${p.unitName}" is not in the org chart and you may not add units`); continue;
        }
        unitByName.set(fold(unit.nameEn), unit);
        createdUnits.push(unit.id);
      }
      const made = await createProgram(ctx, {
        orgUnitId: unit.id, nameEn, ...(nameAr ? { nameAr } : {}), degreeLevel: p.degreeLevel,
        ...(p.discipline ? { discipline: p.discipline.normalize('NFC').trim() } : {}), tags: [],
      });
      existing.add(keyOf(made.nameEn, made.degreeLevel));
      if (made.nameAr) existing.add(keyOf(made.nameAr, made.degreeLevel));
      created.push({ id: made.id, snap: { orgUnitId: made.orgUnitId, nameEn: made.nameEn, nameAr: made.nameAr, degreeLevel: made.degreeLevel, discipline: made.discipline, tags: made.tags } });
      outcomes.push({ proposalId: it.proposalId, status: 'applied', ref: { programId: made.id, orgUnitId: unit.id, unitCreated: createdUnits.includes(unit.id) } });
    }
    const inverse: Inverse = { programs: created, units: createdUnits, to: 'inactive' };
    return { outcomes, inverse };
  },

  /** Undo switches what the apply created off; Redo switches it back on. A program a person changed since is never touched: the undo is refused. */
  async reverse(ctx, raw) {
    const inv = raw as Inverse;
    if (inv.programs.length) {
      const rows = await ctx.tx.select().from(program).where(inArray(program.id, inv.programs.map((p) => p.id)));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const c of inv.programs) {
        const r = byId.get(c.id);
        const same = r && r.orgUnitId === c.snap.orgUnitId && r.nameEn === c.snap.nameEn && r.nameAr === c.snap.nameAr && r.degreeLevel === c.snap.degreeLevel
          && r.discipline === c.snap.discipline && r.tags.join('\u0000') === c.snap.tags.join('\u0000') && r.active === (inv.to === 'inactive');
        if (!same) throw new ConflictError(`Cannot ${inv.to === 'inactive' ? 'undo' : 'redo'}: the program "${c.snap.nameEn}" was changed since.`);
      }
    }
    const active = inv.to === 'active';
    // Programs first when switching off (a unit with an active program cannot be deactivated), units first when switching back on.
    const doPrograms = async () => { for (const c of inv.programs) await updateProgram(ctx, c.id, { active }); };
    const doUnits = async () => { for (const id of active ? inv.units : [...inv.units].reverse()) await updateOrgUnit(ctx, id, { active }); };
    if (active) { await doUnits(); await doPrograms(); } else { await doPrograms(); await doUnits(); }
    const back: Inverse = { ...inv, to: active ? 'inactive' : 'active' };
    return back;
  },
};

registerImportTarget(programsTarget);
