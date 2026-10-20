// Cycle plans (TASK-081): a template and a recurrence attached to an anchor, with inheritance down a standard and to the external
// requirements mapped to it (plans.ts), the academic calendar they recur against (calendar.ts) and the runs they propose (due.ts).
// Plans sit outside the immutable framework tables, so they work on published versions; a requirement is named by standard and code
// like scope and champion, so a plan carries over to the next version. Managed with cycle:manage for the whole institution.
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { cycle, cyclePlan, cycleTemplate, framework, frameworkVersion, requirement, requirementMapping } from '@ams/db';
import {
  SetPlanSchema, type CycleAnchorKind, type EffectivePlan, type NodePlans, type OwnPlan, type CyclePlan, type PlanTarget, type CycleRecurrence, type SetPlan, type TargetPlans,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman, getVersion } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { referenceVersion, treeOf } from '../scope/assignments.js';
import { reportUndo } from '../trash/store.js';
import { assertPerson, assertUnit, checkAnchor } from './common.js';
import { proposeForPlan } from './due.js';
import { loadPlanEnv, type PlanEnv, type PlanRow } from './plan-env.js';
import { resolvePlanTree, type EffRef, type MappedPlans, type PlanRef } from './plans.js';
import { assertManageTemplates } from './templates.js';

const any = { type: 'any' } as const;
/** How far ahead a plan's "next due" looks. */
const LOOKAHEAD_DAYS = 730;

interface Resolved { kind: PlanTarget['anchorKind']; anchorId: string | null; frameworkId: string | null; code: string | null }

/** Checks that the anchor exists in this institution and returns it in the shape the table stores. */
async function resolveTarget(ctx: Ctx, t: PlanTarget): Promise<Resolved> {
  const kind = t.anchorKind;
  if (kind === 'framework' || kind === 'requirement') {
    if (!t.frameworkId) throw new ValidationError('Name the standard this plan is attached to.');
    const [fw] = await ctx.tx.select({ id: framework.id }).from(framework).where(eq(framework.id, t.frameworkId));
    if (!fw) throw new NotFoundError(`standard ${t.frameworkId}`);
    if (kind === 'framework') return { kind, anchorId: null, frameworkId: t.frameworkId, code: null };
    if (!t.code) throw new ValidationError('Name the requirement this plan is attached to.');
    const [r] = await ctx.tx.select({ id: requirement.id }).from(requirement).innerJoin(frameworkVersion, eq(frameworkVersion.id, requirement.frameworkVersionId))
      .where(and(eq(frameworkVersion.frameworkId, t.frameworkId), eq(requirement.code, t.code))).limit(1);
    if (!r) throw new NotFoundError(`requirement ${t.code}`);
    return { kind, anchorId: null, frameworkId: t.frameworkId, code: t.code };
  }
  const id = t.anchorId ?? (kind === 'institution' ? ctx.caller.institutionId : undefined);
  if (!id) throw new ValidationError('Name what this plan is attached to.');
  await checkAnchor(ctx, kind, id);
  return { kind, anchorId: id, frameworkId: null, code: null };
}

const targetWhere = (r: Resolved) => and(
  eq(cyclePlan.anchorKind, r.kind),
  r.anchorId ? eq(cyclePlan.anchorId, r.anchorId) : isNull(cyclePlan.anchorId),
  r.frameworkId ? eq(cyclePlan.anchorFrameworkId, r.frameworkId) : isNull(cyclePlan.anchorFrameworkId),
  r.code ? eq(cyclePlan.anchorCode, r.code) : isNull(cyclePlan.anchorCode),
);

/** The cycle anchor kind a plan's runs will have (a whole standard is about its published version). */
const cycleKindOf = (k: PlanTarget['anchorKind']): CycleAnchorKind => (k === 'framework' ? 'framework_version' : k);

async function anchorNameOf(ctx: Ctx, p: PlanRow): Promise<string | null> {
  try {
    if (p.anchorKind === 'framework') return (await ctx.tx.select({ n: framework.name }).from(framework).where(eq(framework.id, p.anchorFrameworkId!)))[0]?.n ?? null;
    if (p.anchorKind === 'requirement') {
      const ref = await referenceVersion(ctx, p.anchorFrameworkId!);
      const [r] = ref ? await ctx.tx.select({ code: requirement.code, title: requirement.title }).from(requirement).where(and(eq(requirement.frameworkVersionId, ref), eq(requirement.code, p.anchorCode!))) : [];
      return r ? `${r.code} ${r.title}` : p.anchorCode;
    }
    return (await checkAnchor(ctx, p.anchorKind as CycleAnchorKind, p.anchorId!)).name;
  } catch { return null; }
}

async function names(ctx: Ctx): Promise<{ templates: Map<string, string>; units: Map<string, string>; users: Map<string, string> }> {
  const templates = new Map((await ctx.tx.select({ id: cycleTemplate.id, n: cycleTemplate.name }).from(cycleTemplate)).map((t) => [t.id, t.n] as const));
  const units = new Map((await ctx.tx.execute<{ id: string; n: string }>(sql`select id, name_en as n from org_unit`)).rows.map((r) => [r.id, r.n] as const));
  const users = new Map((await ctx.tx.execute<{ id: string; n: string }>(sql`select id, full_name as n from app_user`)).rows.map((r) => [r.id, r.n] as const));
  return { templates, units, users };
}

async function describe(ctx: Ctx, env: PlanEnv, p: PlanRow, nm: Awaited<ReturnType<typeof names>>, canManage: boolean): Promise<CyclePlan> {
  const prop = await proposeForPlan(ctx, env, p, LOOKAHEAD_DAYS);
  const next = prop.runs.reduce<(typeof prop.runs)[number] | null>((m, r) => (!m || r.periodStart < m.periodStart ? r : m), null);
  const decision = !!p.recurrence && 'after' in p.recurrence;
  return {
    id: p.id, anchorKind: p.anchorKind, anchorId: p.anchorId, frameworkId: p.anchorFrameworkId, code: p.anchorCode, anchorName: await anchorNameOf(ctx, p),
    templateId: p.templateId, templateName: nm.templates.get(p.templateId) ?? '', mode: p.mode, recurrence: p.recurrence ?? null, firstStart: p.firstStart,
    responsibleUnitId: p.responsibleUnitId, responsibleUnitName: p.responsibleUnitId ? nm.units.get(p.responsibleUnitId) ?? null : null,
    ownerUserId: p.ownerUserId, ownerName: p.ownerUserId ? nm.users.get(p.ownerUserId) ?? null : null,
    appliesTo: p.appliesTo ?? {}, active: p.active,
    nextDue: next?.periodStart ?? null, nextLabel: next?.periodLabel ?? null,
    waitingForDate: decision && p.active && !next && prop.gaps.some((g) => g.reason === 'no_date'),
    gap: prop.gaps.find((g) => g.reason !== 'no_date') ?? null,
    subjectCount: prop.subjectCount, canManage,
  };
}

/** Every plan of the institution (plans and opt-outs), by anchor then template, with its next run and how many subjects it covers. */
export async function listPlans(ctx: Ctx, opts: { today?: string } = {}): Promise<CyclePlan[]> {
  await assertPermitted(ctx, 'cycle:read', any);
  const rows = await ctx.tx.select().from(cyclePlan).orderBy(asc(cyclePlan.createdAt), asc(cyclePlan.id));
  const env = await loadPlanEnv(ctx, opts.today);
  const nm = await names(ctx);
  const manage = await assertPermitted(ctx, 'cycle:manage', { type: 'institution' }).then(() => true, () => false);
  const out: CyclePlan[] = [];
  for (const r of rows) out.push(await describe(ctx, env, r, nm, manage));
  return out.sort((a, b) => (a.anchorName ?? '').localeCompare(b.anchorName ?? '') || a.templateName.localeCompare(b.templateName) || a.id.localeCompare(b.id));
}

// ---- Effective plans of the requirements of a version ----------------------------------------------------------------------

const toRef = (p: PlanRow): PlanRef => ({ id: p.id, templateId: p.templateId, mode: p.mode });

async function plansOfFramework(ctx: Ctx, frameworkId: string): Promise<{ rows: PlanRow[]; own: Map<string, PlanRef[]>; whole: PlanRef[] }> {
  const rows = await ctx.tx.select().from(cyclePlan).where(eq(cyclePlan.anchorFrameworkId, frameworkId));
  const own = new Map<string, PlanRef[]>();
  const whole: PlanRef[] = [];
  // An inactive plan is switched off: it neither runs nor passes down.
  for (const r of rows.filter((x) => x.active)) {
    if (r.anchorKind === 'framework') whole.push(toRef(r));
    else if (r.anchorCode) own.set(r.anchorCode, [...(own.get(r.anchorCode) ?? []), toRef(r)]);
  }
  return { rows, own, whole };
}

/** The plans in effect on every requirement of a version, by code: its own, else through its approved mappings, else its parent's, else the whole standard's; with where each comes from. */
export async function loadPlanAssignments(ctx: Ctx, versionId: string): Promise<Map<string, NodePlans>> {
  const v = await getVersion(ctx, versionId);
  const nodes = await treeOf(ctx, versionId);
  const mine = await plansOfFramework(ctx, v.frameworkId);
  const rowById = new Map(mine.rows.map((r) => [r.id, r] as const));
  const maps = await ctx.tx.select().from(requirementMapping).where(and(eq(requirementMapping.frameworkId, v.frameworkId), eq(requirementMapping.reviewStatus, 'approved')));
  const mapped = new Map<string, MappedPlans[]>();
  for (const fwId of new Set(maps.map((m) => m.internalFrameworkId))) {
    const ref = await referenceVersion(ctx, fwId);
    if (!ref) continue;
    const theirs = await plansOfFramework(ctx, fwId);
    for (const r of theirs.rows) rowById.set(r.id, r);
    const resolved = resolvePlanTree(await treeOf(ctx, ref), theirs.own, theirs.whole);
    for (const m of maps.filter((x) => x.internalFrameworkId === fwId).sort((a, b) => a.internalCode.localeCompare(b.internalCode, undefined, { numeric: true }))) {
      const r = resolved.get(m.internalCode);
      if (r) mapped.set(m.externalCode, [...(mapped.get(m.externalCode) ?? []), { code: m.internalCode, effective: r.effective }]);
    }
  }
  const res = resolvePlanTree(nodes, mine.own, mine.whole, mapped);
  const nm = (await ctx.tx.select({ id: cycleTemplate.id, n: cycleTemplate.name }).from(cycleTemplate)).reduce((m, t) => m.set(t.id, t.n), new Map<string, string>());
  const eff = (e: EffRef): EffectivePlan => {
    const row = rowById.get(e.planId);
    return { templateId: e.templateId, templateName: nm.get(e.templateId) ?? '', planId: e.planId, recurrence: row?.recurrence ?? null, firstStart: row?.firstStart ?? null, source: e.source, sourceCodes: e.sourceCodes, optedOut: e.optedOut };
  };
  const ownByCode = new Map<string, OwnPlan[]>();
  for (const r of mine.rows) {
    if (r.anchorKind !== 'requirement' || !r.anchorCode) continue;
    ownByCode.set(r.anchorCode, [...(ownByCode.get(r.anchorCode) ?? []), { planId: r.id, templateId: r.templateId, templateName: nm.get(r.templateId) ?? '', mode: r.mode, recurrence: r.recurrence ?? null, firstStart: r.firstStart, active: r.active }]);
  }
  const out = new Map<string, NodePlans>();
  for (const n of nodes) {
    const b = res.get(n.code)!;
    out.set(n.code, { own: ownByCode.get(n.code) ?? [], effective: b.effective.map(eff), inherited: ownByCode.has(n.code) ? b.inherited.map(eff) : [] });
  }
  return out;
}

/** What the plan dialog shows for a target: the plans set on it (in full) and, for a requirement, what it has in effect and what it would inherit. */
export async function getTargetPlans(ctx: Ctx, target: PlanTarget): Promise<TargetPlans> {
  await assertPermitted(ctx, 'cycle:read', any);
  const r = await resolveTarget(ctx, target);
  const rows = await ctx.tx.select().from(cyclePlan).where(targetWhere(r)).orderBy(asc(cyclePlan.createdAt));
  const env = await loadPlanEnv(ctx);
  const nm = await names(ctx);
  const manage = await assertPermitted(ctx, 'cycle:manage', { type: 'institution' }).then(() => true, () => false);
  const own: CyclePlan[] = [];
  for (const p of rows) own.push(await describe(ctx, env, p, nm, manage));
  let effective: EffectivePlan[] = []; let inherited: EffectivePlan[] = [];
  if (r.kind === 'requirement') {
    const ref = await referenceVersion(ctx, r.frameworkId!);
    const node = ref ? (await loadPlanAssignments(ctx, ref)).get(r.code!) : undefined;
    if (node) { effective = node.effective; inherited = node.inherited; }
  }
  return { own, effective, inherited };
}

// ---- Setting and clearing ---------------------------------------------------------------------------------------------------

function valuesOf(parsed: ReturnType<typeof SetPlanSchema.parse>): Pick<typeof cyclePlan.$inferInsert, 'recurrence' | 'firstStart' | 'responsibleUnitId' | 'ownerUserId' | 'appliesTo' | 'mode' | 'active'> {
  const own = parsed.mode === 'own';
  return {
    mode: parsed.mode, recurrence: own ? parsed.recurrence ?? null : null, firstStart: own ? parsed.firstStart ?? null : null,
    responsibleUnitId: own ? parsed.responsibleUnitId ?? null : null, ownerUserId: own ? parsed.ownerUserId ?? null : null,
    appliesTo: own ? parsed.appliesTo : {}, active: parsed.active,
  };
}

const bodyOf = (p: PlanRow, t: PlanTarget): Record<string, unknown> => ({
  ...t, templateId: p.templateId, mode: p.mode, ...(p.recurrence ? { recurrence: p.recurrence } : {}), ...(p.firstStart ? { firstStart: p.firstStart } : {}),
  responsibleUnitId: p.responsibleUnitId, ownerUserId: p.ownerUserId, appliesTo: p.appliesTo, active: p.active,
});
const targetOf = (p: PlanRow): PlanTarget => ({
  anchorKind: p.anchorKind, ...(p.anchorId ? { anchorId: p.anchorId } : {}), ...(p.anchorFrameworkId ? { frameworkId: p.anchorFrameworkId } : {}), ...(p.anchorCode ? { code: p.anchorCode } : {}),
});

/**
 * Sets a plan on an anchor for a template: a new one, or the change of the one already there. `mode: 'opt_out'` says this node stops
 * inheriting that template's plan. An own plan needs a recurrence and a first start; a published template that fits the anchor.
 */
export async function setPlan(ctx: Ctx, input: SetPlan): Promise<CyclePlan> {
  assertHuman(ctx);
  await assertManageTemplates(ctx);
  const parsed = SetPlanSchema.parse(input);
  const r = await resolveTarget(ctx, parsed);
  const [prior] = await ctx.tx.select().from(cyclePlan).where(and(targetWhere(r), eq(cyclePlan.templateId, parsed.templateId)));
  // Cycles are not linked to standards or requirements any more (DEC-030): the plans there stay readable and can be changed or removed,
  // but a new one is refused.
  if (!prior && (r.kind === 'requirement' || r.kind === 'framework')) {
    throw new ValidationError('A cycle plan is not attached to a standard or a requirement. Attach it to an evidence item (on its card in Evidence).');
  }
  const [tpl] = await ctx.tx.select().from(cycleTemplate).where(eq(cycleTemplate.id, parsed.templateId));
  if (!tpl) throw new NotFoundError(`cycle template ${parsed.templateId}`);
  if (parsed.mode === 'own') {
    if (!parsed.recurrence || !parsed.firstStart) throw new ValidationError('Choose how often it repeats and when the first run starts.');
    if (tpl.status !== 'published') throw new ConflictError(`The template ${tpl.name} is not published, so plans cannot use it.`);
    const fits = tpl.anchorKinds;
    if (fits.length && !fits.includes(cycleKindOf(r.kind))) throw new ConflictError(`The template ${tpl.name} does not fit this kind of thing (it fits: ${fits.join(', ')}).`);
    if ('after' in parsed.recurrence && parsed.recurrence.dates?.some((d) => d <= parsed.firstStart!)) throw new ValidationError('Every date set by a decision comes after the first start.');
  }
  if (parsed.mode === 'own' && parsed.responsibleUnitId) await assertUnit(ctx, parsed.responsibleUnitId, 'The responsible unit');
  if (parsed.mode === 'own' && parsed.ownerUserId) await assertPerson(ctx, parsed.ownerUserId, 'The owner');
  const vals = valuesOf(parsed);
  const t: PlanTarget = { anchorKind: r.kind, ...(r.anchorId ? { anchorId: r.anchorId } : {}), ...(r.frameworkId ? { frameworkId: r.frameworkId } : {}), ...(r.code ? { code: r.code } : {}) };
  let row: PlanRow;
  if (prior) {
    [row] = await guardIntegrity(() => ctx.tx.update(cyclePlan).set(vals).where(eq(cyclePlan.id, prior.id)).returning()) as [PlanRow];
    reportUndo(ctx, { label: `Changed the cycle plan of ${tpl.name}`, method: 'PUT', path: '/api/cycle-plans', body: bodyOf(prior, t) });
  } else {
    [row] = await guardIntegrity(() => ctx.tx.insert(cyclePlan).values({
      institutionId: ctx.caller.institutionId, anchorKind: r.kind, anchorId: r.anchorId, anchorFrameworkId: r.frameworkId, anchorCode: r.code, templateId: parsed.templateId, ...vals,
    }).returning()) as [PlanRow];
    reportUndo(ctx, { label: parsed.mode === 'opt_out' ? `Opted out of ${tpl.name}` : `Set a cycle plan: ${tpl.name}`, method: 'DELETE', path: `/api/cycle-plans/${row.id}` });
  }
  return describe(ctx, await loadPlanEnv(ctx), row, await names(ctx), true);
}

/** "Back to inherited": removes the plan (or opt-out) on the anchor. A plan that has made runs is switched off instead of removed; its runs keep pointing at it. */
export async function clearPlan(ctx: Ctx, id: string): Promise<void> {
  assertHuman(ctx);
  await assertManageTemplates(ctx);
  const [p] = await ctx.tx.select().from(cyclePlan).where(eq(cyclePlan.id, id));
  if (!p) throw new NotFoundError(`plan ${id}`);
  const [used] = await ctx.tx.select({ id: cycle.id }).from(cycle).where(eq(cycle.planId, id)).limit(1);
  if (used) throw new ConflictError('This plan has already made cycles, so it cannot be removed. Switch it off instead.');
  await ctx.tx.execute(sql`delete from cycle_plan_skip where plan_id = ${id}::uuid`);
  await ctx.tx.delete(cyclePlan).where(eq(cyclePlan.id, id));
  reportUndo(ctx, { label: 'Removed a cycle plan', method: 'PUT', path: '/api/cycle-plans', body: bodyOf(p, targetOf(p)) });
}

/** For a plan whose next date is set by a decision: records the date of the next run (after the ones already set). */
export async function setNextDate(ctx: Ctx, id: string, date: string): Promise<CyclePlan> {
  assertHuman(ctx);
  await assertManageTemplates(ctx);
  const [p] = await ctx.tx.select().from(cyclePlan).where(eq(cyclePlan.id, id));
  if (!p) throw new NotFoundError(`plan ${id}`);
  const rec = p.recurrence as CycleRecurrence | null;
  if (!rec || !('after' in rec)) throw new ConflictError('This plan repeats on a calendar; only a plan whose next date is set by a decision takes a date.');
  const last = [p.firstStart!, ...(rec.dates ?? [])].sort().pop()!;
  if (date <= last) throw new ValidationError(`The next date must come after ${last}.`);
  const next: CycleRecurrence = { ...rec, dates: [...(rec.dates ?? []), date] };
  const [row] = await guardIntegrity(() => ctx.tx.update(cyclePlan).set({ recurrence: next }).where(eq(cyclePlan.id, id)).returning());
  reportUndo(ctx, { label: 'Set the date of the next run', method: 'PUT', path: '/api/cycle-plans', body: bodyOf({ ...p, recurrence: rec }, targetOf(p)) });
  return describe(ctx, await loadPlanEnv(ctx), row!, await names(ctx), true);
}
