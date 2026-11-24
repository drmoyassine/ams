// Standards numbered by their place (the owner, 2026-11-23/24). In a draft whose version has "Number by place" on
// (framework_version.auto_number), every structural change renumbers it. A code keeps its own words and separators and only its
// numbers change: "2.5" becomes "2.3", "CFR 1.4" becomes "CFR 1.2", "Criterion 3(4)" becomes "Criterion 3(2)", "1-1-3" becomes
// "1-1-2". The leading numbers come from the parent, the last one from the place among the siblings. A heading that adds no number
// of its own ("Standard 1 - Integrity", under "Standard 1") takes its parent's numbers, and the numbering of its children runs on
// across the headings of the same parent (CFR 1.1, 1.2 under the first heading, 1.3 … under the next). A code without numbers
// ("Preamble") stays as it is and takes no place. Off by default; a new version keeps the setting.
//
// What hangs on a standard's code (scope, champion, frequency, approval steps, icon, evidence links and requests, mappings, cycle plans,
// submissions) belongs to it, not to the code:
//   * a standard carried from a published version keeps its attachments under its published code until the draft is published
//     (`carryCodesOnPublish` then moves them), so the published version is unchanged meanwhile;
//   * a standard added in the draft takes its attachments along at once when it is renumbered. If its new code is still the code of
//     a standard of another version, they are held under the standard's own key (`~std~<id>`) and placed on its code at publish.
// `attachmentCode` gives the key a draft standard's attachments are under; the evidence services read and write through it.
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  cyclePlan, evidenceLink, evidenceRequest, frameworkVersion, qualitySubmission, requirement, requirementApproval, requirementChampion, requirementFrequency,
  requirementIcon, requirementMapping, requirementScope,
} from '@ams/db';
import type { Ctx } from '../ctx.js';
import { ConflictError } from '../ctx.js';

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const numbersOf = (code: string) => (code.match(/\d+/g) ?? []).map(Number);
const withNumbers = (code: string, nums: number[]) => { let i = 0; return code.replace(/\d+/g, (m) => (i < nums.length ? String(nums[i++]) : m)); };
/** The key a draft standard's attachments are held under while its code belongs to a standard of another version. */
export const parkedCode = (requirementId: string) => `~std~${requirementId}`;

type Row = { id: string; parentId: string | null; code: string; displayOrder: number };

/** The codes each requirement of a version should have, from its place in the tree (siblings by display order, then code). */
export function placeCodes(rows: Row[]): Map<string, { code: string; order: number }> {
  const kids = new Map<string | null, Row[]>();
  for (const r of rows) kids.set(r.parentId ?? null, [...(kids.get(r.parentId ?? null) ?? []), r]);
  const out = new Map<string, { code: string; order: number }>();
  const walk = (parent: string | null, parentNums: number[], counter: { n: number }) => {
    const list = [...(kids.get(parent) ?? [])].sort((a, b) => a.displayOrder - b.displayOrder || natural(a.code, b.code));
    list.forEach((r, order) => {
      const own = numbersOf(r.code);
      if (own.length === 0) { out.set(r.id, { code: r.code, order }); walk(r.id, parentNums, { n: 0 }); return; }
      if (parentNums.length > 0 && own.length === parentNums.length) {
        // A heading: its parent's numbers, and its children carry on the parent's count.
        out.set(r.id, { code: withNumbers(r.code, parentNums), order }); walk(r.id, parentNums, counter); return;
      }
      if (own.length < parentNums.length) { out.set(r.id, { code: r.code, order }); walk(r.id, own, { n: 0 }); return; }
      const nums = [...parentNums, ...own.slice(parentNums.length, own.length - 1), ++counter.n];
      out.set(r.id, { code: withNumbers(r.code, nums), order });
      walk(r.id, nums, { n: 0 });
    });
  };
  walk(null, [], { n: 0 });
  return out;
}

/** Renumbers a draft version by place (see above). Returns how many codes changed. */
export async function renumberVersion(ctx: Ctx, versionId: string): Promise<number> {
  const [v] = await ctx.tx.select({ status: frameworkVersion.status, auto: frameworkVersion.autoNumber, frameworkId: frameworkVersion.frameworkId })
    .from(frameworkVersion).where(eq(frameworkVersion.id, versionId));
  if (!v || v.status !== 'draft' || !v.auto) return 0;
  const rows = await ctx.tx.select({ id: requirement.id, parentId: requirement.parentId, code: requirement.code, displayOrder: requirement.displayOrder, from: requirement.carriedFromId })
    .from(requirement).where(eq(requirement.frameworkVersionId, versionId));
  if (!rows.length) return 0;
  const want = placeCodes(rows);
  const seen = new Map<string, string>();
  for (const r of rows) {
    const c = want.get(r.id)!.code;
    if (seen.has(c)) throw new ConflictError(`numbering by place would give two standards the code ${c}; change one of their codes first`);
    seen.set(c, r.id);
  }
  const changed = rows.filter((r) => want.get(r.id)!.code !== r.code || want.get(r.id)!.order !== r.displayOrder);
  if (!changed.length) return 0;
  // Two steps, so a code freed by one row can be taken by another without colliding on (version, code).
  for (const r of changed) await ctx.tx.update(requirement).set({ code: `~${r.id}` }).where(eq(requirement.id, r.id));
  for (const r of changed) { const w = want.get(r.id)!; await ctx.tx.update(requirement).set({ code: w.code, displayOrder: w.order }).where(eq(requirement.id, r.id)); }
  const recoded = changed.filter((r) => want.get(r.id)!.code !== r.code);
  await followNewStandards(ctx, versionId, v.frameworkId, recoded.filter((r) => !r.from).map((r) => ({ id: r.id, old: r.code, next: want.get(r.id)!.code })));
  return recoded.length;
}

/** The codes the other versions of a framework use: a draft standard added since cannot put its attachments there. */
async function codesOfOtherVersions(ctx: Ctx, frameworkId: string, versionId: string): Promise<Set<string>> {
  const rows = await ctx.tx.select({ code: requirement.code }).from(requirement)
    .innerJoin(frameworkVersion, eq(frameworkVersion.id, requirement.frameworkVersionId))
    .where(and(eq(frameworkVersion.frameworkId, frameworkId), ne(frameworkVersion.id, versionId)));
  return new Set(rows.map((r) => r.code));
}

/**
 * A standard added in a draft whose code changed (by place or by hand): its attachments go to its new code, or are held under its
 * own key while that code belongs to a standard of another version.
 */
export async function followNewStandards(ctx: Ctx, versionId: string, frameworkId: string, renames: { id: string; old: string; next: string }[]): Promise<void> {
  if (!renames.length) return;
  const taken = await codesOfOtherVersions(ctx, frameworkId, versionId);
  await moveAttachments(ctx, frameworkId, renames.map((r) => ({
    from: [...(taken.has(r.old) ? [] : [r.old]), parkedCode(r.id)],
    to: taken.has(r.next) ? parkedCode(r.id) : r.next,
    tmp: `~renumber~${r.id}`,
  })));
}

/** The key a requirement's attachments are under: its code, except in a draft (see the top of this file). */
export async function attachmentCode(ctx: Ctx, requirementId: string): Promise<{ frameworkId: string; code: string }> {
  const [r] = await ctx.tx.select({ code: requirement.code, from: requirement.carriedFromId, versionId: requirement.frameworkVersionId, status: frameworkVersion.status, frameworkId: frameworkVersion.frameworkId })
    .from(requirement).innerJoin(frameworkVersion, eq(frameworkVersion.id, requirement.frameworkVersionId)).where(eq(requirement.id, requirementId));
  if (!r) throw new ConflictError(`requirement ${requirementId} not found`);
  if (r.status !== 'draft') return { frameworkId: r.frameworkId, code: r.code };
  if (r.from) {
    const [o] = await ctx.tx.select({ code: requirement.code }).from(requirement).where(eq(requirement.id, r.from));
    return { frameworkId: r.frameworkId, code: o?.code ?? r.code };
  }
  const taken = await codesOfOtherVersions(ctx, r.frameworkId, r.versionId);
  return { frameworkId: r.frameworkId, code: taken.has(r.code) ? parkedCode(requirementId) : r.code };
}

// [table, its framework column, its code column, the code column's field name, one row per code (an old row there is cleared)]
const codeTables = () => [
  [requirementScope, requirementScope.frameworkId, requirementScope.code, 'code', true],
  [requirementChampion, requirementChampion.frameworkId, requirementChampion.code, 'code', true],
  [requirementFrequency, requirementFrequency.frameworkId, requirementFrequency.code, 'code', true],
  [requirementApproval, requirementApproval.frameworkId, requirementApproval.code, 'code', true],
  [requirementIcon, requirementIcon.frameworkId, requirementIcon.code, 'code', true],
  [qualitySubmission, qualitySubmission.frameworkId, qualitySubmission.code, 'code', false],
  [requirementMapping, requirementMapping.frameworkId, requirementMapping.externalCode, 'externalCode', false],
  [requirementMapping, requirementMapping.internalFrameworkId, requirementMapping.internalCode, 'internalCode', false],
  [evidenceLink, evidenceLink.internalFrameworkId, evidenceLink.internalCode, 'internalCode', false],
  [evidenceRequest, evidenceRequest.internalFrameworkId, evidenceRequest.internalCode, 'internalCode', false],
  [cyclePlan, cyclePlan.anchorFrameworkId, cyclePlan.anchorCode, 'anchorCode', false],
] as const;

/**
 * Moves what is attached to some codes to others, in every table that names a standard by framework and code: first everything out
 * to a temporary code, then in (codes can swap places). Rows left on a destination of a one-per-code table belong to a standard
 * that no longer exists, and give way. Runs with the database's `app.renumbering` flag, which alone lets an evidence link and an
 * approved submission take a new code.
 */
async function moveAttachments(ctx: Ctx, frameworkId: string, moves: { from: string[]; to: string; tmp: string }[]): Promise<void> {
  const real = moves.filter((m) => m.from.some((f) => f !== m.to));
  if (!real.length) return;
  await ctx.tx.execute(sql`select set_config('app.renumbering', 'on', true)`);
  for (const [table, fw, code, field] of codeTables()) {
    for (const m of real) {
      const from = m.from.filter((f) => f !== m.to);
      if (from.length) await ctx.tx.update(table as typeof requirementScope).set({ [field]: m.tmp } as never).where(and(eq(fw, frameworkId), inArray(code, from)));
    }
  }
  for (const [table, fw, code, field, onePerCode] of codeTables()) {
    for (const m of real) {
      if (onePerCode) {
        const [moving] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(table as typeof requirementScope).where(and(eq(fw, frameworkId), eq(code, m.tmp)));
        if (moving!.n > 0) await ctx.tx.delete(table as typeof requirementScope).where(and(eq(fw, frameworkId), eq(code, m.to)));
      }
      await ctx.tx.update(table as typeof requirementScope).set({ [field]: m.to } as never).where(and(eq(fw, frameworkId), eq(code, m.tmp)));
    }
  }
  await ctx.tx.execute(sql`select set_config('app.renumbering', '', true)`);
}

/**
 * When a version is published: what is attached to the old code of each carried requirement moves to its new code, then what a
 * standard added in the draft holds under its own key goes to its code.
 */
export async function carryCodesOnPublish(ctx: Ctx, versionId: string, frameworkId: string): Promise<number> {
  const rows = await ctx.tx.select({ id: requirement.id, code: requirement.code, from: requirement.carriedFromId }).from(requirement).where(eq(requirement.frameworkVersionId, versionId));
  const fromIds = rows.map((r) => r.from).filter((x): x is string => !!x);
  const olds = new Map(fromIds.length
    ? (await ctx.tx.select({ id: requirement.id, code: requirement.code }).from(requirement).where(inArray(requirement.id, fromIds))).map((r) => [r.id, r.code])
    : []);
  const renames = rows.flatMap((r) => { const old = r.from ? olds.get(r.from) : undefined; return old && old !== r.code ? [{ from: [old], to: r.code, tmp: `~renumber~${r.id}` }] : []; });
  await moveAttachments(ctx, frameworkId, renames);
  await moveAttachments(ctx, frameworkId, rows.filter((r) => !r.from).map((r) => ({ from: [parkedCode(r.id)], to: r.code, tmp: `~renumber~${r.id}` })));
  return renames.length;
}
