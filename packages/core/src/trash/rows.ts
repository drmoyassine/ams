// Row-level primitives of the Trash (DEC-026): read rows as the database stores them, delete them, put them back with
// their original ids. Done in SQL so every column travels (including the ones this code has never heard of) and the
// triggers (audit, frozen versions, rules) run exactly as for any other write. Never used outside a service.
import { sql } from 'drizzle-orm';
import type { Ctx } from '../ctx.js';
import { guardIntegrity } from '../framework/errors.js';

/**
 * Every table whose rows can travel in a Trash payload, in the order they must be inserted on restore (a table comes after
 * the ones it points to). Deleting goes through them in reverse.
 */
export const TRASH_TABLES = [
  'framework', 'framework_version', 'analysis_dismissal', 'source_document', 'source_page', 'analysis_run', 'requirement', 'requirement_note', 'report_template',
  'extraction_item', 'iqf_item_proposal', 'requirement_mapping', 'glossary_alias', 'evidence_link', 'milestone',
] as const;
export type TrashTable = (typeof TRASH_TABLES)[number];
export type Row = Record<string, unknown>;
export type Tables = Partial<Record<TrashTable, Row[]>>;

/** A column of another row that deleting set to null (a foreign key `on delete set null`); restore sets it back. */
export interface TrashRef { table: string; id: string; column: string; value: string }

/** What a Trash row's `payload` holds. `root` and `meta` are specific to the kind. */
export interface TrashPayload {
  v: 1;
  tables: Tables;
  /** Objects in storage that belong to this item. They are removed only when the item leaves the Trash for good. */
  files: string[];
  refs: TrashRef[];
  root: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

const table = (name: TrashTable) => sql.identifier(name);

/** A list of ids as a SQL array (a bare array parameter is expanded into a comma list by the query builder). */
export const uuids = (ids: readonly string[]) => (ids.length ? sql`array[${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}]::uuid[]` : sql`'{}'::uuid[]`);
export const texts = (values: readonly string[]) => (values.length ? sql`array[${sql.join(values.map((v) => sql`${v}::text`), sql`, `)}]::text[]` : sql`'{}'::text[]`);

/** Rows of `name` with these ids, exactly as stored. */
export async function readRows(ctx: Ctx, name: TrashTable, ids: string[]): Promise<Row[]> {
  if (!ids.length) return [];
  const res = await ctx.tx.execute<{ r: Row }>(sql`select to_jsonb(t) as r from ${table(name)} t where t.id = any(${uuids(ids)}) order by t.created_at, t.id`);
  return res.rows.map((x) => x.r);
}

/** Rows of `name` matching a condition written against the alias `t`. */
export async function readWhere(ctx: Ctx, name: TrashTable, where: ReturnType<typeof sql>): Promise<Row[]> {
  const res = await ctx.tx.execute<{ r: Row }>(sql`select to_jsonb(t) as r from ${table(name)} t where ${where} order by t.created_at, t.id`);
  return res.rows.map((x) => x.r);
}

export async function deleteRows(ctx: Ctx, name: TrashTable, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await guardIntegrity(() => ctx.tx.execute(sql`delete from ${table(name)} where id = any(${uuids(ids)})`));
}

/** Inserts rows exactly as snapshotted (one statement, so a table that points to itself is checked at the end of it). */
export async function insertRows(ctx: Ctx, name: TrashTable, rows: Row[]): Promise<void> {
  if (!rows.length) return;
  await guardIntegrity(() => ctx.tx.execute(sql`insert into ${table(name)} select * from jsonb_populate_recordset(null::${table(name)}, ${JSON.stringify(rows)}::jsonb)`));
}

export const idsOf = (rows: Row[] | undefined): string[] => (rows ?? []).map((r) => String(r.id));

/** Which of these ids still exist in `name` (inside the caller's tenant). */
export async function existing(ctx: Ctx, name: TrashTable, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const res = await ctx.tx.execute<{ id: string }>(sql`select id from ${table(name)} where id = any(${uuids(ids)})`);
  return new Set(res.rows.map((r) => r.id));
}

export const emptyPayload = (root: Record<string, unknown> = {}): TrashPayload => ({ v: 1, tables: {}, files: [], refs: [], root, });

/** Deletes whole table sets in dependency order (children before parents), leaving the payload as the record. */
export async function deleteTables(ctx: Ctx, tables: Tables): Promise<void> {
  // analysis_dismissal is append-only for the app: a version's own are dropped by trash_drop_dismissals (see the caller).
  for (const name of [...TRASH_TABLES].reverse()) if (name !== 'analysis_dismissal') await deleteRows(ctx, name, idsOf(tables[name]));
}

/** Counts of rows per table in a payload, for the Trash list. */
export function tableCounts(tables: Tables): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of TRASH_TABLES) if (tables[name]?.length) out[name] = tables[name]!.length;
  return out;
}
