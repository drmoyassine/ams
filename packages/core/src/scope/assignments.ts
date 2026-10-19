// Scope and champion of a requirement (TASK-086): what a person sets (outside the frozen version tables, so a published version
// can be assigned too; keyed by standard and code, so it carries over to the next version), and what each requirement of a
// version ends up with after inheritance (resolve.ts) described for the screen in one batched answer.
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { appUser, framework, frameworkVersion, orgUnit, program, requirement, requirementChampion, requirementMapping, requirementScope, scopeLevel } from '@ams/db';
import {
  itemKey, SetRequirementChampionSchema, SetRequirementScopeSchema,
  type AssignmentSource, type ClearRequirementChampion, type EffectiveChampion, type EffectiveScope, type NodeAssignment, type OwnAssignment, type OwnChampion, type RequirementTarget,
  type ScopeItemKind, type SetRequirementChampion, type SetRequirementScope,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman, getVersion, require_ } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { reportUndo } from '../trash/store.js';
import { resolveTree, type MappedNode, type Own, type Resolved, type TreeNode } from './resolve.js';

const any = { type: 'any' } as const;
const SCOPE_PATH = '/api/requirement-scope';
const CHAMPION_PATH = '/api/requirement-champion';

// ---- Reading --------------------------------------------------------------------------------------------------------------

async function treeOf(ctx: Ctx, versionId: string): Promise<TreeNode[]> {
  const rows = await ctx.tx.select({ id: requirement.id, code: requirement.code, parentId: requirement.parentId }).from(requirement).where(eq(requirement.frameworkVersionId, versionId));
  const codeOf = new Map(rows.map((r) => [r.id, r.code]));
  return rows.map((r) => ({ code: r.code, parentCode: r.parentId ? codeOf.get(r.parentId) ?? null : null }));
}

/** The version whose tree stands for a standard: its newest published version, else its newest. */
async function referenceVersion(ctx: Ctx, frameworkId: string): Promise<string | null> {
  const versions = await ctx.tx.select({ id: frameworkVersion.id, status: frameworkVersion.status }).from(frameworkVersion)
    .where(eq(frameworkVersion.frameworkId, frameworkId)).orderBy(desc(frameworkVersion.createdAt));
  return (versions.find((v) => v.status === 'published') ?? versions[0])?.id ?? null;
}

/** What is set on a standard's requirements, by code. */
async function ownOf(ctx: Ctx, frameworkId: string): Promise<Map<string, Own>> {
  const out = new Map<string, Own>();
  const at = (code: string) => { let o = out.get(code); if (!o) { o = { scope: null, champions: [] }; out.set(code, o); } return o; };
  for (const s of await ctx.tx.select().from(requirementScope).where(eq(requirementScope.frameworkId, frameworkId))) at(s.code).scope = { levelKey: s.levelKey, itemIds: s.itemIds };
  for (const c of await ctx.tx.select().from(requirementChampion).where(eq(requirementChampion.frameworkId, frameworkId))) at(c.code).champions.push({ itemKey: itemKey(c.scopeItemKind, c.scopeItemId), userId: c.userId });
  return out;
}

interface Lookup {
  levels: Map<string, typeof scopeLevel.$inferSelect>;
  items: Map<string, { nameEn: string; nameAr: string | null }>;
  users: Map<string, string>;
}

/** Names for everything the resolved values mention, in a fixed number of queries. */
async function lookupFor(ctx: Ctx, resolved: Resolved[], owns: Own[]): Promise<Lookup> {
  const unitIds = new Set<string>(); const programIds = new Set<string>(); const userIds = new Set<string>();
  const note = (key: string | null) => { if (!key) return; const [k, id] = key.split(':') as [string, string]; (k === 'org_unit' ? unitIds : programIds).add(id); };
  const levels = new Map((await ctx.tx.select().from(scopeLevel)).map((l) => [l.key, l] as const));
  const scopeItems = (level: string, ids: string[]) => { const kind = levels.get(level)?.kind; for (const id of ids) (kind === 'org_unit' ? unitIds : kind === 'program' ? programIds : new Set<string>()).add(id); };
  for (const r of resolved) {
    for (const l of r.scope?.levels ?? []) scopeItems(l.levelKey, l.itemIds);
    for (const c of r.champions) { note(c.itemKey); if (c.userId) userIds.add(c.userId); }
  }
  for (const o of owns) { if (o.scope) scopeItems(o.scope.levelKey, o.scope.itemIds); for (const c of o.champions) { note(c.itemKey); userIds.add(c.userId); } }
  const items = new Map<string, { nameEn: string; nameAr: string | null }>();
  if (unitIds.size) for (const u of await ctx.tx.select({ id: orgUnit.id, n: orgUnit.nameEn, a: orgUnit.nameAr }).from(orgUnit).where(inArray(orgUnit.id, [...unitIds]))) items.set(`org_unit:${u.id}`, { nameEn: u.n, nameAr: u.a });
  if (programIds.size) for (const p of await ctx.tx.select({ id: program.id, n: program.nameEn, a: program.nameAr }).from(program).where(inArray(program.id, [...programIds]))) items.set(`program:${p.id}`, { nameEn: p.n, nameAr: p.a });
  const users = new Map<string, string>();
  if (userIds.size) for (const u of await ctx.tx.select({ id: appUser.id, n: appUser.fullName }).from(appUser).where(inArray(appUser.id, [...userIds]))) users.set(u.id, u.n);
  return { levels, items, users };
}

const src = (s: { kind: 'own' | 'parent' | 'iqf'; code: string | null }): AssignmentSource => ({ kind: s.kind, code: s.code });

function describeScope(r: Resolved['scope'], lk: Lookup): EffectiveScope | null {
  if (!r) return null;
  const levels: EffectiveScope['levels'] = [];
  for (const v of r.levels) {
    const level = lk.levels.get(v.levelKey);
    if (!level) continue;
    const kind = level.kind === 'org_unit' ? 'org_unit' : level.kind === 'program' ? 'program' : null;
    // A unit or program deleted since is simply gone from the list; the others stay.
    const items = v.itemIds.flatMap((id) => { const it = kind ? lk.items.get(`${kind}:${id}`) : undefined; return it ? [{ id, nameEn: it.nameEn, nameAr: it.nameAr }] : []; });
    levels.push({ levelKey: level.key, labelEn: level.labelEn, labelAr: level.labelAr, kind: level.kind, active: level.active, all: v.itemIds.length === 0, items });
  }
  return levels.length ? { levels, sources: r.sources.map(src) } : null;
}

const parseKey = (key: string | null): { kind: ScopeItemKind | null; id: string | null } => {
  if (!key) return { kind: null, id: null };
  const [kind, id] = key.split(':') as [ScopeItemKind, string];
  return { kind, id };
};

function describeChampions(list: Resolved['champions'], lk: Lookup): EffectiveChampion[] {
  return list.flatMap((c) => {
    const { kind, id } = parseKey(c.itemKey);
    const item = kind && id ? lk.items.get(`${kind}:${id}`) : undefined;
    if (kind && !item) return [];   // the unit or program is gone
    return [{ itemKind: kind, itemId: id, itemName: item?.nameEn ?? null, userId: c.userId, userName: c.userId ? lk.users.get(c.userId) ?? null : null, needsOne: c.needsOne, sources: c.sources.map(src) }];
  });
}

function describeOwnChampions(o: Own | undefined, lk: Lookup): OwnChampion[] {
  return (o?.champions ?? []).flatMap((c) => {
    const { kind, id } = parseKey(c.itemKey);
    if (kind && !lk.items.has(`${kind}:${id}`)) return [];
    return [{ itemKind: kind, itemId: id, userId: c.userId, userName: lk.users.get(c.userId) ?? null }];
  });
}

/**
 * The effective scope and champion of every requirement of a version, by code: its own value, else through its approved
 * mappings to the institution's framework, else its parent's; with where each value comes from and what "Back to inherited"
 * would give. Needs framework:read.
 */
export async function loadAssignments(ctx: Ctx, versionId: string): Promise<Map<string, NodeAssignment>> {
  await require_(ctx, 'framework:read');
  const v = await getVersion(ctx, versionId);
  const nodes = await treeOf(ctx, versionId);
  const own = await ownOf(ctx, v.frameworkId);

  // Approved mappings only: a proposal does not move anyone's scope or champion.
  const maps = await ctx.tx.select().from(requirementMapping).where(and(eq(requirementMapping.frameworkId, v.frameworkId), eq(requirementMapping.reviewStatus, 'approved')));
  const mapped = new Map<string, MappedNode[]>();
  for (const fwId of new Set(maps.map((m) => m.internalFrameworkId))) {
    const ref = await referenceVersion(ctx, fwId);
    if (!ref) continue;
    const resolved = resolveTree(await treeOf(ctx, ref), await ownOf(ctx, fwId));
    for (const m of maps.filter((x) => x.internalFrameworkId === fwId).sort((a, b) => a.internalCode.localeCompare(b.internalCode, undefined, { numeric: true }))) {
      const r = resolved.get(m.internalCode);
      if (r) mapped.set(m.externalCode, [...(mapped.get(m.externalCode) ?? []), { code: m.internalCode, effective: r.effective }]);
    }
  }

  const res = resolveTree(nodes, own, mapped);
  const lk = await lookupFor(ctx, [...res.values()].flatMap((b) => [b.effective, b.inherited]), [...own.values()]);
  const out = new Map<string, NodeAssignment>();
  for (const n of nodes) {
    const b = res.get(n.code)!;
    const o = own.get(n.code);
    out.set(n.code, {
      scope: { own: o?.scope ? { levelKey: o.scope.levelKey, itemIds: o.scope.itemIds } : null, effective: describeScope(b.effective.scope, lk), inherited: o?.scope ? describeScope(b.inherited.scope, lk) : null },
      champion: { own: describeOwnChampions(o, lk), effective: describeChampions(b.effective.champions, lk), inherited: o?.champions.length ? describeChampions(b.inherited.champions, lk) : [] },
    });
  }
  return out;
}

/** Exactly what is set on one requirement (not inherited). */
export async function getOwnAssignment(ctx: Ctx, target: RequirementTarget): Promise<OwnAssignment> {
  await require_(ctx, 'framework:read');
  const o = (await ownOf(ctx, target.frameworkId)).get(target.code);
  const lk = await lookupFor(ctx, [], o ? [o] : []);
  return { scope: o?.scope ? { levelKey: o.scope.levelKey, itemIds: o.scope.itemIds } : null, champions: describeOwnChampions(o, lk) };
}

// ---- Setting and clearing -------------------------------------------------------------------------------------------------

async function assertRequirement(ctx: Ctx, t: RequirementTarget): Promise<void> {
  const [fw] = await ctx.tx.select({ id: framework.id }).from(framework).where(eq(framework.id, t.frameworkId));
  if (!fw) throw new NotFoundError(`standard ${t.frameworkId}`);
  const [r] = await ctx.tx.select({ id: requirement.id }).from(requirement).innerJoin(frameworkVersion, eq(frameworkVersion.id, requirement.frameworkVersionId))
    .where(and(eq(frameworkVersion.frameworkId, t.frameworkId), eq(requirement.code, t.code))).limit(1);
  if (!r) throw new NotFoundError(`requirement ${t.code}`);
}

const query = (t: RequirementTarget, extra: Record<string, string> = {}) => `?${new URLSearchParams({ frameworkId: t.frameworkId, code: t.code, ...extra }).toString()}`;

async function existingScope(ctx: Ctx, t: RequirementTarget) {
  const [row] = await ctx.tx.select().from(requirementScope).where(and(eq(requirementScope.frameworkId, t.frameworkId), eq(requirementScope.code, t.code)));
  return row ?? null;
}

/** Sets the requirement's own scope (an override of what it inherits): a level and, optionally, a list of its units or programs. */
export async function setRequirementScope(ctx: Ctx, input: SetRequirementScope): Promise<OwnAssignment> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'framework:write', any);
  const d = SetRequirementScopeSchema.parse(input);
  const t = { frameworkId: d.frameworkId, code: d.code };
  await assertRequirement(ctx, t);
  const [level] = await ctx.tx.select().from(scopeLevel).where(eq(scopeLevel.key, d.levelKey));
  if (!level) throw new ValidationError(`There is no scope level ${d.levelKey}.`);
  const prior = await existingScope(ctx, t);
  if (!level.active && prior?.levelKey !== level.key) throw new ConflictError(`The scope level ${level.labelEn} is not in use any more. Choose another.`);
  const ids = [...new Set(d.itemIds)];
  if (ids.length) {
    if (level.kind !== 'org_unit' && level.kind !== 'program') throw new ValidationError(`${level.labelEn} has no list to choose from yet: leave it empty to cover all of them.`);
    const found = level.kind === 'org_unit'
      ? await ctx.tx.select({ id: orgUnit.id }).from(orgUnit).where(inArray(orgUnit.id, ids))
      : await ctx.tx.select({ id: program.id }).from(program).where(inArray(program.id, ids));
    if (found.length !== ids.length) throw new ValidationError(`A scope can list only ${level.kind === 'org_unit' ? 'units' : 'programs'} of this institution.`);
  }
  if (prior) await guardIntegrity(() => ctx.tx.update(requirementScope).set({ levelKey: level.key, itemIds: ids }).where(eq(requirementScope.id, prior.id)));
  else await guardIntegrity(() => ctx.tx.insert(requirementScope).values({ institutionId: ctx.caller.institutionId, frameworkId: t.frameworkId, code: t.code, levelKey: level.key, itemIds: ids }));
  reportUndo(ctx, prior
    ? { label: `Changed the scope of ${t.code}`, method: 'PUT', path: SCOPE_PATH, body: { ...t, levelKey: prior.levelKey, itemIds: prior.itemIds } }
    : { label: `Set the scope of ${t.code}`, method: 'DELETE', path: SCOPE_PATH + query(t) });
  return getOwnAssignment(ctx, t);
}

/** "Back to inherited": removes the requirement's own scope. */
export async function clearRequirementScope(ctx: Ctx, t: RequirementTarget): Promise<OwnAssignment> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'framework:write', any);
  await assertRequirement(ctx, t);
  const prior = await existingScope(ctx, t);
  if (prior) {
    await ctx.tx.delete(requirementScope).where(eq(requirementScope.id, prior.id));
    reportUndo(ctx, { label: `Removed the own scope of ${t.code}`, method: 'PUT', path: SCOPE_PATH, body: { ...t, levelKey: prior.levelKey, itemIds: prior.itemIds } });
  }
  return getOwnAssignment(ctx, t);
}

const championWhere = (t: RequirementTarget, kind: ScopeItemKind | null, id: string | null) => and(
  eq(requirementChampion.frameworkId, t.frameworkId), eq(requirementChampion.code, t.code),
  kind && id ? and(eq(requirementChampion.scopeItemKind, kind), eq(requirementChampion.scopeItemId, id)) : and(isNull(requirementChampion.scopeItemKind), isNull(requirementChampion.scopeItemId)),
);

/** Sets the overall champion (no item) or the champion of one unit or program. */
export async function setRequirementChampion(ctx: Ctx, input: SetRequirementChampion): Promise<OwnAssignment> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'framework:write', any);
  const d = SetRequirementChampionSchema.parse(input);
  const t = { frameworkId: d.frameworkId, code: d.code };
  if ((d.itemKind === null) !== (d.itemId === null)) throw new ValidationError('Name both the kind and the unit or program, or neither for the overall champion.');
  await assertRequirement(ctx, t);
  const [p] = await ctx.tx.select({ active: appUser.active }).from(appUser).where(eq(appUser.id, d.userId));
  if (!p) throw new ValidationError('A champion must be a person of this institution.');
  if (!p.active) throw new ConflictError('That person is inactive and cannot be a champion.');
  if (d.itemKind && d.itemId) {
    const [it] = d.itemKind === 'org_unit' ? await ctx.tx.select({ id: orgUnit.id }).from(orgUnit).where(eq(orgUnit.id, d.itemId)) : await ctx.tx.select({ id: program.id }).from(program).where(eq(program.id, d.itemId));
    if (!it) throw new ValidationError(`The ${d.itemKind === 'org_unit' ? 'unit' : 'program'} was not found in this institution.`);
  }
  const [prior] = await ctx.tx.select().from(requirementChampion).where(championWhere(t, d.itemKind, d.itemId));
  if (prior) await guardIntegrity(() => ctx.tx.update(requirementChampion).set({ userId: d.userId }).where(eq(requirementChampion.id, prior.id)));
  else await guardIntegrity(() => ctx.tx.insert(requirementChampion).values({ institutionId: ctx.caller.institutionId, ...t, scopeItemKind: d.itemKind, scopeItemId: d.itemId, userId: d.userId }));
  const item = d.itemKind && d.itemId ? { itemKind: d.itemKind, itemId: d.itemId } : {};
  reportUndo(ctx, prior
    ? { label: `Changed the champion of ${t.code}`, method: 'PUT', path: CHAMPION_PATH, body: { ...t, ...item, userId: prior.userId } }
    : { label: `Set the champion of ${t.code}`, method: 'DELETE', path: CHAMPION_PATH + query(t, d.itemKind && d.itemId ? { itemKind: d.itemKind, itemId: d.itemId } : {}) });
  return getOwnAssignment(ctx, t);
}

/** Removes one own champion (the overall one when no item is named) or, with `all`, every own champion of the requirement ("Back to inherited"). */
export async function clearRequirementChampion(ctx: Ctx, input: ClearRequirementChampion): Promise<OwnAssignment> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'framework:write', any);
  const t = { frameworkId: input.frameworkId, code: input.code };
  await assertRequirement(ctx, t);
  const where = input.all
    ? and(eq(requirementChampion.frameworkId, t.frameworkId), eq(requirementChampion.code, t.code))
    : championWhere(t, input.itemKind ?? null, input.itemId ?? null);
  const gone = await ctx.tx.select().from(requirementChampion).where(where);
  if (gone.length) {
    await ctx.tx.delete(requirementChampion).where(where);
    // One row can be put back with one request; a larger removal offers no Undo.
    if (gone.length === 1) {
      const g = gone[0]!;
      reportUndo(ctx, { label: `Removed the champion of ${t.code}`, method: 'PUT', path: CHAMPION_PATH, body: { ...t, ...(g.scopeItemKind && g.scopeItemId ? { itemKind: g.scopeItemKind, itemId: g.scopeItemId } : {}), userId: g.userId } });
    }
  }
  return getOwnAssignment(ctx, t);
}
