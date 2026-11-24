// Standards numbered by their place (the owner, 2026-11-23). In a draft whose version has "Number by place" on (framework_version.auto_number),
// every structural change renumbers it: the top level 1, 2, 3 …, a child its parent's code and its own place (2.1 … 2.5). Off by default,
// so an accreditor's own codes ("CFR 1.1", "Criterion 3") are never rewritten unless a person asks for it; a new version keeps the setting.
// What hangs on a standard's code (scope, champion, frequency, approval steps, evidence links and requests, mappings, cycle plans,
// submissions) follows the new code when the draft is published (`carryCodesOnPublish`), so the published version keeps its own until then.
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  cyclePlan, evidenceLink, evidenceRequest, frameworkVersion, qualitySubmission, requirement, requirementApproval, requirementChampion, requirementFrequency,
  requirementMapping, requirementScope,
} from '@ams/db';
import type { Ctx } from '../ctx.js';

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** The codes each requirement of a version should have, from its place in the tree (siblings by display order, then code). */
export function placeCodes(rows: { id: string; parentId: string | null; code: string; displayOrder: number }[]): Map<string, { code: string; order: number }> {
  const kids = new Map<string | null, typeof rows>();
  for (const r of rows) kids.set(r.parentId ?? null, [...(kids.get(r.parentId ?? null) ?? []), r]);
  const out = new Map<string, { code: string; order: number }>();
  const walk = (parent: string | null, prefix: string) => {
    const list = [...(kids.get(parent) ?? [])].sort((a, b) => a.displayOrder - b.displayOrder || natural(a.code, b.code));
    list.forEach((r, i) => { const code = prefix ? `${prefix}.${i + 1}` : String(i + 1); out.set(r.id, { code, order: i }); walk(r.id, code); });
  };
  walk(null, '');
  return out;
}

/** Renumbers a draft version by place (see above). Returns how many codes changed. */
export async function renumberVersion(ctx: Ctx, versionId: string): Promise<number> {
  const [v] = await ctx.tx.select({ status: frameworkVersion.status, auto: frameworkVersion.autoNumber }).from(frameworkVersion).where(eq(frameworkVersion.id, versionId));
  if (!v || v.status !== 'draft' || !v.auto) return 0;
  const rows = await ctx.tx.select({ id: requirement.id, parentId: requirement.parentId, code: requirement.code, displayOrder: requirement.displayOrder }).from(requirement).where(eq(requirement.frameworkVersionId, versionId));
  if (!rows.length) return 0;
  const want = placeCodes(rows);
  const changed = rows.filter((r) => want.get(r.id)!.code !== r.code || want.get(r.id)!.order !== r.displayOrder);
  if (!changed.length) return 0;
  // Two steps, so a code freed by one row can be taken by another without colliding on (version, code).
  for (const r of changed) await ctx.tx.update(requirement).set({ code: `~${r.id}` }).where(eq(requirement.id, r.id));
  for (const r of changed) { const w = want.get(r.id)!; await ctx.tx.update(requirement).set({ code: w.code, displayOrder: w.order }).where(eq(requirement.id, r.id)); }
  return changed.filter((r) => want.get(r.id)!.code !== r.code).length;
}

/**
 * When a version is published: what is attached to the old code of each carried requirement moves to its new code, in every table
 * that names a standard by framework and code. Runs with the database's `app.renumbering` flag, which alone lets an evidence link and
 * an approved submission take the new code.
 */
export async function carryCodesOnPublish(ctx: Ctx, versionId: string, frameworkId: string): Promise<number> {
  const rows = await ctx.tx.select({ id: requirement.id, code: requirement.code, from: requirement.carriedFromId }).from(requirement).where(eq(requirement.frameworkVersionId, versionId));
  const fromIds = rows.map((r) => r.from).filter((x): x is string => !!x);
  if (!fromIds.length) return 0;
  const olds = new Map((await ctx.tx.select({ id: requirement.id, code: requirement.code }).from(requirement).where(inArray(requirement.id, fromIds))).map((r) => [r.id, r.code]));
  const renames = rows.flatMap((r) => { const old = r.from ? olds.get(r.from) : undefined; return old && old !== r.code ? [{ old, next: r.code }] : []; });
  if (!renames.length) return 0;
  await ctx.tx.execute(sql`select set_config('app.renumbering', 'on', true)`);
  const tmp = (c: string) => `~renumber~${c}`;
  // Each table: old -> temporary, then temporary -> new (codes can swap places).
  // [table, its framework column, its code column, the code column's field name]
  const tables = [
    [requirementScope, requirementScope.frameworkId, requirementScope.code, 'code'],
    [requirementChampion, requirementChampion.frameworkId, requirementChampion.code, 'code'],
    [requirementFrequency, requirementFrequency.frameworkId, requirementFrequency.code, 'code'],
    [requirementApproval, requirementApproval.frameworkId, requirementApproval.code, 'code'],
    [qualitySubmission, qualitySubmission.frameworkId, qualitySubmission.code, 'code'],
    [requirementMapping, requirementMapping.frameworkId, requirementMapping.externalCode, 'externalCode'],
    [requirementMapping, requirementMapping.internalFrameworkId, requirementMapping.internalCode, 'internalCode'],
    [evidenceLink, evidenceLink.internalFrameworkId, evidenceLink.internalCode, 'internalCode'],
    [evidenceRequest, evidenceRequest.internalFrameworkId, evidenceRequest.internalCode, 'internalCode'],
    [cyclePlan, cyclePlan.anchorFrameworkId, cyclePlan.anchorCode, 'anchorCode'],
  ] as const;
  for (const step of ['out', 'in'] as const) {
    for (const [table, fw, code, field] of tables) {
      for (const r of renames) {
        const from = step === 'out' ? r.old : tmp(r.next);
        const to = step === 'out' ? tmp(r.next) : r.next;
        await ctx.tx.update(table as typeof requirementScope).set({ [field]: to } as never).where(and(eq(fw, frameworkId), eq(code, from)));
      }
    }
  }
  await ctx.tx.execute(sql`select set_config('app.renumbering', '', true)`);
  return renames.length;
}
