// The academic calendar (TASK-081): the institution's years and terms ("AY2026-27", "Fall 2026") that "every term" and "every year"
// recur against. Settings -> Organization -> Institution -> Academic calendar: add, edit, delete, reorder; dates and English and
// Arabic names. Active terms of a kind never overlap (the database insists). Same shape as the scope levels.
import { asc, eq } from 'drizzle-orm';
import { academicTerm } from '@ams/db';
import type { AcademicTerm, CreateAcademicTerm, ReorderAcademicTerms, UpdateAcademicTerm } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { reportUndo } from '../trash/store.js';
import { nfc, nfcOrNull } from './common.js';
import type { CalendarEntry } from './recurrence.js';

type Row = typeof academicTerm.$inferSelect;
const any = { type: 'any' } as const;
/** The calendar is shared by everyone, so it is changed by whoever may write the organization at the institution level. */
const assertMayChange = (ctx: Ctx) => assertPermitted(ctx, 'org:write', { type: 'institution' });

const dto = (r: Row): AcademicTerm => ({ id: r.id, name: r.name, nameAr: r.nameAr, kind: r.kind, startDate: r.startDate, endDate: r.endDate, active: r.active, displayOrder: r.displayOrder });
const rows = (ctx: Ctx) => ctx.tx.select().from(academicTerm).orderBy(asc(academicTerm.displayOrder), asc(academicTerm.startDate), asc(academicTerm.id));

/** Years and terms in the order the person arranged them (new ones go to the end). */
export async function listAcademicTerms(ctx: Ctx): Promise<AcademicTerm[]> {
  await assertPermitted(ctx, 'org:read', any);
  return (await rows(ctx)).map(dto);
}

/** The active entries as the recurrence engine reads them. Reads need only that the caller may see cycles. */
export async function calendarEntries(ctx: Ctx): Promise<CalendarEntry[]> {
  return (await ctx.tx.select().from(academicTerm).where(eq(academicTerm.active, true))).map((r) => ({ name: r.name, kind: r.kind, start: r.startDate, end: r.endDate }));
}

async function load(ctx: Ctx, id: string): Promise<Row> {
  const [row] = await ctx.tx.select().from(academicTerm).where(eq(academicTerm.id, id));
  if (!row) throw new NotFoundError(`academic term ${id}`);
  return row;
}

export async function createAcademicTerm(ctx: Ctx, input: CreateAcademicTerm): Promise<AcademicTerm> {
  assertHuman(ctx);
  await assertMayChange(ctx);
  if (input.endDate < input.startDate) throw new ValidationError('The end date cannot be before the start date.');
  const all = await rows(ctx);
  const name = nfc(input.name);
  if (all.some((t) => t.kind === input.kind && t.name.toLowerCase() === name.toLowerCase())) throw new ValidationError(`There is already a ${input.kind} called ${name}.`);
  const [row] = await guardIntegrity(() => ctx.tx.insert(academicTerm).values({
    institutionId: ctx.caller.institutionId, name, nameAr: nfcOrNull(input.nameAr), kind: input.kind, startDate: input.startDate, endDate: input.endDate, displayOrder: all.length,
  }).returning());
  reportUndo(ctx, { label: `Added ${name} to the academic calendar`, method: 'DELETE', path: `/api/academic-terms/${row!.id}` });
  return dto(row!);
}

export async function updateAcademicTerm(ctx: Ctx, id: string, patch: UpdateAcademicTerm): Promise<AcademicTerm> {
  assertHuman(ctx);
  await assertMayChange(ctx);
  const cur = await load(ctx, id);
  const set: Partial<typeof academicTerm.$inferInsert> = {};
  const before: Record<string, unknown> = {};
  if (patch.name !== undefined && nfc(patch.name) !== cur.name) {
    const name = nfc(patch.name);
    if ((await rows(ctx)).some((t) => t.id !== id && t.kind === cur.kind && t.name.toLowerCase() === name.toLowerCase())) throw new ValidationError(`There is already a ${cur.kind} called ${name}.`);
    set.name = name; before.name = cur.name;
  }
  if (patch.nameAr !== undefined && nfcOrNull(patch.nameAr) !== cur.nameAr) { set.nameAr = nfcOrNull(patch.nameAr); before.nameAr = cur.nameAr; }
  if (patch.startDate !== undefined && patch.startDate !== cur.startDate) { set.startDate = patch.startDate; before.startDate = cur.startDate; }
  if (patch.endDate !== undefined && patch.endDate !== cur.endDate) { set.endDate = patch.endDate; before.endDate = cur.endDate; }
  if (patch.active !== undefined && patch.active !== cur.active) { set.active = patch.active; before.active = cur.active; }
  if (Object.keys(set).length === 0) return dto(cur);
  if ((set.endDate ?? cur.endDate) < (set.startDate ?? cur.startDate)) throw new ValidationError('The end date cannot be before the start date.');
  const [row] = await guardIntegrity(() => ctx.tx.update(academicTerm).set(set).where(eq(academicTerm.id, id)).returning());
  reportUndo(ctx, { label: `Changed ${cur.name} in the academic calendar`, method: 'PATCH', path: `/api/academic-terms/${id}`, body: before });
  return dto(row!);
}

/** Deleting a term is allowed: runs already made keep the label they were given. Undo puts it back. */
export async function deleteAcademicTerm(ctx: Ctx, id: string): Promise<void> {
  assertHuman(ctx);
  await assertMayChange(ctx);
  const cur = await load(ctx, id);
  await ctx.tx.delete(academicTerm).where(eq(academicTerm.id, id));
  reportUndo(ctx, {
    label: `Removed ${cur.name} from the academic calendar`, method: 'POST', path: '/api/academic-terms',
    body: { name: cur.name, ...(cur.nameAr ? { nameAr: cur.nameAr } : {}), kind: cur.kind, startDate: cur.startDate, endDate: cur.endDate },
  });
}

/** `ids` is the whole list in the new order. */
export async function reorderAcademicTerms(ctx: Ctx, input: ReorderAcademicTerms): Promise<AcademicTerm[]> {
  assertHuman(ctx);
  await assertMayChange(ctx);
  const all = await rows(ctx);
  const byId = new Map(all.map((t) => [t.id, t] as const));
  if (input.ids.length !== all.length || new Set(input.ids).size !== all.length || input.ids.some((i) => !byId.has(i))) throw new ValidationError('give every year and term exactly once');
  const ordered = input.ids.map((i) => byId.get(i)!);
  if (all.some((t, i) => t.id !== ordered[i]!.id)) {
    for (const [i, t] of ordered.entries()) if (t.displayOrder !== i) await ctx.tx.update(academicTerm).set({ displayOrder: i }).where(eq(academicTerm.id, t.id));
    reportUndo(ctx, { label: 'Reordered the academic calendar', method: 'POST', path: '/api/academic-terms/reorder', body: { ids: all.map((t) => t.id) } });
  }
  return ordered.map((t, i) => dto({ ...t, displayOrder: i }));
}
