import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MEMBER_ROLES, type EngagementDetail, type Me } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import type { EngagementApi } from '../../lib/engagement-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
const ROLE_LABEL = { engagement_lead: 'Engagement lead', co_lead: 'Co-lead', contributor: 'Contributor', reviewer: 'Reviewer', viewer: 'Viewer' } as const;

export function MembersTab({ api, detail, me, onChanged }: { api: EngagementApi; detail: EngagementDetail; me: Me | undefined; onChanged: () => void }) {
  const qc = useQueryClient();
  const id = detail.engagement.id;
  const active = detail.engagement.status === 'active';
  const canManage = can(me, 'engagement:manage') && active;
  const canHandover = can(me, 'engagement:lead') && active;
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.users(), enabled: canManage });
  const [newUser, setNewUser] = useState('');
  const [newRole, setNewRole] = useState<(typeof MEMBER_ROLES)[number]>('contributor');
  const [lead, setLead] = useState('');
  const [outgoing, setOutgoing] = useState<string>('co_lead');
  const done = () => { void qc.invalidateQueries({ queryKey: ['engagement', id] }); onChanged(); };
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onSuccess: done });
  const memberIds = new Set(detail.members.map((m) => m.userId));
  const candidates = (users.data ?? []).filter((u) => !memberIds.has(u.id));

  return (
    <div className="flex flex-col gap-4">
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Members">
        {detail.members.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div><ContentText className="font-medium">{m.fullName}</ContentText> <span className="text-sm text-muted-foreground">{m.email}</span></div>
            <div className="flex items-center gap-2">
              {m.role === 'engagement_lead' || !canManage ? (
                <span className="rounded border border-border px-2 py-0.5 text-sm">{ROLE_LABEL[m.role]}</span>
              ) : (
                <>
                  <select aria-label={`Role of ${m.fullName}`} className={select} value={m.role} onChange={(e) => { const role = e.target.value as (typeof MEMBER_ROLES)[number]; run.mutate(() => api.changeMember(id, m.userId, role)); }}>
                    {MEMBER_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                  <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => run.mutate(() => api.removeMember(id, m.userId))}>Remove</Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      {canManage && (
        <Card>
          <h2 className="mb-2 font-semibold">Add a member</h2>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (newUser) { run.mutate(() => api.addMember(id, { userId: newUser, role: newRole })); setNewUser(''); } }}>
            <label className="flex flex-col gap-1 text-sm">Person
              <select aria-label="Person to add" className={select} value={newUser} onChange={(e) => setNewUser(e.target.value)}>
                <option value="">Choose a person</option>
                {candidates.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">Role
              <select aria-label="Role to give" className={select} value={newRole} onChange={(e) => setNewRole(e.target.value as typeof newRole)}>
                {MEMBER_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </label>
            <Button type="submit" disabled={!newUser}>Add member</Button>
          </form>
        </Card>
      )}

      {canHandover && (
        <Card>
          <h2 className="mb-1 font-semibold">Hand over the lead role</h2>
          <p className="mb-2 text-sm text-muted-foreground">An engagement always has exactly one lead. The handover is recorded in the audit trail.</p>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (lead) run.mutate(() => api.handover(id, { newLeadUserId: lead, outgoingRole: outgoing === 'leave' ? null : (outgoing as (typeof MEMBER_ROLES)[number]) })); }}>
            <label className="flex flex-col gap-1 text-sm">New lead
              <select aria-label="New lead" className={select} value={lead} onChange={(e) => setLead(e.target.value)}>
                <option value="">Choose a person</option>
                {(users.data ?? []).filter((u) => u.id !== detail.engagement.leadUserId).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">The current lead then
              <select aria-label="Outgoing lead becomes" className={select} value={outgoing} onChange={(e) => setOutgoing(e.target.value)}>
                {MEMBER_ROLES.map((r) => <option key={r} value={r}>{`becomes ${ROLE_LABEL[r].toLowerCase()}`}</option>)}
                <option value="leave">leaves the engagement</option>
              </select>
            </label>
            <Button type="submit" disabled={!lead}>Hand over</Button>
          </form>
        </Card>
      )}
    </div>
  );
}
