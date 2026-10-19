// Turning a template's rules into units and people when a cycle is launched (docs/quality-management-plan.md). The rules read the
// org chart and the role assignments; they are data in the template, never code (DEC-002). A rule that finds nothing, or cannot
// tell between several candidates, resolves to null and the stage is flagged: it is never guessed.
import { sql } from 'drizzle-orm';
import { appUser, orgUnit } from '@ams/db';
import type { PersonRule, UnitRule } from '@ams/shared';
import type { Ctx } from '../ctx.js';

interface UnitInfo { id: string; parentId: string | null; type: string; active: boolean; headUserId: string | null }

export interface Resolver {
  /** The unit a rule names, or null when the org chart does not give exactly one. */
  unit(rule: UnitRule): string | null;
  /** The person a rule names within a unit (null unit: only institution-wide roles), or null when it is not exactly one. */
  person(rule: PersonRule, unitId: string | null): string | null;
}

export async function makeResolver(ctx: Ctx, c: { cycleUnitId: string; subjectUnitId: string | null; leadUserId: string }): Promise<Resolver> {
  const [unitRows, userRows, grants] = await Promise.all([
    ctx.tx.select({ id: orgUnit.id, parentId: orgUnit.parentId, type: orgUnit.type, active: orgUnit.active, headUserId: orgUnit.headUserId }).from(orgUnit),
    ctx.tx.select({ id: appUser.id }).from(appUser).where(sql`${appUser.active} = true`),
    ctx.tx.execute<{ user_id: string; role: string; scope_type: string; scope_id: string }>(sql`
      select user_id, role, scope_type, scope_id from role_assignment where (expires_at is null or expires_at > now()) and scope_type in ('institution', 'org_unit')`),
  ]);
  const units = new Map<string, UnitInfo>(unitRows.map((u) => [u.id, u] as const));
  const active = new Set(userRows.map((u) => u.id));
  /** The unit and its ancestors, nearest first. */
  const chain = (id: string | null): string[] => {
    const out: string[] = [];
    for (let cur = id ? units.get(id) : undefined, n = 0; cur && n < 100; cur = cur.parentId ? units.get(cur.parentId) : undefined, n += 1) out.push(cur.id);
    return out;
  };
  const only = (ids: Iterable<string>): string | null => {
    const set = new Set([...ids].filter((i) => active.has(i)));
    return set.size === 1 ? [...set][0]! : null;
  };

  return {
    unit(rule) {
      switch (rule.kind) {
        case 'cycle': return c.cycleUnitId;
        case 'subject': return c.subjectUnitId;
        case 'parent_of_subject': return c.subjectUnitId ? (units.get(c.subjectUnitId)?.parentId ?? null) : null;
        case 'unit_type': {
          const ofType = unitRows.filter((u) => u.type === rule.type && u.active);
          if (ofType.length === 1) return ofType[0]!.id;
          // Several units of that type (several QA offices): the one the subject sits in or under, if that is clear.
          for (const id of chain(c.subjectUnitId)) if (units.get(id)?.type === rule.type) return id;
          return null;
        }
      }
    },
    person(rule, unitId) {
      switch (rule.kind) {
        case 'cycle_lead': return c.leadUserId;
        case 'head_of_unit': { const h = unitId ? units.get(unitId)?.headUserId : null; return h && active.has(h) ? h : null; }
        case 'head_of_parent_unit': {
          const parent = unitId ? units.get(unitId)?.parentId : null;
          const h = parent ? units.get(parent)?.headUserId : null;
          return h && active.has(h) ? h : null;
        }
        case 'role': {
          // The nearest level of the org chart (the unit, then each unit above it, then the institution) that has anyone with the
          // role decides: exactly one person there resolves; several are ambiguous and left for a person to choose.
          for (const id of chain(unitId)) {
            const here = grants.rows.filter((g) => g.role === rule.role && g.scope_type === 'org_unit' && g.scope_id === id && active.has(g.user_id));
            if (here.length) return only(here.map((g) => g.user_id));
          }
          const top = grants.rows.filter((g) => g.role === rule.role && g.scope_type === 'institution' && active.has(g.user_id));
          return top.length ? only(top.map((g) => g.user_id)) : null;
        }
      }
    },
  };
}
