// The org chart from a picture or a PDF page (TASK-073, section E.2 of docs/organization-plan.md, DEC-028). The import target for
// the `org_chart` scope: the reading (vision) model writes the chart down as an outline (ocr v2), the AI proposes one unit per
// box with its parent and head, a person reviews them beside the image, and Apply adds the accepted ones through createOrgUnit
// (source 'image') as that person, in one transaction. A unit already there (same name, Arabic folded) is never duplicated; one a
// person edited, or locked, is never changed or moved: it is skipped with the reason. Undo moves what was added to the Trash
// (and puts back what was moved); Redo restores it.
import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { orgUnit } from '@ams/db';
import type { OrgUnit, PlacementRun } from '@ams/shared';
import { ConflictError, ForbiddenError, ValidationError, type Ctx } from '../ctx.js';
import { normalizeQuoteText } from '../framework/quote-match.js';
import { registerImportTarget, type ApplyItem, type ApplyOutcome, type ImportTarget } from '../documents/targets.js';
import { restoreTrash } from '../trash/trash.js';
import { listOrgUnitTypes } from './unit-types.js';
import { createOrgUnit, listOrgUnits } from './units.js';
import { moveOrgUnits } from './unit-move.js';
import { deleteOrgUnits } from './unit-trash.js';

const opt = <T extends z.ZodType>(t: T) => t.nullish().default(null);

export const OrgChartImportItemSchema = z.object({
  nameEn: z.string().trim().min(1),
  nameAr: opt(z.string().trim()),
  /** A unit type key; the apply uses the institution's type with this key, or 'other'. */
  type: opt(z.string().trim()),
  /** The name of the box this one hangs from, as the same chart names it; empty for a box at the top. */
  parentName: opt(z.string().trim()),
  headName: opt(z.string().trim()),
  /** The box's own line of the outline the vision model read: what the AI cites. */
  boxText: opt(z.string().trim()),
});
export type OrgChartImportItem = z.infer<typeof OrgChartImportItemSchema>;

export const ORG_CHART_TARGET_KIND = 'org_chart';

const fold = (s: string | null | undefined) => (s ? normalizeQuoteText(s) : '');
const nfc = (s: string | null | undefined) => (s ? s.normalize('NFC').trim() || null : null);

interface CreatedUnit { id: string; parentId: string | null; nameEn: string }
interface MovedUnit { id: string; name: string; from: string | null; to: string; back: PlacementRun }
interface Inverse { created: CreatedUnit[]; moved: MovedUnit[]; state: 'applied' | 'undone'; groupId?: string }

/** Runs `fn`; when it throws, the work of `fn` is rolled back and the error returned instead (the apply goes on without that item). */
async function attempt<T>(ctx: Ctx, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  await ctx.tx.execute(sql`savepoint org_chart_item`);
  try {
    const value = await fn();
    await ctx.tx.execute(sql`release savepoint org_chart_item`);
    return { ok: true, value };
  } catch (e) {
    await ctx.tx.execute(sql`rollback to savepoint org_chart_item`);
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

export const orgChartTarget: ImportTarget<OrgChartImportItem> = {
  kind: ORG_CHART_TARGET_KIND, label: 'Org chart', itemsLabel: 'units', scopeKinds: ['org_chart'], aiRole: 'analysis',
  description: 'Reads a picture or PDF of an org chart: the boxes with their names in English and Arabic, which box each hangs from, its type and its head when shown. The image and the names on it go to the AI reading model.',
  schema: OrgChartImportItemSchema,
  promptTask: 'import_org_chart', promptVersion: 'v1',
  buildPrompt: (w) => [
    'Find the boxes of this organization chart. The pages are the reading model\'s outline of the chart: one line per box, indented under the box it hangs from.',
    `Document: ${w.documentName}. Language: ${w.language}. This window: pages ${w.firstPage} to ${w.lastPage}.`,
    '', w.pages,
  ].join('\n'),
  validate(item) {
    const why: string[] = [];
    if (!item.boxText) why.push('The box text was not cited; check this unit against the picture.');
    if (!item.parentName) why.push('No parent box was found: it would be added at the top level.');
    if (item.boxText && /\[parent unclear\]/i.test(item.boxText)) why.push('The AI could not tell which box this hangs from.');
    if (item.boxText && /\[illegible\]/i.test(item.boxText)) why.push('Part of this box could not be read.');
    return why;
  },
  proposalLabel: (item) => item.nameEn,
  // The same name under the same parent in two windows is one unit.
  dedupeKey: (item) => `${fold(item.nameEn)}|${fold(item.parentName)}`,

  async apply(ctx, items) {
    const all = await listOrgUnits(ctx);
    const byName = new Map<string, OrgUnit[]>();
    const index = (u: OrgUnit) => { for (const n of [u.nameEn, u.nameAr]) if (n) byName.set(fold(n), [...(byName.get(fold(n)) ?? []), u]); };
    all.filter((u) => u.active).forEach(index);
    const types = (await listOrgUnitTypes(ctx)).map((t) => t.key);
    const typeFor = (key: string | null | undefined): string => {
      const k = key?.trim().toLowerCase().replace(/[\s-]+/g, '_') ?? '';
      if (k && types.includes(k)) return k;
      if (types.includes('other')) return 'other';
      if (types[0]) return types[0];
      throw new ConflictError('The institution has no unit types; add one under Unit types first.');
    };

    const outcomes = new Map<string, ApplyOutcome>();
    const created: CreatedUnit[] = [];
    const moved: MovedUnit[] = [];
    /** Units this apply made or matched: a second box of the same name is the same unit shown twice. */
    const handled = new Set<string>();
    const skip = (it: ApplyItem<OrgChartImportItem>, reason: string) => { outcomes.set(it.proposalId, { proposalId: it.proposalId, status: 'skipped', reason }); };
    const done = (it: ApplyItem<OrgChartImportItem>, ref: Record<string, unknown>) => { outcomes.set(it.proposalId, { proposalId: it.proposalId, status: 'applied', ref }); };

    const nameKeys = (p: OrgChartImportItem) => [fold(p.nameEn), ...(p.nameAr ? [fold(p.nameAr)] : [])];
    const queue = items.filter((it) => {
      if (!it.item.nameEn.trim()) { skip(it, 'no name; give it one in the review and apply again'); return false; }
      return true;
    });
    const waiting = new Set(queue.flatMap((it) => nameKeys(it.item)));

    /** The unit a parent name means: one already in the chart (or made by this apply), or "later" while an accepted unit of that name is still to come. */
    const parentOf = (name: string): { unit: OrgUnit } | 'later' | 'none' => {
      const found = byName.get(fold(name));
      if (found?.length) return { unit: found[found.length - 1]! };
      return waiting.has(fold(name)) ? 'later' : 'none';
    };

    let progressed = true;
    while (queue.length && progressed) {
      progressed = false;
      for (let i = 0; i < queue.length; i++) {
        const it = queue[i]!;
        const p = it.item;
        let parentId: string | null = null;
        let parentUnit: OrgUnit | null = null;
        if (p.parentName) {
          const r = parentOf(p.parentName);
          if (r === 'later') continue;
          if (r === 'none') { queue.splice(i--, 1); progressed = true; skip(it, `its parent "${p.parentName}" is not in the org chart and is not among the accepted units`); continue; }
          parentUnit = r.unit; parentId = r.unit.id;
        }
        queue.splice(i--, 1);
        progressed = true;

        const matches = nameKeys(p).flatMap((k) => byName.get(k) ?? []);
        const same = matches.filter((u, j) => matches.indexOf(u) === j);
        const existing = same.find((u) => (u.parentId ?? null) === parentId) ?? same[0];
        if (existing) {
          if (handled.has(existing.id)) { skip(it, 'the same unit appears twice in this import'); continue; }
          handled.add(existing.id);
          if (existing.locked) { skip(it, `"${existing.nameEn}" is already in the org chart and is locked; left alone`); continue; }
          if (existing.editedByPerson) { skip(it, `"${existing.nameEn}" is already in the org chart and a person edited it; left alone`); continue; }
          if (!parentUnit || (existing.parentId ?? null) === parentId) { skip(it, `"${existing.nameEn}" is already in the org chart${parentUnit ? ' in the right place' : ''}`); continue; }
          // An existing unit nobody edited or locked, under another parent than the picture shows: it moves (and Undo moves it back).
          const row = await moveOne(ctx, existing, parentId!);
          if (!row.ok) { skip(it, row.reason); continue; }
          moved.push(row.moved);
          done(it, { unitId: existing.id, moved: true });
          continue;
        }
        const made = await attempt(ctx, () => createOrgUnit(ctx, {
          parentId, type: typeFor(p.type), nameEn: p.nameEn.normalize('NFC').trim(), ...(nfc(p.nameAr) ? { nameAr: nfc(p.nameAr)! } : {}),
          ...(nfc(p.headName) ? { headName: nfc(p.headName)! } : {}), source: 'image',
        }));
        if (!made.ok) {
          if (made.error instanceof ForbiddenError) { skip(it, `you may not add units${parentUnit ? ` under "${parentUnit.nameEn}"` : ' at the top level'}`); continue; }
          if (made.error instanceof ConflictError || made.error instanceof ValidationError) { skip(it, made.error.message); continue; }
          throw made.error;
        }
        const unit = made.value;
        index(unit); handled.add(unit.id);
        created.push({ id: unit.id, parentId: unit.parentId, nameEn: unit.nameEn });
        done(it, { unitId: unit.id, parentId: unit.parentId, type: unit.type });
      }
    }
    for (const it of queue) skip(it, 'its place in the chart could not be worked out (its parents refer to each other); fix the parent in the review');

    const inverse: Inverse = { created, moved, state: 'applied' };
    return { outcomes: items.map((it) => outcomes.get(it.proposalId)!), inverse };
  },

  /** Undo takes the moves back and puts what was added in the Trash; Redo restores it and moves again. A change by a person since refuses. */
  async reverse(ctx, raw) {
    const inv = raw as Inverse;
    if (inv.state === 'applied') {
      const ids = inv.created.map((c) => c.id);
      // Moves first: the units that went under a unit this apply made leave it before it goes.
      for (const m of [...inv.moved].reverse()) {
        const [row] = await ctx.tx.select().from(orgUnit).where(inArray(orgUnit.id, [m.id]));
        if (!row || (row.parentId ?? null) !== m.to) throw new ConflictError(`"${m.name}" was moved or removed since.`);
        await moveOrgUnits(ctx, { placements: [m.back] });
      }
      if (!ids.length) return { ...inv, state: 'undone' } satisfies Inverse;
      const rows = await ctx.tx.select().from(orgUnit).where(inArray(orgUnit.id, ids));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const c of inv.created) {
        const r = byId.get(c.id);
        if (!r || (r.parentId ?? null) !== c.parentId || r.nameEn !== c.nameEn) throw new ConflictError(`the unit "${c.nameEn}" was changed or removed since.`);
      }
      const under = await ctx.tx.select({ id: orgUnit.id, name: orgUnit.nameEn }).from(orgUnit).where(inArray(orgUnit.parentId, ids));
      const foreign = under.find((u) => !ids.includes(u.id));
      if (foreign) throw new ConflictError(`"${foreign.name}" was added under a unit this import made.`);
      const res = await deleteOrgUnits(ctx, { ids });
      return { ...inv, state: 'undone', groupId: res.groupId } satisfies Inverse;
    }
    if (inv.groupId) await restoreTrash(ctx, { groupId: inv.groupId });
    for (const m of inv.moved) {
      const [row] = await ctx.tx.select().from(orgUnit).where(inArray(orgUnit.id, [m.id]));
      if (!row || (row.parentId ?? null) !== m.from) throw new ConflictError(`"${m.name}" was moved or removed since.`);
      const siblings = await ctx.tx.select({ id: orgUnit.id }).from(orgUnit).where(sql`${orgUnit.parentId} = ${m.to}::uuid and ${orgUnit.id} <> ${m.id}::uuid`);
      await moveOrgUnits(ctx, { moves: [{ id: m.id, parentId: m.to, index: siblings.length }] });
    }
    return { created: inv.created, moved: inv.moved, state: 'applied' } satisfies Inverse;
  },
};

/** Moves one unit to the end of a new parent's list, remembering where it sat (the sibling before it) so Undo can put it back. */
async function moveOne(ctx: Ctx, unit: OrgUnit, toParentId: string): Promise<{ ok: true; moved: MovedUnit } | { ok: false; reason: string }> {
  const now = await listOrgUnits(ctx);
  const sibs = now.filter((u) => (u.parentId ?? null) === (unit.parentId ?? null));
  const at = sibs.findIndex((u) => u.id === unit.id);
  const back: PlacementRun = { parentId: unit.parentId ?? null, afterId: at > 0 ? sibs[at - 1]!.id : null, ids: [unit.id] };
  const dest = now.filter((u) => u.parentId === toParentId && u.id !== unit.id);
  const r = await attempt(ctx, () => moveOrgUnits(ctx, { moves: [{ id: unit.id, parentId: toParentId, index: dest.length }] }));
  if (!r.ok) {
    if (r.error instanceof ForbiddenError || r.error instanceof ConflictError || r.error instanceof ValidationError) return { ok: false, reason: `"${unit.nameEn}" could not be moved: ${r.error.message}` };
    throw r.error;
  }
  return { ok: true, moved: { id: unit.id, name: unit.nameEn, from: unit.parentId ?? null, to: toParentId, back } };
}

registerImportTarget(orgChartTarget);
