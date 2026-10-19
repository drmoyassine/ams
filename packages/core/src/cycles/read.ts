// Reading cycles: the list (with the anchor, subject, unit, template and people named) and one cycle with its stages, outputs and
// inputs. Everyone with cycle:read sees every cycle of the institution (row-level security keeps tenants apart).
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  appUser, cycle, cycleInput, cycleOutput, cycleStage, cycleTemplate, evidenceItem, importDocument, orgUnit, program, requirement,
} from '@ams/db';
import {
  CYCLE_DECISION_LABELS, type CycleAnchorKind, type CycleDetail, type CycleFilter, type CycleInput, type CycleOutput, type CycleStage, type CycleSummary,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { NotFoundError } from '../ctx.js';
import { assertPermitted, isPermitted } from '../permissions.js';
import { uuids } from '../trash/rows.js';
import { dayOf, loadCycle, mayManage, type CycleRow, type InputRow, type OutputRow, type StageRow } from './common.js';

const uniq = <T>(xs: (T | null | undefined)[]): T[] => [...new Set(xs.filter((x): x is T => x != null))];

/** Names of org units and people by id. */
async function unitNames(ctx: Ctx, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await ctx.tx.select({ id: orgUnit.id, name: orgUnit.nameEn }).from(orgUnit).where(inArray(orgUnit.id, ids));
  return new Map(rows.map((r) => [r.id, r.name] as const));
}
async function userNames(ctx: Ctx, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await ctx.tx.select({ id: appUser.id, name: appUser.fullName }).from(appUser).where(inArray(appUser.id, ids));
  return new Map(rows.map((r) => [r.id, r.name] as const));
}

/** The display name of each anchor or subject, by kind then id. A thing that no longer exists has no name (null). */
export async function anchorNames(ctx: Ctx, refs: { kind: CycleAnchorKind; id: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const of = (k: CycleAnchorKind) => uniq(refs.filter((r) => r.kind === k).map((r) => r.id));
  const key = (k: string, id: string) => `${k}:${id}`;
  const [units, programs, reqs, evs] = await Promise.all([
    of('org_unit').length ? unitNames(ctx, of('org_unit')) : new Map<string, string>(),
    of('program').length ? ctx.tx.select({ id: program.id, name: program.nameEn }).from(program).where(inArray(program.id, of('program'))) : [],
    of('requirement').length ? ctx.tx.select({ id: requirement.id, code: requirement.code, title: requirement.title }).from(requirement).where(inArray(requirement.id, of('requirement'))) : [],
    of('evidence_item').length ? ctx.tx.select({ id: evidenceItem.id, name: evidenceItem.title }).from(evidenceItem).where(inArray(evidenceItem.id, of('evidence_item'))) : [],
  ]);
  for (const [id, name] of units) out.set(key('org_unit', id), name);
  for (const r of programs) out.set(key('program', r.id), r.name);
  for (const r of reqs) out.set(key('requirement', r.id), `${r.code} ${r.title}`);
  for (const r of evs) out.set(key('evidence_item', r.id), r.name);
  if (of('institution').length) {
    const rows = (await ctx.tx.execute<{ id: string; name_en: string }>(sql`select id, name_en from institution where id = any(${uuids(of('institution'))})`)).rows;
    for (const r of rows) out.set(key('institution', r.id), r.name_en);
  }
  if (of('framework_version').length) {
    const rows = (await ctx.tx.execute<{ id: string; name: string; edition: string }>(sql`select v.id, f.name, v.edition from framework_version v join framework f on f.id = v.framework_id where v.id = any(${uuids(of('framework_version'))})`)).rows;
    for (const r of rows) out.set(key('framework_version', r.id), `${r.name} ${r.edition}`);
  }
  if (of('engagement').length) {
    const rows = (await ctx.tx.execute<{ id: string; title: string }>(sql`select id, title from engagement where id = any(${uuids(of('engagement'))})`)).rows;
    for (const r of rows) out.set(key('engagement', r.id), r.title);
  }
  return out;
}
const aKey = (kind: string, id: string) => `${kind}:${id}`;

/** Summaries of these cycles, in the order given. */
export async function summariesOf(ctx: Ctx, rows: CycleRow[]): Promise<CycleSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [units, users, templates, anchors, stats] = await Promise.all([
    unitNames(ctx, uniq(rows.map((r) => r.responsibleUnitId))),
    userNames(ctx, uniq(rows.map((r) => r.leadUserId))),
    (async () => {
      const tids = uniq(rows.map((r) => r.templateId));
      if (!tids.length) return new Map<string, string>();
      const t = await ctx.tx.select({ id: cycleTemplate.id, name: cycleTemplate.name }).from(cycleTemplate).where(inArray(cycleTemplate.id, tids));
      return new Map(t.map((x) => [x.id, x.name] as const));
    })(),
    anchorNames(ctx, [...rows.map((r) => ({ kind: r.anchorKind, id: r.anchorId })), ...rows.filter((r) => r.subjectKind && r.subjectId).map((r) => ({ kind: r.subjectKind!, id: r.subjectId! }))]),
    ctx.tx.execute<{ cycle_id: string; stages: number; done: number; unresolved: number }>(sql`
      select s.cycle_id, count(*)::int as stages,
             count(*) filter (where s.status in ('completed', 'skipped'))::int as done,
             (count(*) filter (where s.owner_unresolved or s.unit_unresolved)
              + (select count(*) from cycle_output o where o.stage_id in (select id from cycle_stage where cycle_id = s.cycle_id) and o.approver_unresolved))::int as unresolved
      from cycle_stage s where s.cycle_id = any(${uuids(ids)}) group by s.cycle_id`),
  ]);
  const st = new Map(stats.rows.map((r) => [r.cycle_id, r] as const));
  return rows.map((r) => ({
    id: r.id, title: r.title, templateId: r.templateId, templateName: r.templateId ? (templates.get(r.templateId) ?? null) : null, templateVersion: r.templateVersion,
    anchorKind: r.anchorKind, anchorId: r.anchorId, anchorName: anchors.get(aKey(r.anchorKind, r.anchorId)) ?? null,
    subjectKind: r.subjectKind, subjectId: r.subjectId, subjectName: r.subjectKind && r.subjectId ? (anchors.get(aKey(r.subjectKind, r.subjectId)) ?? null) : null,
    responsibleUnitId: r.responsibleUnitId, responsibleUnitName: units.get(r.responsibleUnitId) ?? null,
    leadUserId: r.leadUserId, leadName: users.get(r.leadUserId) ?? null,
    status: r.status, cancelReason: r.cancelReason, startDate: r.startDate, endDate: r.endDate, periodLabel: r.periodLabel,
    previousCycleId: r.previousCycleId, parentCycleId: r.parentCycleId, parentStageId: r.parentStageId, origin: r.origin,
    stageCount: st.get(r.id)?.stages ?? 0, stagesDone: st.get(r.id)?.done ?? 0, unresolvedCount: st.get(r.id)?.unresolved ?? 0,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** The cycles, newest first, with optional filters (anchor, subject, unit, status, a person, template, words in the title). */
export async function listCycles(ctx: Ctx, filter: CycleFilter = {}): Promise<CycleSummary[]> {
  await assertPermitted(ctx, 'cycle:read', { type: 'any' });
  const where: (SQL | undefined)[] = [];
  if (filter.anchorKind) where.push(eq(cycle.anchorKind, filter.anchorKind));
  if (filter.anchorId) where.push(eq(cycle.anchorId, filter.anchorId));
  if (filter.subjectKind) where.push(eq(cycle.subjectKind, filter.subjectKind));
  if (filter.subjectId) where.push(eq(cycle.subjectId, filter.subjectId));
  if (filter.unitId) where.push(or(eq(cycle.responsibleUnitId, filter.unitId), sql`exists (select 1 from cycle_stage s where s.cycle_id = ${cycle.id} and s.responsible_unit_id = ${filter.unitId}::uuid)`));
  if (filter.status) where.push(eq(cycle.status, filter.status));
  if (filter.templateId) where.push(eq(cycle.templateId, filter.templateId));
  if (filter.ownerId) where.push(or(eq(cycle.leadUserId, filter.ownerId), sql`exists (select 1 from cycle_stage s where s.cycle_id = ${cycle.id} and s.owner_user_id = ${filter.ownerId}::uuid)`));
  const q = filter.q?.trim();
  if (q) where.push(ilike(cycle.title, `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`));
  const rows = await ctx.tx.select().from(cycle).where(and(...where)).orderBy(desc(cycle.startDate), desc(cycle.createdAt), asc(cycle.id));
  return summariesOf(ctx, rows);
}

/** Outputs and inputs of stages, in a stable order, with the people and the wired outputs named. */
async function stageParts(ctx: Ctx, stages: StageRow[]): Promise<{ outputs: OutputRow[]; inputs: InputRow[] }> {
  if (!stages.length) return { outputs: [], inputs: [] };
  const ids = stages.map((s) => s.id);
  const [outputs, inputs] = await Promise.all([
    ctx.tx.select().from(cycleOutput).where(inArray(cycleOutput.stageId, ids)).orderBy(asc(cycleOutput.displayOrder), asc(cycleOutput.createdAt), asc(cycleOutput.id)),
    ctx.tx.select().from(cycleInput).where(inArray(cycleInput.stageId, ids)).orderBy(asc(cycleInput.displayOrder), asc(cycleInput.createdAt), asc(cycleInput.id)),
  ]);
  return { outputs, inputs };
}

export async function stageDtos(ctx: Ctx, c: CycleRow, stages: StageRow[]): Promise<CycleStage[]> {
  const { outputs, inputs } = await stageParts(ctx, stages);
  // Outputs the inputs read may live in this cycle or in the previous one.
  const wired = uniq(inputs.map((i) => i.outputId));
  const wiredRows = wired.length
    ? (await ctx.tx.execute<{ id: string; name: string; state: OutputRow['state']; stage_name: string; cycle_id: string }>(sql`
        select o.id, o.name, o.state, s.name as stage_name, s.cycle_id from cycle_output o join cycle_stage s on s.id = o.stage_id where o.id = any(${uuids(wired)})`)).rows
    : [];
  const wiredBy = new Map(wiredRows.map((r) => [r.id, r] as const));
  const [units, users] = await Promise.all([
    unitNames(ctx, uniq(stages.map((s) => s.responsibleUnitId))),
    userNames(ctx, uniq([...stages.map((s) => s.ownerUserId), ...outputs.map((o) => o.approverUserId), ...outputs.map((o) => o.finalisedBy)])),
  ]);
  // Names of what picks point at.
  const refNames = new Map<string, string>();
  for (const [kind, table, col, name] of [
    ['document', importDocument, importDocument.id, importDocument.fileName], ['evidence_item', evidenceItem, evidenceItem.id, evidenceItem.title],
  ] as const) {
    const refIds = uniq(inputs.filter((i) => i.refKind === kind).map((i) => i.refId));
    if (!refIds.length) continue;
    const rows = await ctx.tx.select({ id: col, name }).from(table).where(inArray(col, refIds));
    for (const r of rows) refNames.set(`${kind}:${r.id}`, r.name);
  }
  const reqIds = uniq(inputs.filter((i) => i.refKind === 'requirement').map((i) => i.refId));
  if (reqIds.length) for (const r of await ctx.tx.select({ id: requirement.id, code: requirement.code, title: requirement.title }).from(requirement).where(inArray(requirement.id, reqIds))) refNames.set(`requirement:${r.id}`, `${r.code} ${r.title}`);

  const me = ctx.caller.userId;
  const today = dayOf();
  const unitPerm = new Map<string, boolean>();
  const mayWorkUnit = async (unitId: string) => {
    if (!unitPerm.has(unitId)) unitPerm.set(unitId, await isPermitted(ctx.tx, 'cycle:work', { type: 'org_unit', id: unitId }));
    return unitPerm.get(unitId)!;
  };
  const manage = await mayManage(ctx, c.responsibleUnitId);

  const outputDto = (o: OutputRow, s: StageRow): CycleOutput => ({
    id: o.id, stageId: o.stageId, key: o.key, name: o.name, kind: o.kind, required: o.required, state: o.state,
    reportTemplateKey: o.reportTemplateKey, reportId: o.reportId, reportPending: o.kind === 'report' && o.reportId === null,
    file: o.fileKey ? { name: o.fileName ?? 'file', mime: o.fileMime ?? 'application/octet-stream', size: o.fileSize ?? 0 } : null,
    note: o.note, approverUserId: o.approverUserId, approverName: o.approverUserId ? (users.get(o.approverUserId) ?? null) : null, approverUnresolved: o.approverUnresolved,
    decision: o.decision, decisionLabel: o.decision ? CYCLE_DECISION_LABELS[o.decision] : null, decisionComment: o.decisionComment,
    finalisedBy: o.finalisedBy, finalisedByName: o.finalisedBy ? (users.get(o.finalisedBy) ?? null) : null, finalisedAt: o.finalisedAt?.toISOString() ?? null,
    canDecide: o.kind === 'approval' && !!me && o.approverUserId === me && c.status === 'active' && s.status === 'in_progress' && o.state !== 'final',
  });
  const inputDto = (i: InputRow): CycleInput => {
    const w = i.outputId ? wiredBy.get(i.outputId) : undefined;
    const satisfied = i.source === 'pick' ? i.refId !== null : w?.state === 'final';
    return {
      id: i.id, stageId: i.stageId, key: i.key, name: i.name, source: i.source, required: i.required,
      outputId: i.outputId, outputName: w?.name ?? null, outputState: w?.state ?? null, outputStageName: w?.stage_name ?? null, outputCycleId: w?.cycle_id ?? null,
      pickKind: i.pickKind, refKind: i.refKind, refId: i.refId, refName: i.refKind && i.refId ? (refNames.get(`${i.refKind}:${i.refId}`) ?? null) : null,
      satisfied: !!satisfied, previousMissing: i.source === 'previous_cycle' && !i.outputId,
    };
  };
  const out: CycleStage[] = [];
  for (const s of stages) {
    out.push({
      id: s.id, cycleId: s.cycleId, key: s.key, name: s.name, nameAr: s.nameAr, process: s.process,
      checklist: (s.checklist as CycleStage['checklist']) ?? [], displayOrder: s.displayOrder,
      responsibleUnitId: s.responsibleUnitId, responsibleUnitName: units.get(s.responsibleUnitId) ?? null, unitUnresolved: s.unitUnresolved,
      ownerUserId: s.ownerUserId, ownerName: s.ownerUserId ? (users.get(s.ownerUserId) ?? null) : null, ownerUnresolved: s.ownerUnresolved,
      startDate: s.startDate, endDate: s.endDate, status: s.status, skipReason: s.skipReason, startedAt: s.startedAt?.toISOString() ?? null, completedAt: s.completedAt?.toISOString() ?? null,
      outputs: outputs.filter((o) => o.stageId === s.id).map((o) => outputDto(o, s)), inputs: inputs.filter((i) => i.stageId === s.id).map(inputDto),
      canWork: c.status === 'active' && (s.status === 'in_progress' || s.status === 'not_started') && (manage || (!!me && s.ownerUserId === me) || (await mayWorkUnit(s.responsibleUnitId))),
      late: c.status === 'active' && (s.status === 'not_started' || s.status === 'in_progress') && s.endDate !== null && s.endDate < today,
    });
  }
  return out;
}

/** One cycle with its stages, outputs and inputs. */
export async function getCycle(ctx: Ctx, id: string): Promise<CycleDetail> {
  await assertPermitted(ctx, 'cycle:read', { type: 'any' });
  return loadDetail(ctx, await loadCycle(ctx, id));
}

export async function loadDetail(ctx: Ctx, c: CycleRow): Promise<CycleDetail> {
  const [summary] = await summariesOf(ctx, [c]);
  const stages = await ctx.tx.select().from(cycleStage).where(eq(cycleStage.cycleId, c.id)).orderBy(asc(cycleStage.displayOrder), asc(cycleStage.createdAt), asc(cycleStage.id));
  return { ...summary!, stages: await stageDtos(ctx, c, stages), canManage: await mayManage(ctx, c.responsibleUnitId) };
}

/** The inputs of one stage with what each points at and whether it is satisfied. */
export async function listStageInputs(ctx: Ctx, stageId: string): Promise<CycleInput[]> {
  await assertPermitted(ctx, 'cycle:read', { type: 'any' });
  const [stage] = await ctx.tx.select().from(cycleStage).where(eq(cycleStage.id, stageId));
  if (!stage) throw new NotFoundError(`stage ${stageId}`);
  const [dto] = await stageDtos(ctx, await loadCycle(ctx, stage.cycleId), [stage]);
  return dto!.inputs;
}
