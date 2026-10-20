// What a plan needs from the database to be read (TASK-081): the academic calendar, the units and programs, the node's effective scope
// (TASK-086), the runs already made and the periods already skipped. Loaded once per request and shared by the plan list, the due
// runs and the screens' counts, so every answer comes from the same picture.
import { and, eq, isNotNull } from 'drizzle-orm';
import { cycle, cyclePlan, cyclePlanSkip, orgUnit, program, requirement } from '@ams/db';
import type { CycleAnchorKind } from '@ams/shared';
import { sql } from 'drizzle-orm';
import type { Ctx } from '../ctx.js';
import { referenceVersion, loadAssignments } from '../scope/assignments.js';
import { calendarEntries } from './calendar.js';
import { checkAnchor, dayOf } from './common.js';
import type { Candidate, ScopeLevelUse, Universe } from './plans.js';
import { subjectsFor } from './plans.js';
import type { CalendarEntry } from './recurrence.js';

export type PlanRow = typeof cyclePlan.$inferSelect;
export const subjectKey = (kind: string | null, id: string | null) => (kind && id ? `${kind}:${id}` : '-');

export interface PlanEnv {
  today: string;
  calendar: CalendarEntry[];
  universe: Universe;
  /** Runs made from plans (not cancelled), keyed `${planId}|${subject}|${periodStart}`, and each plan+subject's runs newest first. */
  made: Map<string, string>;
  madeBySubject: Map<string, { id: string; periodStart: string; status: string }[]>;
  skipped: Map<string, string>;
  assignments: Map<string, Awaited<ReturnType<typeof loadAssignments>>>;
  institutionName: string;
}

export const runKey = (planId: string, subject: string, periodStart: string) => `${planId}|${subject}|${periodStart}`;

export async function loadPlanEnv(ctx: Ctx, today: string = dayOf()): Promise<PlanEnv> {
  const calendar = await calendarEntries(ctx);
  const units = await ctx.tx.select({ id: orgUnit.id, name: orgUnit.nameEn, type: orgUnit.type }).from(orgUnit).where(eq(orgUnit.active, true));
  const progs = await ctx.tx.select({ id: program.id, name: program.nameEn, unit: program.orgUnitId, level: program.degreeLevel }).from(program).where(eq(program.active, true));
  const [inst] = (await ctx.tx.execute<{ name_en: string }>(sql`select name_en from institution where id = ${ctx.caller.institutionId}::uuid`)).rows;
  const institutionName = inst?.name_en ?? '';
  const universe: Universe = {
    institution: { kind: 'institution', id: ctx.caller.institutionId, name: institutionName, unitId: null },
    units: units.map((u): Candidate => ({ kind: 'org_unit', id: u.id, name: u.name, unitId: u.id, unitType: u.type })),
    programs: progs.map((p): Candidate => ({ kind: 'program', id: p.id, name: p.name, unitId: p.unit, programLevel: p.level })),
  };
  const made = new Map<string, string>();
  const madeBySubject = new Map<string, { id: string; periodStart: string; status: string }[]>();
  const runs = await ctx.tx.select({ id: cycle.id, planId: cycle.planId, kind: cycle.subjectKind, sid: cycle.subjectId, anchorKind: cycle.anchorKind, anchorId: cycle.anchorId, start: cycle.periodStart, status: cycle.status })
    .from(cycle).where(and(isNotNull(cycle.planId), isNotNull(cycle.periodStart)));
  for (const r of runs) {
    // A run whose subject is the anchor itself (a unit's own cycle) is keyed by the anchor.
    const subject = r.kind && r.sid ? subjectKey(r.kind, r.sid) : subjectKey(r.anchorKind, r.anchorId);
    const k = runKey(r.planId!, subject, r.start!);
    if (r.status !== 'cancelled') made.set(k, r.id);
    const sk = `${r.planId}|${subject}`;
    madeBySubject.set(sk, [...(madeBySubject.get(sk) ?? []), { id: r.id, periodStart: r.start!, status: r.status }]);
  }
  for (const list of madeBySubject.values()) list.sort((a, b) => b.periodStart.localeCompare(a.periodStart));
  const skipped = new Map<string, string>();
  for (const s of await ctx.tx.select().from(cyclePlanSkip)) skipped.set(runKey(s.planId, subjectKey(s.subjectKind, s.subjectId), s.periodStart), s.reason);
  return { today, calendar, universe, made, madeBySubject, skipped, assignments: new Map(), institutionName };
}

/** The anchor a plan's cycles are made about: a standard plan is about the standard's newest published version (or the requirement in it). */
export async function cycleAnchorOf(ctx: Ctx, p: PlanRow): Promise<{ kind: CycleAnchorKind; id: string; name: string | null } | null> {
  if (p.anchorKind === 'framework' || p.anchorKind === 'requirement') {
    const ref = await referenceVersion(ctx, p.anchorFrameworkId!);
    if (!ref) return null;
    if (p.anchorKind === 'framework') return { kind: 'framework_version', id: ref, name: (await checkAnchor(ctx, 'framework_version', ref)).name };
    const [r] = await ctx.tx.select({ id: requirement.id }).from(requirement).where(and(eq(requirement.frameworkVersionId, ref), eq(requirement.code, p.anchorCode!)));
    if (!r) return null;
    return { kind: 'requirement', id: r.id, name: (await checkAnchor(ctx, 'requirement', r.id)).name };
  }
  if (!p.anchorId) return null;
  try {
    return { kind: p.anchorKind as CycleAnchorKind, id: p.anchorId, name: (await checkAnchor(ctx, p.anchorKind as CycleAnchorKind, p.anchorId)).name };
  } catch { return null; }
}

/** The subjects of a plan's runs: its anchor's effective scope narrowed by `appliesTo`; a unit, program or institution plan is about that one thing. */
export async function subjectsOfPlan(ctx: Ctx, env: PlanEnv, p: PlanRow): Promise<Candidate[]> {
  if (p.anchorKind === 'institution') return env.universe.institution ? [env.universe.institution] : [];
  if (p.anchorKind === 'org_unit') return env.universe.units.filter((u) => u.id === p.anchorId);
  if (p.anchorKind === 'program') return env.universe.programs.filter((u) => u.id === p.anchorId);
  if (p.anchorKind === 'requirement') {
    const ref = await referenceVersion(ctx, p.anchorFrameworkId!);
    let all = ref ? env.assignments.get(ref) : undefined;
    if (ref && !all) { all = await loadAssignments(ctx, ref); env.assignments.set(ref, all); }
    const eff = all?.get(p.anchorCode!)?.scope.effective ?? null;
    let levels: ScopeLevelUse[] | null = null;
    if (eff) {
      levels = [];
      for (const l of eff.levels) {
        if (!l.all && l.items.length === 0) continue;   // the units or programs it listed are gone
        levels.push({ kind: l.kind, itemIds: l.all ? [] : l.items.map((i) => i.id) });
      }
    }
    return subjectsFor(env.universe, levels, p.appliesTo);
  }
  return subjectsFor(env.universe, null, p.appliesTo);
}
