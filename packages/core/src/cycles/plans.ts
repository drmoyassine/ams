// Which cycle plans are in effect on a node, and for whom they run (TASK-081). Pure and deterministic: no database, no clock, no
// accreditor identity (DEC-002); nodes are only codes in a tree. Copies the inheritance pattern of scope and champion
// (packages/core/src/scope/resolve.ts):
//
//   - Per TEMPLATE, a node's own plan wins ("Own"); an own opt-out stops the template there, and below.
//   - An external requirement takes, next, the plan of its APPROVED mapped institution-framework nodes: the first of their plans
//     (in code order) that is not opted out; the source names every mapped node that gives it ("From IQF 4, 4.2").
//   - Otherwise it takes its parent's effective plan, within the same standard, and finally a plan attached to the whole standard.
// Every effective plan carries its source: where it was set ("From IQF 4"). `inherited` is what the node would have without its own
// plans, which is what "Back to inherited" gives.
//
// Who a plan's runs are about: the anchor's effective scope (TASK-086) narrowed by the plan's `appliesTo`.
import type { AppliesTo, PlanMode, PlanSource } from '@ams/shared';
import type { TreeNode } from '../scope/resolve.js';

export interface PlanRef { id: string; templateId: string; mode: PlanMode }
export interface EffRef { templateId: string; planId: string; source: PlanSource; sourceCodes: string[]; optedOut: boolean }
/** An approved mapping's institution-framework node, already resolved within its own tree. */
export interface MappedPlans { code: string; effective: EffRef[] }
export interface PlanBoth { effective: EffRef[]; inherited: EffRef[] }

const byTemplate = (list: readonly EffRef[]) => new Map(list.map((e) => [e.templateId, e] as const));

/** Resolves every node of one version's tree. `ownByCode`: what people set, by code (so it carries over to the next version); `whole`: plans attached to the whole standard; `mapped`: approved mappings of an external standard. */
export function resolvePlanTree(
  nodes: readonly TreeNode[], ownByCode: ReadonlyMap<string, readonly PlanRef[]>, whole: readonly PlanRef[] = [], mapped: ReadonlyMap<string, MappedPlans[]> = new Map(),
): Map<string, PlanBoth> {
  const parentOf = new Map(nodes.map((n) => [n.code, n.parentCode] as const));
  const memo = new Map<string, EffRef[]>();
  const visiting = new Set<string>();

  const top: EffRef[] = whole.map((p) => ({ templateId: p.templateId, planId: p.id, source: { kind: 'framework', code: null }, sourceCodes: [], optedOut: p.mode === 'opt_out' }));

  const compute = (code: string, withOwn: boolean): EffRef[] => {
    const own = withOwn ? ownByCode.get(code) ?? [] : [];
    const via = mapped.get(code) ?? [];
    const parentCode = parentOf.get(code) ?? null;
    const parent = parentCode === null ? top : visiting.has(parentCode) ? [] : effective(parentCode);
    const parentBy = byTemplate(parent);
    const templates = new Set<string>([...own.map((p) => p.templateId), ...via.flatMap((m) => m.effective.map((e) => e.templateId)), ...parent.map((e) => e.templateId)]);
    const out: EffRef[] = [];
    for (const templateId of [...templates].sort()) {
      const mine = own.find((p) => p.templateId === templateId);
      if (mine) { out.push({ templateId, planId: mine.id, source: { kind: 'own', code: null }, sourceCodes: [], optedOut: mine.mode === 'opt_out' }); continue; }
      const found = via.flatMap((m) => { const e = m.effective.find((x) => x.templateId === templateId); return e ? [{ code: m.code, e }] : []; });
      if (found.length) {
        const pick = found.find((f) => !f.e.optedOut) ?? found[0]!;
        const codes = found.filter((f) => f.e.planId === pick.e.planId).map((f) => f.code);
        out.push({ templateId, planId: pick.e.planId, source: { kind: 'iqf', code: codes[0]! }, sourceCodes: codes, optedOut: pick.e.optedOut });
        continue;
      }
      const p = parentBy.get(templateId);
      if (p) out.push({ ...p, source: p.source.kind === 'own' ? { kind: 'parent', code: parentCode } : p.source });
    }
    return out;
  };
  const effective = (code: string): EffRef[] => {
    const hit = memo.get(code);
    if (hit) return hit;
    visiting.add(code);
    const r = compute(code, true);
    visiting.delete(code);
    memo.set(code, r);
    return r;
  };

  const out = new Map<string, PlanBoth>();
  for (const n of nodes) out.set(n.code, { effective: effective(n.code), inherited: ownByCode.has(n.code) ? compute(n.code, false) : effective(n.code) });
  return out;
}

// ---- Who a plan's runs are about ------------------------------------------------------------------------------------------

export type SubjectKind = 'institution' | 'org_unit' | 'program';
export interface Candidate { kind: SubjectKind; id: string; name: string; unitId: string | null; unitType?: string | null; programLevel?: string | null }
export interface Universe { institution: Candidate | null; units: Candidate[]; programs: Candidate[] }
/** A scope level as the plan needs it: what the level's items are (units, programs, the institution, or nothing yet), and which. */
export interface ScopeLevelUse { kind: 'institution' | 'org_unit' | 'program' | 'course' | 'custom'; itemIds: string[] }

const ORDER: Record<SubjectKind, number> = { institution: 0, org_unit: 1, program: 2 };

/**
 * The subjects of a plan's runs: the node's effective scope (levels with their items; none listed = every one at that level),
 * narrowed by `appliesTo` (kinds, unit types, program levels, an explicit list). With no scope anywhere, `appliesTo` alone names
 * them: its kinds (all kinds when only a list is given), and with neither the plan has no subjects. Course and custom levels hold
 * no records yet and give none. Sorted by kind, then name.
 */
export function subjectsFor(universe: Universe, scope: readonly ScopeLevelUse[] | null, appliesTo: AppliesTo = {}): Candidate[] {
  const picked: Candidate[] = [];
  const take = (kind: SubjectKind, ids: readonly string[]) => {
    const pool = kind === 'institution' ? (universe.institution ? [universe.institution] : []) : kind === 'org_unit' ? universe.units : universe.programs;
    picked.push(...(ids.length ? pool.filter((c) => ids.includes(c.id)) : pool));
  };
  if (scope) {
    for (const l of scope) if (l.kind === 'institution' || l.kind === 'org_unit' || l.kind === 'program') take(l.kind, l.itemIds);
  } else {
    const kinds = appliesTo.kinds?.length ? appliesTo.kinds : appliesTo.ids?.length ? (['org_unit', 'program'] as const) : [];
    for (const k of kinds) take(k, []);
  }
  const kinds = appliesTo.kinds?.length ? new Set<string>(appliesTo.kinds) : null;
  const types = appliesTo.unitTypes?.length ? new Set(appliesTo.unitTypes) : null;
  const levels = appliesTo.programLevels?.length ? new Set(appliesTo.programLevels) : null;
  const ids = appliesTo.ids?.length ? new Set(appliesTo.ids) : null;
  const seen = new Set<string>();
  return picked
    .filter((c) => (!kinds || kinds.has(c.kind)) && (!types || c.kind !== 'org_unit' || types.has(c.unitType ?? '')) && (!levels || c.kind !== 'program' || levels.has(c.programLevel ?? '')) && (!ids || ids.has(c.id)))
    .filter((c) => { const k = `${c.kind}:${c.id}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
