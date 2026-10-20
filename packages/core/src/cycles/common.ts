// Shared helpers of the cycle services (TASK-078): loading, who may do what, the anchors a cycle can be about, dates.
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { appUser, cycle, cycleInput, cycleOutput, cycleStage, evidenceItem, importDocument, orgUnit, program, requirement } from '@ams/db';
import type { CycleAnchorKind, CycleRefKind, CycleSubjectKind } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { isPermitted } from '../permissions.js';
import { ForbiddenError } from '../ctx.js';

export type CycleRow = typeof cycle.$inferSelect;
export type StageRow = typeof cycleStage.$inferSelect;
export type OutputRow = typeof cycleOutput.$inferSelect;
export type InputRow = typeof cycleInput.$inferSelect;

export const nfc = (s: string) => s.normalize('NFC').trim();
export const nfcOrNull = (s: string | null | undefined) => (s ? nfc(s) || null : null);

/** The calendar date `YYYY-MM-DD` of a moment (UTC), and `n` days after one. */
export const dayOf = (d: Date = new Date()) => d.toISOString().slice(0, 10);
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return dayOf(d);
}

export async function loadCycle(ctx: Ctx, id: string): Promise<CycleRow> {
  const [row] = await ctx.tx.select().from(cycle).where(eq(cycle.id, id));
  if (!row) throw new NotFoundError(`cycle ${id}`);
  return row;
}
export async function loadStage(ctx: Ctx, id: string): Promise<{ stage: StageRow; cycle: CycleRow }> {
  const [stage] = await ctx.tx.select().from(cycleStage).where(eq(cycleStage.id, id));
  if (!stage) throw new NotFoundError(`stage ${id}`);
  return { stage, cycle: await loadCycle(ctx, stage.cycleId) };
}
export async function loadOutput(ctx: Ctx, id: string): Promise<{ output: OutputRow; stage: StageRow; cycle: CycleRow }> {
  const [output] = await ctx.tx.select().from(cycleOutput).where(eq(cycleOutput.id, id));
  if (!output) throw new NotFoundError(`output ${id}`);
  const { stage, cycle: c } = await loadStage(ctx, output.stageId);
  return { output, stage, cycle: c };
}
export async function loadInput(ctx: Ctx, id: string): Promise<{ input: InputRow; stage: StageRow; cycle: CycleRow }> {
  const [input] = await ctx.tx.select().from(cycleInput).where(eq(cycleInput.id, id));
  if (!input) throw new NotFoundError(`input ${id}`);
  const { stage, cycle: c } = await loadStage(ctx, input.stageId);
  return { input, stage, cycle: c };
}
export const stagesOf = (ctx: Ctx, cycleId: string) => ctx.tx.select().from(cycleStage).where(eq(cycleStage.cycleId, cycleId)).orderBy(asc(cycleStage.displayOrder), asc(cycleStage.createdAt), asc(cycleStage.id));

// ---- Who may do what -------------------------------------------------------------------------------------------------------
// `cycle:manage` and `cycle:work` are scoped by the org chart: a grant at a unit covers that unit and everything beneath it. A
// cycle is managed where its responsible unit is; a stage is worked where its responsible unit is. A stage's owner can always
// work it; an approval's named approver can always decide it (the database insists on that too).

export const mayManage = (ctx: Ctx, unitId: string) => isPermitted(ctx.tx, 'cycle:manage', { type: 'org_unit', id: unitId });
export async function assertManage(ctx: Ctx, unitId: string): Promise<void> {
  if (!(await mayManage(ctx, unitId))) throw new ForbiddenError('Missing permission cycle:manage');
}
export async function mayWork(ctx: Ctx, stage: Pick<StageRow, 'ownerUserId' | 'responsibleUnitId'>, c: Pick<CycleRow, 'responsibleUnitId'>): Promise<boolean> {
  if (stage.ownerUserId && stage.ownerUserId === ctx.caller.userId) return true;
  return (await isPermitted(ctx.tx, 'cycle:work', { type: 'org_unit', id: stage.responsibleUnitId }))
    || (await mayManage(ctx, c.responsibleUnitId));
}
export async function assertWork(ctx: Ctx, stage: StageRow, c: CycleRow): Promise<void> {
  if (!(await mayWork(ctx, stage, c))) throw new ForbiddenError('Only the owner of this stage, or someone with cycle:work for its unit, can do this');
}

/** A cycle that is not running (draft) or is over (completed, cancelled) refuses work with a plain reason. */
export function assertActive(c: CycleRow, what = 'work on its stages'): void {
  if (c.status === 'active') return;
  throw new ConflictError(c.status === 'draft' ? `Launch the cycle before you ${what}.` : `The cycle is ${c.status}; you can no longer ${what}.`);
}
export function assertDraft(c: CycleRow, what: string): void {
  if (c.status !== 'draft') throw new ConflictError(`${what} only while the cycle is a draft.`);
}

// ---- Anchors, subjects and picked references ---------------------------------------------------------------------------------

export interface RefInfo { name: string | null; /** For a unit or a program: the org unit it stands for. */ unitId: string | null; /** For an evidence item: its owner (a person), if it has one. */ ownerUserId?: string | null }

/**
 * What a cycle can be about is checked here, per kind, because the id is polymorphic (like engagement.subject_id). Row-level
 * security means an id from another institution simply does not exist for the caller.
 */
export async function checkAnchor(ctx: Ctx, kind: CycleAnchorKind, id: string): Promise<RefInfo> {
  const none = (what: string): never => { throw new ValidationError(`${what} not found: a cycle can only be about something of this institution`); };
  switch (kind) {
    case 'institution': {
      if (id !== ctx.caller.institutionId) return none('the institution');
      const [r] = (await ctx.tx.execute<{ name_en: string }>(sql`select name_en from institution where id = ${id}::uuid`)).rows;
      return { name: r?.name_en ?? null, unitId: null };
    }
    case 'org_unit': {
      const [r] = await ctx.tx.select({ name: orgUnit.nameEn, active: orgUnit.active }).from(orgUnit).where(eq(orgUnit.id, id));
      if (!r) return none('the unit');
      return { name: r.name, unitId: id };
    }
    case 'program': {
      const [r] = await ctx.tx.select({ name: program.nameEn, unit: program.orgUnitId }).from(program).where(eq(program.id, id));
      if (!r) return none('the program');
      return { name: r.name, unitId: r.unit };
    }
    case 'framework_version': {
      const [r] = (await ctx.tx.execute<{ name: string; edition: string }>(sql`select f.name, v.edition from framework_version v join framework f on f.id = v.framework_id where v.id = ${id}::uuid`)).rows;
      if (!r) return none('the standard version');
      return { name: `${r.name} ${r.edition}`, unitId: null };
    }
    case 'requirement': {
      const [r] = await ctx.tx.select({ code: requirement.code, title: requirement.title }).from(requirement).where(eq(requirement.id, id));
      if (!r) return none('the standard');
      return { name: `${r.code} ${r.title}`, unitId: null };
    }
    case 'evidence_item': {
      const [r] = await ctx.tx.select({ title: evidenceItem.title, unit: evidenceItem.ownerUnitId, owner: evidenceItem.ownerUserId }).from(evidenceItem).where(eq(evidenceItem.id, id));
      if (!r) return none('the evidence item');
      return { name: r.title, unitId: r.unit, ownerUserId: r.owner };
    }
    case 'engagement': {
      const [r] = (await ctx.tx.execute<{ title: string }>(sql`select title from engagement where id = ${id}::uuid`)).rows;
      if (!r) return none('the accreditation');
      return { name: r.title, unitId: null };
    }
  }
}

export async function checkSubject(ctx: Ctx, kind: CycleSubjectKind, id: string): Promise<RefInfo> {
  return checkAnchor(ctx, kind, id);
}

/** What a picked input may point at; checked here for the same reason. */
export async function checkRef(ctx: Ctx, kind: CycleRefKind, id: string): Promise<string | null> {
  const none = (): never => { throw new ValidationError(`that ${kind.replace('_', ' ')} was not found in this institution`); };
  if (kind === 'document') { const [r] = await ctx.tx.select({ n: importDocument.fileName }).from(importDocument).where(eq(importDocument.id, id)); return r ? r.n : none(); }
  if (kind === 'evidence_item') { const [r] = await ctx.tx.select({ n: evidenceItem.title }).from(evidenceItem).where(eq(evidenceItem.id, id)); return r ? r.n : none(); }
  const [r] = await ctx.tx.select({ code: requirement.code, title: requirement.title }).from(requirement).where(eq(requirement.id, id));
  return r ? `${r.code} ${r.title}` : none();
}

export async function assertPerson(ctx: Ctx, userId: string, what: string): Promise<void> {
  const [p] = await ctx.tx.select({ active: appUser.active }).from(appUser).where(eq(appUser.id, userId));
  if (!p) throw new ValidationError(`${what} must be a person of this institution`);
  if (!p.active) throw new ConflictError(`${what}: that person is inactive`);
}
export async function assertUnit(ctx: Ctx, unitId: string, what: string): Promise<void> {
  const [u] = await ctx.tx.select({ active: orgUnit.active }).from(orgUnit).where(eq(orgUnit.id, unitId));
  if (!u) throw new ValidationError(`${what} must be a unit of this institution`);
  if (!u.active) throw new ConflictError(`${what}: that unit is inactive`);
}

/** The key for a new stage/output/input made by hand: the name in snake case, made unique among `taken`. */
export function keyFrom(name: string, taken: Set<string>, given?: string): string {
  if (given) return given;
  const base = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/^[^a-z]+/, '') || 'item';
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base.slice(0, 44)}_${n}`;
  return key;
}


/**
 * The responsible unit of a cycle when nobody names one (DEC-030: a cycle has one owner; the unit is derived, never asked). The first
 * that exists, deterministically: the unit that owns the evidence item the cycle is about, then a unit its owner heads, then a unit
 * its owner holds a role in (by name), then the institution's top unit (no parent; first by position). Inactive units are skipped.
 */
export async function deriveResponsibleUnit(ctx: Ctx, opts: { evidenceUnitId?: string | null; ownerUserId: string }): Promise<string | null> {
  if (opts.evidenceUnitId) {
    const [u] = await ctx.tx.select({ id: orgUnit.id }).from(orgUnit).where(and(eq(orgUnit.id, opts.evidenceUnitId), eq(orgUnit.active, true)));
    if (u) return u.id;
  }
  const headed = await ctx.tx.select({ id: orgUnit.id }).from(orgUnit).where(and(eq(orgUnit.headUserId, opts.ownerUserId), eq(orgUnit.active, true))).orderBy(asc(orgUnit.nameEn), asc(orgUnit.id)).limit(1);
  if (headed[0]) return headed[0].id;
  const held = (await ctx.tx.execute<{ id: string }>(sql`
    select u.id from role_assignment r join org_unit u on u.id = r.scope_id
    where r.user_id = ${opts.ownerUserId}::uuid and r.scope_type = 'org_unit' and u.active and (r.expires_at is null or r.expires_at > now())
    order by u.name_en, u.id limit 1`)).rows[0];
  if (held) return held.id;
  const top = await ctx.tx.select({ id: orgUnit.id }).from(orgUnit).where(and(isNull(orgUnit.parentId), eq(orgUnit.active, true))).orderBy(asc(orgUnit.displayOrder), asc(orgUnit.createdAt), asc(orgUnit.id)).limit(1);
  return top[0]?.id ?? null;
}
