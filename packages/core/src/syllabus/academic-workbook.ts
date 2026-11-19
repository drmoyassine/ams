// The academic workbook (DEC-045): programs, PEOs, PLOs, courses, the study plan and course content as ONE file. This applies the two parts
// in order, programs first so that courses of the same file can name them, in one transaction. A preview is the apply itself inside a
// savepoint that is rolled back (nothing is written, no notification or job survives), so a course of a program that is only in the file
// previews exactly as it will apply.
import { sql } from 'drizzle-orm';
import { UpsertAcademicSchema, type AcademicExport, type AcademicWorkbook, type UpsertAcademic, type UpsertAcademicResult, type UpsertAcademicRow } from '@ams/shared';
import { assertPermitted } from '../permissions.js';
import { type Ctx } from '../ctx.js';
import { exportCatalog, upsertCatalog } from '../catalog/catalog-sheets.js';
import { exportPrograms, upsertPrograms } from '../org/programs-sheets.js';
import { exportCourses, upsertCourses } from './courses-sheets.js';

const PROGRAM_KEYS = ['programs', 'peos', 'plos'] as const;
const CATALOG_KEYS = ['concentrations', 'blocks', 'genedAreas', 'catalog', 'slots'] as const;
const COURSE_KEYS = ['courses', 'studyPlan', 'clos', 'outline', 'materials', 'assessments', 'rubrics', 'sections'] as const;

/** Everything of the workbook in one read: the rows of both parts and the lists for the dropdowns. */
export async function exportAcademic(ctx: Ctx): Promise<AcademicExport> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const [p, c, k] = [await exportPrograms(ctx), await exportCourses(ctx), await exportCatalog(ctx)];
  return { programs: p.programs, peos: p.peos, plos: p.plos, concentrations: k.concentrations, blocks: k.blocks, genedAreas: k.genedAreas, catalog: k.catalog, slots: k.slots, courses: c.courses, studyPlan: c.studyPlan, clos: c.clos, outline: c.outline, materials: c.materials, assessments: c.assessments, rubrics: c.rubrics, sections: c.sections, lists: { ...c.lists, units: p.lists.units, programLanguages: p.lists.languages, ilos: p.lists.ilos, areas: k.lists.areas, concentrations: k.lists.concentrations } };
}

const pick = <K extends string>(wb: AcademicWorkbook, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, (wb as unknown as Record<string, unknown>)[k] ?? []])) as never;

async function run(ctx: Ctx, wb: AcademicWorkbook, apply: boolean): Promise<UpsertAcademicResult> {
  const hasPrograms = PROGRAM_KEYS.some((k) => wb[k].length);
  const hasCourses = COURSE_KEYS.some((k) => wb[k].length);
  const hasCatalog = CATALOG_KEYS.some((k) => wb[k].length);
  // The order: programs and outcomes; the structure the study plan names (settings, areas, concentrations, block credits); courses, study plan
  // and content; then what needs the courses (the areas' pools, elective slots).
  const programs = hasPrograms ? await upsertPrograms(ctx, { workbook: pick(wb, PROGRAM_KEYS), apply }) : null;
  const structure = hasCatalog ? await upsertCatalog(ctx, pick(wb, CATALOG_KEYS), 'structure') : [];
  const courses = hasCourses ? await upsertCourses(ctx, { workbook: pick(wb, COURSE_KEYS), apply }) : null;
  const late = hasCatalog ? await upsertCatalog(ctx, pick(wb, CATALOG_KEYS), 'late') : [];
  const catalog = [...structure, ...late];
  const count = (a: string) => catalog.filter((r) => r.action === a).length;
  const rows: UpsertAcademicRow[] = [...(programs?.rows ?? []), ...structure, ...(courses?.rows ?? []), ...late];
  return {
    applied: apply,
    added: (programs?.added ?? 0) + (courses?.added ?? 0) + count('add'), updated: (programs?.updated ?? 0) + (courses?.updated ?? 0) + count('update'), drafted: courses?.drafted ?? 0,
    unchanged: (programs?.unchanged ?? 0) + (courses?.unchanged ?? 0) + count('unchanged'), skipped: (programs?.skipped ?? 0) + (courses?.skipped ?? 0) + count('skip'), rows,
  };
}

/** Adds and updates programs and courses from one workbook; with `apply` false, says what would happen and writes nothing. */
export async function upsertAcademic(ctx: Ctx, input: UpsertAcademic): Promise<UpsertAcademicResult> {
  const { workbook, apply } = UpsertAcademicSchema.parse(input);
  if (apply) return run(ctx, workbook, true);
  // A preview needs the writes to resolve what the file adds itself, so it makes them and takes them back.
  const quiet: Ctx = { ...ctx, afterCommit: () => undefined };
  await ctx.tx.execute(sql`savepoint academic_preview`);
  try {
    return { ...(await run(quiet, workbook, true)), applied: false };
  } finally {
    await ctx.tx.execute(sql`rollback to savepoint academic_preview`);
    await ctx.tx.execute(sql`release savepoint academic_preview`);
  }
}
