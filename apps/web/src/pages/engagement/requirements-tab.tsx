import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EngagementDetail } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { REQUIREMENT_STATUS, RequirementStatusBadge } from '../../components/badges';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import type { EngagementApi } from '../../lib/engagement-api';
import { useAction } from '../../lib/use-action';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';

export function RequirementsTab({ api, detail, canManage }: { api: EngagementApi; detail: EngagementDetail; canManage: boolean }) {
  const id = detail.engagement.id;
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['engagement-requirements', id], queryFn: () => api.requirements(id) });
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  const [showOff, setShowOff] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [owner, setOwner] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const people = (roles: string[]) => detail.members.filter((m) => roles.includes(m.role));
  const names = useMemo(() => new Map(detail.members.map((m) => [m.userId, m.fullName])), [detail.members]);

  const assign = useMutation({
    mutationFn: async () => {
      setError(null); setMessage(null);
      const r = await act(() => api.assign(id, { requirementIds: [...picked], ...(owner ? { ownerId: owner } : {}), ...(reviewer ? { reviewerId: reviewer } : {}) }));
      if (r) { setMessage(`${r.updated} requirement(s) assigned.`); setPicked(new Set()); await qc.invalidateQueries({ queryKey: ['engagement-requirements', id] }); }
    },
  });

  if (!data) return <p>Loading…</p>;
  const items = data.items.filter((i) => (showOff || i.applicable) && (!status || i.status === status)
    && (!text || `${i.code} ${i.title}`.toLowerCase().includes(text.toLowerCase())));
  const toggle = (rid: string) => { const next = new Set(picked); if (next.has(rid)) next.delete(rid); else next.add(rid); setPicked(next); };

  return (
    <div>
      <ul className="mb-3 flex flex-wrap gap-2 text-sm" aria-label="Requirements by status">
        {Object.entries(REQUIREMENT_STATUS).map(([k, label]) => <li key={k} className="rounded border border-border px-2 py-0.5">{label}: {data.byStatus[k] ?? 0}</li>)}
      </ul>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input aria-label="Search requirements" className="w-64" placeholder="Search code or title" value={text} onChange={(e) => setText(e.target.value)} />
        <select aria-label="Filter by status" className={select} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {Object.entries(REQUIREMENT_STATUS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <label className="text-sm"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Show those not applicable</label>
      </div>
      {canManage && (
        <form className="mb-3 flex flex-wrap items-end gap-3 rounded-lg border border-border p-3" onSubmit={(e) => { e.preventDefault(); assign.mutate(); }}>
          <span className="text-sm">{picked.size} selected</span>
          <label className="flex flex-col text-xs">Owner
            <select aria-label="Owner for selected" className={select} value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Leave as is</option>
              {people(['engagement_lead', 'co_lead', 'contributor']).map((m) => <option key={m.userId} value={m.userId}>{m.fullName}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-xs">Reviewer
            <select aria-label="Reviewer for selected" className={select} value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
              <option value="">Leave as is</option>
              {people(['engagement_lead', 'co_lead', 'reviewer']).map((m) => <option key={m.userId} value={m.userId}>{m.fullName}</option>)}
            </select>
          </label>
          <Button type="submit" disabled={picked.size === 0 || (!owner && !reviewer) || assign.isPending}>Assign</Button>
          {message && <span role="status" className="text-sm text-emerald-800">{message}</span>}
          {error && <span role="alert" className="text-sm text-red-700">{error}</span>}
        </form>
      )}
      <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Requirements">
        {items.map((i) => (
          <li key={i.id} className={`flex flex-wrap items-center gap-3 px-4 py-2 ${i.applicable ? '' : 'opacity-60'}`} style={{ paddingInlineStart: `${1 + (i.parentCode ? 1.25 : 0)}rem` }}>
            {canManage && i.applicable && <input type="checkbox" aria-label={`Select ${i.code}`} checked={picked.has(i.requirementId)} onChange={() => toggle(i.requirementId)} />}
            <Link to="/engagement-requirements/$id" params={{ id: i.id }} className="font-medium underline-offset-2 hover:underline"><ContentText>{i.code}</ContentText></Link>
            <ContentText className="flex-1 text-sm">{i.title}</ContentText>
            {!i.applicable && <span className="rounded border border-border px-2 py-0.5 text-xs" title={i.naReason ?? undefined}>Not applicable</span>}
            {i.applicable && <RequirementStatusBadge status={i.status} />}
            <span className="w-28 text-end text-xs text-muted-foreground">{i.ownerId ? names.get(i.ownerId) ?? '' : 'Unassigned'}</span>
          </li>
        ))}
        {items.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">No requirements match.</li>}
      </ul>
    </div>
  );
}
