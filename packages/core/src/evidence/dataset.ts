// Dataset evidence (PRD 9.4, DEC-014): a specification (columns and grain; what the data means is the item's definition), and rows saved
// as versions. Every save is validated against the columns with the same rules the grid uses, and keeps its own copy of the columns.
import { desc, eq } from 'drizzle-orm';
import { datasetSpec, evidenceVersion } from '@ams/db';
import {
  DatasetDataSchema, SaveDatasetRowsSchema, SaveDatasetSpecSchema, validateRows,
  type DataColumn, type DataRow, type DatasetData, type DatasetSpec, type EvidenceVersion, type SaveDatasetRows, type SaveDatasetSpec,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { getItem, versionDto } from './evidence.js';
import { supplyOldestOpenRun } from '../collection/hook.js';

const any = { type: 'any' } as const;
type SpecRow = typeof datasetSpec.$inferSelect;

const specDto = (r: SpecRow | undefined): DatasetSpec => ({
  grain: r?.grain ?? null, columns: (r?.columns ?? []) as DataColumn[],
  sourceKind: r?.sourceKind ?? 'manual_upload', updatedAt: r?.updatedAt.toISOString() ?? null,
});

export async function dataItem(ctx: Ctx, itemId: string) {
  const item = await getItem(ctx, itemId);
  if (item.type !== 'dataset') throw new ValidationError('only dataset evidence has columns and rows');
  return item;
}

/** The item's specification; an item that has none yet gets an empty one (no columns). */
export async function getDatasetSpec(ctx: Ctx, itemId: string): Promise<DatasetSpec> {
  await assertPermitted(ctx, 'evidence:read', any);
  await dataItem(ctx, itemId);
  const [row] = await ctx.tx.select().from(datasetSpec).where(eq(datasetSpec.evidenceItemId, itemId));
  return specDto(row);
}

/** Sets the dataset's columns and grain. Data already saved keeps the columns it was saved with. */
export async function saveDatasetSpec(ctx: Ctx, itemId: string, input: SaveDatasetSpec): Promise<DatasetSpec> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  await dataItem(ctx, itemId);
  const d = SaveDatasetSpecSchema.parse(input);
  const values = { grain: d.grain ?? null, columns: d.columns };
  const [existing] = await ctx.tx.select({ id: datasetSpec.id }).from(datasetSpec).where(eq(datasetSpec.evidenceItemId, itemId));
  const [row] = existing
    ? await guardIntegrity(() => ctx.tx.update(datasetSpec).set(values).where(eq(datasetSpec.id, existing.id)).returning())
    : await guardIntegrity(() => ctx.tx.insert(datasetSpec).values({ ...values, institutionId: ctx.caller.institutionId, evidenceItemId: itemId }).returning());
  return specDto(row);
}

/**
 * Saves the rows as the item's next version, after checking every cell against the columns. Any invalid cell refuses
 * the whole save and says which (`rows.<n>.<key>`), so nothing half-valid is ever stored.
 */
export async function saveDatasetRows(ctx: Ctx, itemId: string, input: SaveDatasetRows): Promise<EvidenceVersion> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'evidence:write', any);
  const item = await dataItem(ctx, itemId);
  const d = SaveDatasetRowsSchema.parse(input);
  const [spec] = await ctx.tx.select().from(datasetSpec).where(eq(datasetSpec.evidenceItemId, itemId));
  const columns = (spec?.columns ?? []) as DataColumn[];
  if (!columns.length) throw new ValidationError('define the columns first');
  const { rows, issues } = validateRows(columns, d.rows);
  if (issues.length) {
    throw new ValidationError(`${issues.length} cell${issues.length === 1 ? ' needs' : 's need'} attention`, issues.slice(0, 200).map((i) => ({ path: `rows.${i.row}.${i.key}`, message: i.message })));
  }
  if (!rows.length) throw new ValidationError('there are no rows to save');
  const v = await insertDataVersion(ctx, item.id, columns, rows, { notes: d.notes ?? null, sourceKind: spec!.sourceKind });
  await supplyOldestOpenRun(ctx, item.id, v.id);
  return v;
}

/** Stores checked rows as the item's next version, with the columns and where they came from. */
export async function insertDataVersion(ctx: Ctx, itemId: string, columns: DataColumn[], rows: DataRow[], opts: { notes: string | null; sourceKind: string; extra?: Record<string, unknown>; asOfDate?: string }) {
  const [last] = await ctx.tx.select({ n: evidenceVersion.versionNo }).from(evidenceVersion).where(eq(evidenceVersion.evidenceItemId, itemId)).orderBy(desc(evidenceVersion.versionNo)).limit(1);
  const data: DatasetData = { columns, rows };
  const [v] = await guardIntegrity(() => ctx.tx.insert(evidenceVersion).values({
    institutionId: ctx.caller.institutionId, evidenceItemId: itemId, versionNo: (last?.n ?? 0) + 1, data, notes: opts.notes,
    asOfDate: opts.asOfDate ?? new Date().toISOString().slice(0, 10),
    lineage: { source_kind: opts.sourceKind, supplied_by: ctx.caller.userId, saved_at: new Date().toISOString(), ...opts.extra },
  }).returning());
  return versionDto(v!);
}

/** The columns and rows a data version holds. */
export async function readVersionData(ctx: Ctx, versionId: string): Promise<DatasetData> {
  await assertPermitted(ctx, 'evidence:read', any);
  const [v] = await ctx.tx.select().from(evidenceVersion).where(eq(evidenceVersion.id, versionId));
  if (!v) throw new NotFoundError(`evidence version ${versionId}`);
  if (!v.data) throw new NotFoundError('this version holds a file, not data');
  return DatasetDataSchema.parse(v.data);
}
