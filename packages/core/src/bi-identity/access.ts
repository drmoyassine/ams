// The BI role and data scope of a person (DEC-035, docs/ams-bi-contract-v0.md 6.2), derived from their AMS role assignments.
// The one place this mapping lives: the token issuer calls it on every token, so a change of assignment shows in the next token.
import { BI_ROLES, type BiAccess, type BiRole, type BiScopeEntry, type Role } from '@ams/shared';

/** One active, unexpired role assignment, with an engagement assignment already resolved to the engagement's subject. */
export interface BiAssignment { role: Role; scopeType: 'institution' | 'org_unit' | 'program'; scopeId: string }

/**
 * AMS role -> BI role. An institution-wide admin administers the BI; a lead stewards the data of what they lead; everyone who may
 * read the AMS views the figures of what they are assigned to. An admin at a narrower scope is a steward there. External
 * reviewers (one snapshot, temporary) get nothing.
 */
export function biRoleOf(a: BiAssignment): BiRole | null {
  switch (a.role) {
    case 'admin': return a.scopeType === 'institution' ? 'admin' : 'steward';
    case 'lead': return 'steward';
    case 'engagement_lead': case 'co_lead': case 'contributor': case 'reviewer': case 'viewer': return 'viewer';
    case 'external_reviewer': return null;
  }
}

const rank = (r: BiRole) => BI_ROLES.indexOf(r);

/**
 * The person's BI access: one scope entry per institution, unit or program they hold a role on (the highest BI role there), and
 * their overall role (the highest of the entries). Null when nothing grants BI access: the issuer then refuses the token.
 */
export function biAccessOf(assignments: readonly BiAssignment[]): BiAccess | null {
  const byScope = new Map<string, BiScopeEntry>();
  for (const a of assignments) {
    const role = biRoleOf(a);
    if (!role) continue;
    const key = `${a.scopeType}:${a.scopeId}`;
    const had = byScope.get(key);
    if (!had || rank(role) > rank(had.role)) byScope.set(key, { type: a.scopeType, id: a.scopeId, role });
  }
  if (!byScope.size) return null;
  const order = { institution: 0, org_unit: 1, program: 2 } as const;
  const scope = [...byScope.values()].sort((x, y) => order[x.type] - order[y.type] || x.id.localeCompare(y.id));
  const role = scope.reduce<BiRole>((best, e) => (rank(e.role) > rank(best) ? e.role : best), 'viewer');
  return { role, scope };
}
