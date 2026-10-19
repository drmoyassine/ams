// Cycle templates (Settings -> Quality Management): draft -> published -> retired. Publishing checks the stages in full, bumps the
// version and offers the template for launching; a running cycle keeps the version it started from (and a copy of its stages).
// Everything accreditor-specific is data in `stages`, never code (DEC-002).
import { and, asc, eq, sql } from 'drizzle-orm';
import { cycle, cycleTemplate } from '@ams/db';
import {
  TemplateStagesSchema, validateTemplateStages, type CreateCycleTemplate, type CycleAnchorKind, type CycleTemplate, type StageDef, type TemplateValidation,
  type UpdateCycleTemplate, type CycleTemplateStatus,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { reportUndo } from '../trash/store.js';
import { nfc, nfcOrNull } from './common.js';

type TemplateRow = typeof cycleTemplate.$inferSelect;

const toDto = (r: TemplateRow, cycleCount: number): CycleTemplate => ({
  id: r.id, key: r.key, name: r.name, nameAr: r.nameAr, description: r.description, anchorKinds: r.anchorKinds as CycleAnchorKind[],
  stages: TemplateStagesSchema.parse(r.stages), version: r.version, status: r.status, origin: r.origin, cycleCount, updatedAt: r.updatedAt.toISOString(),
});

/** Templates are institution-wide settings: managed with cycle:manage held for the whole institution. */
const assertManageTemplates = (ctx: Ctx) => assertPermitted(ctx, 'cycle:manage', { type: 'institution' });

async function loadRow(ctx: Ctx, id: string): Promise<TemplateRow> {
  const [row] = await ctx.tx.select().from(cycleTemplate).where(eq(cycleTemplate.id, id));
  if (!row) throw new NotFoundError(`cycle template ${id}`);
  return row;
}
async function countOf(ctx: Ctx, id: string): Promise<number> {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(cycle).where(eq(cycle.templateId, id));
  return r?.n ?? 0;
}

/** Normalises the text of stage definitions (NFC, trimmed) so Arabic compares and sorts the same everywhere. */
function normalise(stages: StageDef[]): StageDef[] {
  return stages.map((s) => ({
    ...s, name: nfc(s.name), ...(s.nameAr ? { nameAr: nfc(s.nameAr) } : {}), process: s.process.normalize('NFC'), checklist: s.checklist.map(nfc),
    outputs: s.outputs.map((o) => ({ ...o, name: nfc(o.name), ...(o.nameAr ? { nameAr: nfc(o.nameAr) } : {}) })),
    inputs: s.inputs.map((i) => ({ ...i, name: nfc(i.name), ...(i.nameAr ? { nameAr: nfc(i.nameAr) } : {}) })),
  }));
}

/** Every problem with these stages (shape is the Zod schema's; this adds the rules between stages), for the editor. */
export async function validateTemplate(ctx: Ctx, input: { stages: unknown }): Promise<TemplateValidation> {
  await assertPermitted(ctx, 'cycle:read', { type: 'any' });
  const parsed = TemplateStagesSchema.safeParse(input.stages);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ path: `stages.${i.path.join('.')}`, message: i.message })) };
  const issues = validateTemplateStages(parsed.data);
  return { ok: issues.length === 0, issues };
}

export async function listTemplates(ctx: Ctx, filter: { status?: CycleTemplateStatus; anchorKind?: CycleAnchorKind } = {}): Promise<CycleTemplate[]> {
  await assertPermitted(ctx, 'cycle:read', { type: 'any' });
  const rows = await ctx.tx.select().from(cycleTemplate).where(filter.status ? eq(cycleTemplate.status, filter.status) : undefined).orderBy(asc(cycleTemplate.name), asc(cycleTemplate.id));
  const counts = await ctx.tx.select({ id: cycle.templateId, n: sql<number>`count(*)::int` }).from(cycle).groupBy(cycle.templateId);
  const by = new Map(counts.map((c) => [c.id, c.n] as const));
  return rows
    .filter((r) => !filter.anchorKind || r.anchorKinds.length === 0 || r.anchorKinds.includes(filter.anchorKind))
    .map((r) => toDto(r, by.get(r.id) ?? 0));
}

export async function getTemplate(ctx: Ctx, id: string): Promise<CycleTemplate> {
  await assertPermitted(ctx, 'cycle:read', { type: 'any' });
  return toDto(await loadRow(ctx, id), await countOf(ctx, id));
}

/** A new template is a draft. Saving checks the shape only (a draft may be unfinished); publishing checks everything. */
export async function createTemplate(ctx: Ctx, input: CreateCycleTemplate): Promise<CycleTemplate> {
  assertHuman(ctx);
  await assertManageTemplates(ctx);
  const stages = normalise(TemplateStagesSchema.parse(input.stages));
  const [row] = await guardIntegrity(() => ctx.tx.insert(cycleTemplate).values({
    institutionId: ctx.caller.institutionId, key: input.key, name: nfc(input.name), nameAr: nfcOrNull(input.nameAr), description: nfcOrNull(input.description),
    anchorKinds: [...new Set(input.anchorKinds)], stages, origin: input.origin, version: 0, status: 'draft',
  }).returning());
  reportUndo(ctx, { label: `Created the template ${row!.name}`, method: 'DELETE', path: `/api/cycle-templates/${row!.id}` });
  return toDto(row!, 0);
}

/** Edits a draft template. A published or retired one is revised into a draft first. Undo puts the earlier values back. */
export async function updateTemplate(ctx: Ctx, id: string, patch: UpdateCycleTemplate): Promise<CycleTemplate> {
  assertHuman(ctx);
  await assertManageTemplates(ctx);
  const row = await loadRow(ctx, id);
  if (row.status !== 'draft') throw new ConflictError(`The template is ${row.status}. Revise it into a draft before editing.`);
  const set: Partial<typeof cycleTemplate.$inferInsert> = {};
  const before: Record<string, unknown> = {};
  if (patch.name !== undefined && nfc(patch.name) !== row.name) { set.name = nfc(patch.name); before.name = row.name; }
  if (patch.nameAr !== undefined && nfcOrNull(patch.nameAr) !== row.nameAr) { set.nameAr = nfcOrNull(patch.nameAr); before.nameAr = row.nameAr; }
  if (patch.description !== undefined && nfcOrNull(patch.description) !== row.description) { set.description = nfcOrNull(patch.description); before.description = row.description; }
  if (patch.anchorKinds !== undefined) { set.anchorKinds = [...new Set(patch.anchorKinds)]; before.anchorKinds = row.anchorKinds; }
  if (patch.stages !== undefined) { set.stages = normalise(TemplateStagesSchema.parse(patch.stages)); before.stages = row.stages; }
  if (Object.keys(set).length) {
    await guardIntegrity(() => ctx.tx.update(cycleTemplate).set(set).where(eq(cycleTemplate.id, id)));
    reportUndo(ctx, { label: `Edited the template ${row.name}`, method: 'PATCH', path: `/api/cycle-templates/${id}`, body: before });
  }
  return toDto(await loadRow(ctx, id), await countOf(ctx, id));
}

/**
 * Publishes a draft: the stages must be complete and consistent (keys unique, inputs reading earlier stages' outputs, the
 * previous cycle or a pick, no loops), the version goes up by one and the template can be launched.
 */
export async function publishTemplate(ctx: Ctx, id: string): Promise<CycleTemplate> {
  assertHuman(ctx);
  await assertManageTemplates(ctx);
  const row = await loadRow(ctx, id);
  if (row.status === 'published') throw new ConflictError('The template is already published.');
  const parsed = TemplateStagesSchema.safeParse(row.stages);
  const issues = parsed.success ? validateTemplateStages(parsed.data) : parsed.error.issues.map((i) => ({ path: `stages.${i.path.join('.')}`, message: i.message }));
  if (parsed.success && parsed.data.length === 0) issues.push({ path: 'stages', message: 'a template needs at least one stage' });
  if (issues.length) throw new ValidationError(`The template cannot be published: ${issues[0]!.message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''}`, issues);
  await guardIntegrity(() => ctx.tx.update(cycleTemplate).set({ status: 'published', version: row.version + 1 }).where(eq(cycleTemplate.id, id)));
  reportUndo(ctx, { label: `Published the template ${row.name}`, method: 'POST', path: `/api/cycle-templates/${id}/revise` });
  return toDto(await loadRow(ctx, id), await countOf(ctx, id));
}

/** A retired template is no longer offered; cycles launched from it carry on. */
export async function retireTemplate(ctx: Ctx, id: string): Promise<CycleTemplate> {
  assertHuman(ctx);
  await assertManageTemplates(ctx);
  const row = await loadRow(ctx, id);
  if (row.status !== 'published') throw new ConflictError(`Only a published template can be retired (this one is ${row.status}).`);
  await guardIntegrity(() => ctx.tx.update(cycleTemplate).set({ status: 'retired' }).where(eq(cycleTemplate.id, id)));
  reportUndo(ctx, { label: `Retired the template ${row.name}`, method: 'POST', path: `/api/cycle-templates/${id}/reinstate` });
  return toDto(await loadRow(ctx, id), await countOf(ctx, id));
}

/** Offers a retired template again (the same version). */
export async function reinstateTemplate(ctx: Ctx, id: string): Promise<CycleTemplate> {
  assertHuman(ctx);
  await assertManageTemplates(ctx);
  const row = await loadRow(ctx, id);
  if (row.status !== 'retired') throw new ConflictError(`Only a retired template can be offered again (this one is ${row.status}).`);
  await guardIntegrity(() => ctx.tx.update(cycleTemplate).set({ status: 'published' }).where(eq(cycleTemplate.id, id)));
  reportUndo(ctx, { label: `Offered the template ${row.name} again`, method: 'POST', path: `/api/cycle-templates/${id}/retire` });
  return toDto(await loadRow(ctx, id), await countOf(ctx, id));
}

/** Turns a published or retired template back into a draft to edit; publishing it again makes the next version. */
export async function reviseTemplate(ctx: Ctx, id: string): Promise<CycleTemplate> {
  assertHuman(ctx);
  await assertManageTemplates(ctx);
  const row = await loadRow(ctx, id);
  if (row.status === 'draft') throw new ConflictError('The template is already a draft.');
  await guardIntegrity(() => ctx.tx.update(cycleTemplate).set({ status: 'draft' }).where(eq(cycleTemplate.id, id)));
  reportUndo(ctx, { label: `Revising the template ${row.name}`, method: 'POST', path: `/api/cycle-templates/${id}/publish` });
  return toDto(await loadRow(ctx, id), await countOf(ctx, id));
}

/** Deletes a template that was never published (and so was never launched). Undo creates it again. */
export async function deleteTemplate(ctx: Ctx, id: string): Promise<void> {
  assertHuman(ctx);
  await assertManageTemplates(ctx);
  const row = await loadRow(ctx, id);
  if (row.status !== 'draft' || row.version > 0) throw new ConflictError('Only a template that was never published can be deleted. Retire it instead.');
  if (await countOf(ctx, id)) throw new ConflictError('Cycles were launched from this template.');
  await guardIntegrity(() => ctx.tx.delete(cycleTemplate).where(and(eq(cycleTemplate.id, id))));
  reportUndo(ctx, {
    label: `Deleted the template ${row.name}`, method: 'POST', path: '/api/cycle-templates',
    body: { key: row.key, name: row.name, nameAr: row.nameAr ?? undefined, description: row.description ?? undefined, anchorKinds: row.anchorKinds, stages: row.stages, origin: row.origin },
  });
}

/** For the launch: a published template, by id. */
export async function loadPublishedTemplate(ctx: Ctx, id: string): Promise<{ row: TemplateRow; stages: StageDef[] }> {
  const row = await loadRow(ctx, id);
  if (row.status !== 'published') throw new ConflictError(`The template ${row.name} is ${row.status}; only a published template can be launched.`);
  return { row, stages: TemplateStagesSchema.parse(row.stages) };
}
