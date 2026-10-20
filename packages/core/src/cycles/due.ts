// Proposed runs (TASK-081, DEC-029: the scheduler PROPOSES, QA launches). For each active plan and each subject it applies to, the
// periods that begin within the horizon (or are under way) and have no run yet and were not skipped. Computed on request: no job,
// no automatic launch. When notifications arrive they hook onto `proposeForPlan`, which has no side effects.
import { and, eq, inArray } from 'drizzle-orm';
import { appUser, cyclePlan, cyclePlanSkip, cycleTemplate, orgUnit } from '@ams/db';
import { DUE_HORIZON_DAYS, type DueGap, type DueRun, type DueRuns, type DueRunsQuery, type SkipDueRun } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';
import { guardIntegrity } from '../framework/errors.js';
import { reportUndo } from '../trash/store.js';
import { dayOf, mayManage, nfc } from './common.js';
import { cycleAnchorOf, loadPlanEnv, runKey, subjectKey, subjectsOfPlan, type PlanEnv, type PlanRow } from './plan-env.js';
import { periodsFor, plusDays } from './recurrence.js';
import { assertManageTemplates } from './templates.js';

export interface Proposal { runs: Omit<DueRun, 'planLabel' | 'templateName' | 'responsibleUnitName' | 'ownerName' | 'canLaunch'>[]; gaps: { from: string; to: string; reason: DueGap['reason'] }[]; subjectCount: number }

/**
 * The runs one plan proposes within `horizon` days of today. No side effects. A run is proposed once per subject and period;
 * it disappears when a run exists (not cancelled) or the period was skipped.
 */
export async function proposeForPlan(ctx: Ctx, env: PlanEnv, p: PlanRow, horizonDays: number): Promise<Proposal> {
  const empty: Proposal = { runs: [], gaps: [], subjectCount: 0 };
  if (p.mode !== 'own' || !p.active || !p.recurrence || !p.firstStart) return empty;
  const [tpl] = await ctx.tx.select({ status: cycleTemplate.status }).from(cycleTemplate).where(eq(cycleTemplate.id, p.templateId));
  if (tpl?.status !== 'published') return empty;
  const subjects = await subjectsOfPlan(ctx, env, p);
  const anchor = await cycleAnchorOf(ctx, p);
  if (!anchor) return empty;
  const { periods, gaps } = periodsFor(p.recurrence, p.firstStart, env.calendar, { from: env.today, to: plusDays(env.today, horizonDays) });
  const runs: Proposal['runs'] = [];
  for (const period of periods) {
    for (const s of subjects) {
      const k = runKey(p.id, subjectKey(s.kind, s.id), period.start);
      if (env.made.has(k) || env.skipped.has(k)) continue;
      const previous = env.madeBySubject.get(`${p.id}|${subjectKey(s.kind, s.id)}`)?.find((r) => r.periodStart < period.start && (r.status === 'active' || r.status === 'completed'));
      // A unit, program or institution plan is about that thing itself, so the subject is the anchor and not named twice.
      const own = p.anchorKind === 'institution' || p.anchorKind === 'org_unit' || p.anchorKind === 'program';
      runs.push({
        planId: p.id, templateId: p.templateId, anchorKind: anchor.kind, anchorId: anchor.id, anchorName: anchor.name,
        subjectKind: own ? null : s.kind, subjectId: own ? null : s.id, subjectName: s.name,
        periodStart: period.start, periodEnd: period.end, periodLabel: period.label, state: period.start <= env.today ? 'due' : 'upcoming',
        responsibleUnitId: p.responsibleUnitId ?? s.unitId, ownerUserId: p.ownerUserId, previousCycleId: previous?.id ?? null,
      });
    }
  }
  // Gaps matter only when nothing is left to propose for the plan: "waiting for a date" is not news while a run is still to launch.
  const waiting = gaps.filter((g) => g.reason !== 'no_date' || runs.length === 0);
  return { runs, gaps: waiting, subjectCount: subjects.length };
}

const nameOf = async (ctx: Ctx, ids: { units: Set<string>; users: Set<string> }) => {
  const units = new Map<string, string>(); const users = new Map<string, string>();
  if (ids.units.size) for (const r of await ctx.tx.select({ id: orgUnit.id, n: orgUnit.nameEn }).from(orgUnit).where(inArray(orgUnit.id, [...ids.units]))) units.set(r.id, r.n);
  if (ids.users.size) for (const r of await ctx.tx.select({ id: appUser.id, n: appUser.fullName }).from(appUser).where(inArray(appUser.id, [...ids.users]))) users.set(r.id, r.n);
  return { units, users };
};

/** The label of a plan in lists: its template and where it is attached. */
export const planLabel = (templateName: string, anchorName: string | null) => (anchorName ? `${templateName} · ${anchorName}` : templateName);

export interface DueOptions { today?: string }

/**
 * The runs due or coming up, over all plans: what QA reviews and launches ("Due to launch"). Filters: template, subject, plan, state.
 * Needs cycle:read; `canLaunch` says whether the caller may launch each one.
 */
export async function listDueRuns(ctx: Ctx, query: DueRunsQuery = {}, opts: DueOptions = {}): Promise<DueRuns> {
  await assertPermitted(ctx, 'cycle:read', { type: 'any' });
  const horizonDays = query.horizonDays ?? DUE_HORIZON_DAYS;
  const env = await loadPlanEnv(ctx, opts.today ?? dayOf());
  const plans = (await ctx.tx.select().from(cyclePlan).where(and(eq(cyclePlan.mode, 'own'), eq(cyclePlan.active, true), query.planId ? eq(cyclePlan.id, query.planId) : undefined, query.templateId ? eq(cyclePlan.templateId, query.templateId) : undefined)))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const tpls = new Map((await ctx.tx.select({ id: cycleTemplate.id, name: cycleTemplate.name }).from(cycleTemplate)).map((t) => [t.id, t.name] as const));
  const raw: { plan: PlanRow; run: Proposal['runs'][number] }[] = [];
  const gaps: DueGap[] = [];
  for (const p of plans) {
    const prop = await proposeForPlan(ctx, env, p, horizonDays);
    for (const run of prop.runs) raw.push({ plan: p, run });
    const anchor = prop.gaps.length ? await cycleAnchorOf(ctx, p) : null;
    for (const g of prop.gaps) gaps.push({ planId: p.id, planLabel: planLabel(tpls.get(p.templateId) ?? '', anchor?.name ?? null), ...g });
  }
  const filtered = raw.filter(({ run }) => (!query.state || run.state === query.state) && (!query.subjectId || run.subjectId === query.subjectId || (run.subjectId === null && run.anchorId === query.subjectId)));
  const names = await nameOf(ctx, { units: new Set(filtered.flatMap((r) => (r.run.responsibleUnitId ? [r.run.responsibleUnitId] : []))), users: new Set(filtered.flatMap((r) => (r.run.ownerUserId ? [r.run.ownerUserId] : []))) });
  const runs: DueRun[] = [];
  for (const { run } of filtered) {
    const can = run.responsibleUnitId ? await mayManage(ctx, run.responsibleUnitId) : true;
    runs.push({
      ...run, planLabel: planLabel(tpls.get(run.templateId) ?? '', run.anchorName), templateName: tpls.get(run.templateId) ?? '',
      responsibleUnitName: run.responsibleUnitId ? names.units.get(run.responsibleUnitId) ?? null : null, ownerName: run.ownerUserId ? names.users.get(run.ownerUserId) ?? null : null, canLaunch: can,
    });
  }
  runs.sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.planLabel.localeCompare(b.planLabel) || (a.subjectName ?? '').localeCompare(b.subjectName ?? '') || (a.subjectId ?? '').localeCompare(b.subjectId ?? ''));
  return { runs, gaps, horizonDays };
}

/** "Skip this period": the run is not proposed again; the reason is kept. Undo removes the skip. */
export async function skipDueRun(ctx: Ctx, input: SkipDueRun): Promise<{ ok: true }> {
  assertHuman(ctx);
  await assertManageTemplates(ctx);
  const d = { ...input, subjectKind: input.subjectKind ?? null, subjectId: input.subjectId ?? null };
  const [plan] = await ctx.tx.select().from(cyclePlan).where(eq(cyclePlan.id, d.planId));
  if (!plan) throw new NotFoundError(`plan ${d.planId}`);
  const reason = nfc(d.reason);
  if (!reason) throw new ValidationError('Give the reason for skipping this period.');
  // A unit, program or institution plan is about the anchor itself: the subject is stored as that.
  const own = plan.anchorKind === 'institution' || plan.anchorKind === 'org_unit' || plan.anchorKind === 'program';
  const kind = own ? (plan.anchorKind as 'institution' | 'org_unit' | 'program') : d.subjectKind;
  const id = own ? plan.anchorId : d.subjectId;
  const env = await loadPlanEnv(ctx);
  if (env.made.has(runKey(plan.id, subjectKey(kind, id), d.periodStart))) throw new ConflictError('A run for that period was already launched.');
  const [row] = await guardIntegrity(() => ctx.tx.insert(cyclePlanSkip).values({
    institutionId: ctx.caller.institutionId, planId: plan.id, subjectKind: kind, subjectId: id, periodStart: d.periodStart, reason,
  }).returning());
  reportUndo(ctx, { label: 'Skipped a period', method: 'DELETE', path: `/api/cycle-plan-skips/${row!.id}` });
  return { ok: true };
}

/** Undo of a skip: the run is proposed again. */
export async function unskipDueRun(ctx: Ctx, id: string): Promise<void> {
  assertHuman(ctx);
  await assertManageTemplates(ctx);
  const [row] = await ctx.tx.select().from(cyclePlanSkip).where(eq(cyclePlanSkip.id, id));
  if (!row) throw new NotFoundError(`skip ${id}`);
  await ctx.tx.delete(cyclePlanSkip).where(eq(cyclePlanSkip.id, id));
  reportUndo(ctx, {
    label: 'Brought back a skipped period', method: 'POST', path: '/api/cycle-plan-skips',
    body: { planId: row.planId, ...(row.subjectKind && row.subjectId ? { subjectKind: row.subjectKind, subjectId: row.subjectId } : {}), periodStart: row.periodStart, reason: row.reason },
  });
}
