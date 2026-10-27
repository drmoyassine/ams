import { describe, expect, it } from 'vitest';
import { biAccessOf, biRoleOf, type BiAssignment } from './access.js';

const U1 = '00000000-0000-4000-8000-000000000001';
const P1 = '00000000-0000-4000-8000-000000000002';
const I = '00000000-0000-4000-8000-0000000000aa';
const a = (role: BiAssignment['role'], scopeType: BiAssignment['scopeType'], scopeId: string): BiAssignment => ({ role, scopeType, scopeId });

describe('the BI role of an AMS role (DEC-035)', () => {
  it('maps admin, lead and readers, and gives external reviewers nothing', () => {
    expect(biRoleOf(a('admin', 'institution', I))).toBe('admin');
    expect(biRoleOf(a('admin', 'org_unit', U1))).toBe('steward');
    expect(biRoleOf(a('lead', 'org_unit', U1))).toBe('steward');
    for (const r of ['engagement_lead', 'co_lead', 'contributor', 'reviewer', 'viewer'] as const) expect(biRoleOf(a(r, 'program', P1))).toBe('viewer');
    expect(biRoleOf(a('external_reviewer', 'program', P1))).toBeNull();
  });
});

describe('the BI access of a person', () => {
  it('keeps the highest role per scope, orders the scope, and takes the highest role overall', () => {
    expect(biAccessOf([a('viewer', 'program', P1), a('lead', 'org_unit', U1), a('reviewer', 'program', P1), a('contributor', 'org_unit', U1)])).toEqual({
      role: 'steward',
      scope: [{ type: 'org_unit', id: U1, role: 'steward' }, { type: 'program', id: P1, role: 'viewer' }],
    });
    expect(biAccessOf([a('admin', 'institution', I)])).toEqual({ role: 'admin', scope: [{ type: 'institution', id: I, role: 'admin' }] });
  });

  it('is null when nothing grants access', () => {
    expect(biAccessOf([])).toBeNull();
    expect(biAccessOf([a('external_reviewer', 'program', P1)])).toBeNull();
  });
});
