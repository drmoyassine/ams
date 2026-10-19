// Scope levels (TASK-086): the short list of levels a standard's scope can be at. Every institution starts with Institution, Unit,
// Program and Course (the database seeds them; Course is a placeholder until course records exist, so its list is empty). The
// "Scope levels" section of Settings -> Organization -> Institution adds a custom level, renames, reorders and deactivates. A
// level is never deleted: a scope that names it keeps its meaning. Same shape as the unit types.
import { asc, eq, sql } from 'drizzle-orm';
import { scopeLevel } from '@ams/db';
import type { CreateScopeLevel, ReorderScopeLevels, ScopeItems, ScopeLevel, UpdateScopeLevel } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { reportUndo } from '../trash/store.js';

type Row = typeof scopeLevel.$inferSelect;
const nfc = (s: string) => s.normalize('NFC').trim();
const any = { type: 'any' } as const;

/** Levels are shared by every unit, so they are changed by whoever may write the organization at the institution level. */
const assertMayChange = (ctx: Ctx) => assertPermitted(ctx, 'org:write', { type: 'institution' });

async function rows(ctx: Ctx): Promise<Row[]> {
  return ctx.tx.select().from(scopeLevel).orderBy(asc(scopeLevel.displayOrder), asc(scopeLevel.labelEn), asc(scopeLevel.id));
}

async function itemCounts(ctx: Ctx): Promise<{ org_unit: number; program: number }> {
  const res = await ctx.tx.execute<{ u: number; p: number }>(sql`select (select count(*) from org_unit where active)::int as u, (select count(*) from program where active)::int as p`);
  return { org_unit: res.rows[0]?.u ?? 0, program: res.rows[0]?.p ?? 0 };
}

const dto = (r: Row, n: { org_unit: number; program: number }): ScopeLevel => ({
  id: r.id, key: r.key, labelEn: r.labelEn, labelAr: r.labelAr, kind: r.kind, displayOrder: r.displayOrder, active: r.active,
  itemCount: r.kind === 'org_unit' ? n.org_unit : r.kind === 'program' ? n.program : 0,
});

/** The institution's scope levels in order, active or not (the manager shows both; the pickers use the active ones). */
export async function listScopeLevels(ctx: Ctx): Promise<ScopeLevel[]> {
  await assertPermitted(ctx, 'org:read', any);
  const n = await itemCounts(ctx);
  return (await rows(ctx)).map((r) => dto(r, n));
}

/** What a scope can list: the active units and programs (a program is shown with its unit). */
export async function listScopeItems(ctx: Ctx): Promise<ScopeItems> {
  await assertPermitted(ctx, 'org:read', any);
  const units = await ctx.tx.execute<{ id: string; name_en: string; name_ar: string | null; type: string }>(sql`select id, name_en, name_ar, type from org_unit where active order by lower(name_en), id`);
  const progs = await ctx.tx.execute<{ id: string; name_en: string; name_ar: string | null; unit: string }>(sql`
    select p.id, p.name_en, p.name_ar, u.name_en as unit from program p join org_unit u on u.id = p.org_unit_id where p.active order by lower(p.name_en), p.id`);
  return {
    orgUnit: units.rows.map((u) => ({ id: u.id, nameEn: u.name_en, nameAr: u.name_ar, detail: null })),
    program: progs.rows.map((p) => ({ id: p.id, nameEn: p.name_en, nameAr: p.name_ar, detail: p.unit })),
  };
}

async function load(ctx: Ctx, id: string): Promise<Row> {
  const [row] = await ctx.tx.select().from(scopeLevel).where(eq(scopeLevel.id, id));
  if (!row) throw new NotFoundError(`scope level ${id}`);
  return row;
}

async function renumber(ctx: Ctx, ordered: Row[]): Promise<void> {
  for (const [i, r] of ordered.entries()) if (r.displayOrder !== i) await ctx.tx.update(scopeLevel).set({ displayOrder: i }).where(eq(scopeLevel.id, r.id));
}

function keyFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base = label.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9_]+/, '').slice(0, 40) || 'level';
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  return key;
}

/** Adds a custom level at the end. A custom level has no list of items (a scope at it is simply "all"). */
export async function createScopeLevel(ctx: Ctx, input: CreateScopeLevel): Promise<ScopeLevel> {
  assertHuman(ctx);
  await assertMayChange(ctx);
  const all = await rows(ctx);
  const labelEn = nfc(input.labelEn);
  if (all.some((l) => l.labelEn.toLowerCase() === labelEn.toLowerCase())) throw new ConflictError(`There is already a scope level called ${labelEn}.`);
  const taken = new Set(all.map((l) => l.key));
  if (input.key && taken.has(input.key)) throw new ConflictError(`There is already a scope level with the key ${input.key}.`);
  const key = input.key ?? keyFromLabel(labelEn, taken);
  const [row] = await guardIntegrity(() => ctx.tx.insert(scopeLevel).values({
    institutionId: ctx.caller.institutionId, key, labelEn, labelAr: input.labelAr ? nfc(input.labelAr) : null, kind: 'custom', displayOrder: all.length,
  }).returning());
  // Undo deactivates it (a level is never deleted); the level stays but leaves the pickers.
  reportUndo(ctx, { label: `Added the scope level ${labelEn}`, method: 'PATCH', path: `/api/scope-levels/${row!.id}`, body: { active: false } });
  return dto(row!, await itemCounts(ctx));
}

/** Rename (English and Arabic) or deactivate/reactivate. The last active level cannot be deactivated. */
export async function updateScopeLevel(ctx: Ctx, id: string, patch: UpdateScopeLevel): Promise<ScopeLevel> {
  assertHuman(ctx);
  await assertMayChange(ctx);
  const cur = await load(ctx, id);
  const set: Partial<typeof scopeLevel.$inferInsert> = {};
  if (patch.labelEn !== undefined && nfc(patch.labelEn) !== cur.labelEn) {
    const labelEn = nfc(patch.labelEn);
    if ((await rows(ctx)).some((l) => l.id !== id && l.labelEn.toLowerCase() === labelEn.toLowerCase())) throw new ConflictError(`There is already a scope level called ${labelEn}.`);
    set.labelEn = labelEn;
  }
  if (patch.labelAr !== undefined) {
    const labelAr = patch.labelAr ? nfc(patch.labelAr) : null;
    if (labelAr !== cur.labelAr) set.labelAr = labelAr;
  }
  if (patch.active !== undefined && patch.active !== cur.active) {
    if (!patch.active && (await rows(ctx)).filter((l) => l.active && l.id !== id).length === 0) throw new ConflictError('At least one scope level has to stay active, so the last one cannot be deactivated.');
    set.active = patch.active;
  }
  const n = await itemCounts(ctx);
  if (Object.keys(set).length === 0) return dto(cur, n);
  const [row] = await ctx.tx.update(scopeLevel).set(set).where(eq(scopeLevel.id, id)).returning();
  reportUndo(ctx, {
    label: set.active !== undefined ? `${set.active ? 'Reactivated' : 'Deactivated'} the scope level ${cur.labelEn}` : `Renamed the scope level ${cur.labelEn}`,
    method: 'PATCH', path: `/api/scope-levels/${id}`,
    body: { ...(set.labelEn !== undefined ? { labelEn: cur.labelEn } : {}), ...(set.labelAr !== undefined ? { labelAr: cur.labelAr } : {}), ...(set.active !== undefined ? { active: cur.active } : {}) },
  });
  return dto(row!, n);
}

/** `ids` is the whole list in the new order. */
export async function reorderScopeLevels(ctx: Ctx, input: ReorderScopeLevels): Promise<ScopeLevel[]> {
  assertHuman(ctx);
  await assertMayChange(ctx);
  const all = await rows(ctx);
  const byId = new Map(all.map((l) => [l.id, l] as const));
  if (input.ids.length !== all.length || new Set(input.ids).size !== all.length || input.ids.some((i) => !byId.has(i))) throw new ValidationError('give every scope level exactly once');
  const ordered = input.ids.map((i) => byId.get(i)!);
  if (all.some((l, i) => l.id !== ordered[i]!.id || l.displayOrder !== i)) {
    await renumber(ctx, ordered);
    reportUndo(ctx, { label: 'Reordered the scope levels', method: 'POST', path: '/api/scope-levels/reorder', body: { ids: all.map((l) => l.id) } });
  }
  const n = await itemCounts(ctx);
  return ordered.map((l, i) => dto({ ...l, displayOrder: i }, n));
}
