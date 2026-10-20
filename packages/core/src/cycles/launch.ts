// Launching a cycle (docs/quality-management-plan.md): from a published template, or blank. The cycle starts as a DRAFT with its
// stages made from the template (the template is copied, so editing it later never changes a cycle): each stage gets its
// responsible unit and owner resolved from the template's rules against the org chart, its dates from the offsets, and its
// inputs wired to the outputs they read (an earlier stage of this cycle, or the subject's previous run). What a rule cannot
// settle is left empty and flagged for a person; nothing is guessed. `activateCycle` (cycles.ts) then starts it.
import { and, desc, eq, sql } from 'drizzle-orm';
import { cycle, cycleInput, cycleOutput, cyclePlan, cycleStage } from '@ams/db';
import type { CycleDetail, LaunchCycle, StageDef, UnitRule } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { reportUndo } from '../trash/store.js';
import { addDays, assertManage, assertPerson, assertUnit, checkAnchor, checkSubject, nfc, nfcOrNull, type CycleRow } from './common.js';
import { loadDetail } from './read.js';
import { makeResolver } from './resolve.js';
import { loadPublishedTemplate } from './templates.js';

/** The subject's latest earlier run of the same template: what this run's `previous_cycle` inputs read. */
async function findPreviousCycle(ctx: Ctx, templateId: string, v: Pick<CycleRow, 'anchorKind' | 'anchorId' | 'subjectKind' | 'subjectId'>): Promise<string | null> {
  const [row] = await ctx.tx.select({ id: cycle.id }).from(cycle).where(and(
    eq(cycle.templateId, templateId), eq(cycle.anchorKind, v.anchorKind), eq(cycle.anchorId, v.anchorId),
    sql`${cycle.subjectKind} is not distinct from ${v.subjectKind}::text`, sql`${cycle.subjectId} is not distinct from ${v.subjectId}::uuid`,
    sql`${cycle.status} in ('active', 'completed')`,
  )).orderBy(desc(cycle.startDate), desc(cycle.createdAt)).limit(1);
  return row?.id ?? null;
}

const defaultTitle = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ');

export async function launchCycle(ctx: Ctx, input: LaunchCycle): Promise<CycleDetail> {
  assertHuman(ctx);
  let tpl: Awaited<ReturnType<typeof loadPublishedTemplate>> | null = null;
  if (input.templateId) {
    tpl = await loadPublishedTemplate(ctx, input.templateId);
    const fits = tpl.row.anchorKinds;
    if (fits.length && !fits.includes(input.anchorKind)) throw new ConflictError(`The template ${tpl.row.name} does not fit a cycle about this kind of thing (it fits: ${fits.join(', ')}).`);
  }
  const anchor = await checkAnchor(ctx, input.anchorKind, input.anchorId);
  const subject = input.subjectKind && input.subjectId ? await checkSubject(ctx, input.subjectKind, input.subjectId) : null;

  // Who does the work: the subject, or the anchor itself when that is an institution, unit or program.
  const worker = subject ?? (input.anchorKind === 'org_unit' || input.anchorKind === 'program' || input.anchorKind === 'institution' ? anchor : null);
  const subjectUnitId = worker?.unitId ?? null;
  const responsibleUnitId = input.responsibleUnitId ?? subjectUnitId;
  if (!responsibleUnitId) throw new ValidationError('Choose the unit responsible for this cycle: it could not be found from what the cycle is about.');
  await assertUnit(ctx, responsibleUnitId, 'The responsible unit');
  await assertManage(ctx, responsibleUnitId);
  const leadUserId = input.leadUserId ?? ctx.caller.userId!;
  await assertPerson(ctx, leadUserId, 'The owner of the cycle');

  let previousCycleId: string | null = null;
  if (input.previousCycleId) {
    const [p] = await ctx.tx.select({ id: cycle.id, templateId: cycle.templateId }).from(cycle).where(eq(cycle.id, input.previousCycleId));
    if (!p) throw new NotFoundError(`cycle ${input.previousCycleId}`);
    previousCycleId = p.id;
  } else if (input.previousCycleId === undefined && tpl && !input.planId) {
    previousCycleId = await findPreviousCycle(ctx, tpl.row.id, { anchorKind: input.anchorKind, anchorId: input.anchorId, subjectKind: input.subjectKind, subjectId: input.subjectId });
  }

  // A run a plan proposed (TASK-081): it names the plan and the period; the previous run is the subject's previous run of THIS plan.
  let planId: string | null = null;
  let periodStart: string | null = null;
  if (input.planId) {
    const [plan] = await ctx.tx.select().from(cyclePlan).where(eq(cyclePlan.id, input.planId));
    if (!plan) throw new NotFoundError(`plan ${input.planId}`);
    if (!input.periodStart) throw new ValidationError('Name the start of the period this run covers.');
    if (tpl && tpl.row.id !== plan.templateId) throw new ValidationError('That template is not the one of the plan.');
    const subjectRef = input.subjectKind && input.subjectId ? `${input.subjectKind}:${input.subjectId}` : `${input.anchorKind}:${input.anchorId}`;
    const [dup] = await ctx.tx.select({ id: cycle.id }).from(cycle).where(and(
      eq(cycle.planId, plan.id), eq(cycle.periodStart, input.periodStart), sql`${cycle.status} <> 'cancelled'`,
      sql`coalesce(${cycle.subjectKind} || ':' || ${cycle.subjectId}::text, ${cycle.anchorKind} || ':' || ${cycle.anchorId}::text) = ${subjectRef}`,
    )).limit(1);
    if (dup) throw new ConflictError('A run for that period was already launched.');
    planId = plan.id; periodStart = input.periodStart;
    if (input.previousCycleId === undefined) {
      const [prev] = await ctx.tx.select({ id: cycle.id }).from(cycle).where(and(
        eq(cycle.planId, plan.id), sql`${cycle.periodStart} < ${input.periodStart}::date`, sql`${cycle.status} in ('active', 'completed')`,
        sql`coalesce(${cycle.subjectKind} || ':' || ${cycle.subjectId}::text, ${cycle.anchorKind} || ':' || ${cycle.anchorId}::text) = ${subjectRef}`,
      )).orderBy(desc(cycle.periodStart)).limit(1);
      previousCycleId = prev?.id ?? null;
    }
  }

  const subjectName = subject?.name ?? null;
  const title = nfc(input.title ?? (defaultTitle([tpl?.row.name, subjectName ?? anchor.name, input.periodLabel]) || 'New cycle'));
  const [row] = await guardIntegrity(() => ctx.tx.insert(cycle).values({
    institutionId: ctx.caller.institutionId, title, templateId: tpl?.row.id ?? null, templateVersion: tpl?.row.version ?? null,
    anchorKind: input.anchorKind, anchorId: input.anchorId, subjectKind: input.subjectKind, subjectId: input.subjectId,
    responsibleUnitId, leadUserId, status: 'draft', startDate: input.startDate, previousCycleId, periodLabel: nfcOrNull(input.periodLabel), origin: input.origin, planId, periodStart,
  }).returning());

  if (tpl) await buildStages(ctx, row!, tpl.stages, { subjectUnitId, previousCycleId });

  // The cycle ends when its last stage does.
  const [end] = (await ctx.tx.execute<{ e: string | null }>(sql`select max(end_date)::text as e from cycle_stage where cycle_id = ${row!.id}`)).rows;
  if (end?.e) await ctx.tx.update(cycle).set({ endDate: end.e }).where(eq(cycle.id, row!.id));

  reportUndo(ctx, { label: `Created the cycle ${title}`, method: 'DELETE', path: `/api/cycles/${row!.id}` });
  return loadDetail(ctx, (await ctx.tx.select().from(cycle).where(eq(cycle.id, row!.id)))[0]!);
}

async function buildStages(ctx: Ctx, c: CycleRow, defs: StageDef[], opts: { subjectUnitId: string | null; previousCycleId: string | null }): Promise<void> {
  const resolver = await makeResolver(ctx, { cycleUnitId: c.responsibleUnitId, subjectUnitId: opts.subjectUnitId, leadUserId: c.leadUserId });
  const stageIds = new Map<string, string>();
  const outputIds = new Map<string, string>();   // `${stageKey}/${outputKey}`

  for (const [i, def] of defs.entries()) {
    const unit = resolver.unit(def.unit as UnitRule);
    const unitUnresolved = unit === null;
    const stageUnit = unit ?? c.responsibleUnitId;
    // A rule that needs the unit cannot be settled when the unit could not be; the cycle's own lead needs no unit.
    const personFor = (rule: StageDef['owner']) => (rule.kind === 'cycle_lead' ? resolver.person(rule, null) : unitUnresolved ? null : resolver.person(rule, unit));
    const owner = personFor(def.owner);
    const start = addDays(c.startDate, def.startOffsetDays);
    const [stage] = await guardIntegrity(() => ctx.tx.insert(cycleStage).values({
      institutionId: c.institutionId, cycleId: c.id, key: def.key, name: nfc(def.name), nameAr: nfcOrNull(def.nameAr), process: def.process.normalize('NFC'),
      checklist: def.checklist.map((text) => ({ text: nfc(text), done: false, doneBy: null, doneAt: null })), displayOrder: i,
      responsibleUnitId: stageUnit, unitUnresolved, ownerUserId: owner, ownerUnresolved: owner === null,
      startDate: start, endDate: addDays(start, def.lengthDays),
    }).returning());
    stageIds.set(def.key, stage!.id);
    for (const [j, o] of def.outputs.entries()) {
      const approver = o.kind === 'approval' ? (o.approver ? personFor(o.approver) : null) : null;
      const [out] = await guardIntegrity(() => ctx.tx.insert(cycleOutput).values({
        institutionId: c.institutionId, stageId: stage!.id, key: o.key, name: nfc(o.name), kind: o.kind, required: o.required, displayOrder: j,
        reportTemplateKey: o.kind === 'report' ? (o.reportTemplateKey ?? null) : null,
        approverUserId: approver, approverUnresolved: o.kind === 'approval' && approver === null,
      }).returning());
      outputIds.set(`${def.key}/${o.key}`, out!.id);
    }
  }

  // The previous run's outputs, by stage and output key.
  const previous = new Map<string, string>();
  if (opts.previousCycleId) {
    const rows = (await ctx.tx.execute<{ stage_key: string; output_key: string; id: string }>(sql`
      select s.key as stage_key, o.key as output_key, o.id from cycle_output o join cycle_stage s on s.id = o.stage_id where s.cycle_id = ${opts.previousCycleId}::uuid`)).rows;
    for (const r of rows) previous.set(`${r.stage_key}/${r.output_key}`, r.id);
  }

  for (const def of defs) {
    for (const [j, inp] of def.inputs.entries()) {
      const base = { institutionId: c.institutionId, stageId: stageIds.get(def.key)!, key: inp.key, name: nfc(inp.name), required: inp.required, displayOrder: j };
      const from = inp.from;
      if ('stage' in from) {
        await guardIntegrity(() => ctx.tx.insert(cycleInput).values({ ...base, source: 'stage_output', outputId: outputIds.get(`${from.stage}/${from.output}`) ?? null }));
      } else if ('previousCycle' in from) {
        const pc = from.previousCycle;
        await guardIntegrity(() => ctx.tx.insert(cycleInput).values({ ...base, source: 'previous_cycle', outputId: previous.get(`${pc.stage}/${pc.output}`) ?? null }));
      } else {
        await guardIntegrity(() => ctx.tx.insert(cycleInput).values({ ...base, source: 'pick', pickKind: from.pick }));
      }
    }
  }
}
