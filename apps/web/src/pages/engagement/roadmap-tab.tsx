import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { EngagementDetail, Milestone } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { MILESTONE_STATUS, OriginBadge } from '../../components/badges';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import type { EngagementApi } from '../../lib/engagement-api';
import { useAction } from '../../lib/use-action';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
type Member = EngagementDetail['members'][number];

function MilestoneRow({ api, m, members, canManage, first, last, onMove, onChanged, setError }: {
  api: EngagementApi; m: Milestone; members: Member[]; canManage: boolean; first: boolean; last: boolean; onMove: (dir: -1 | 1) => void; onChanged: () => void; setError: (e: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(m.name);
  const [due, setDue] = useState(m.dueDate ?? '');
  const [owner, setOwner] = useState(m.ownerId ?? '');
  const [reason, setReason] = useState('');
  const [skipping, setSkipping] = useState(false);
  const act = useAction(setError);
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => act(fn), onSuccess: onChanged });
  const ownerName = members.find((x) => x.userId === m.ownerId)?.fullName;

  return (
    <li className="py-3" data-testid="milestone">
      <div className="flex flex-wrap items-center gap-2">
        <ContentText className={m.status === 'skipped' ? 'line-through' : ''}>{m.name}</ContentText>
        <OriginBadge origin={m.origin} />
        {m.locked && <span title="Cannot be deleted" className="rounded border border-border px-2 py-0.5 text-xs">Locked</span>}
        {!m.required && <span className="rounded border border-border px-2 py-0.5 text-xs">Optional</span>}
        {m.overdue && <span className="rounded border border-red-300 bg-red-50 px-2 py-0.5 text-xs text-red-900">Overdue</span>}
        <span className="ms-auto text-sm text-muted-foreground">
          {m.dueDate ?? (m.dateNeeded ? <em>Date needed</em> : 'No date')}{ownerName && <> · <ContentText>{ownerName}</ContentText></>}
        </span>
      </div>
      {m.description && <p className="mt-1 text-sm text-muted-foreground"><ContentText>{m.description}</ContentText></p>}
      {m.status === 'skipped' && m.skipReason && <p className="mt-1 text-xs text-muted-foreground">Skipped: {m.skipReason}</p>}
      {canManage && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-xs">Status{' '}
            <select aria-label={`Status of ${m.name}`} className={select} value={m.status}
              onChange={(e) => {
                const status = e.target.value as Milestone['status'];
                if (status === 'skipped' && m.required) { setSkipping(true); return; }
                run.mutate(() => api.updateMilestone(m.id, { status }));
              }}>
              {Object.entries(MILESTONE_STATUS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => setEditing(!editing)}>Edit</Button>
          <Button type="button" variant="ghost" className="px-2 py-1" aria-label={`Move ${m.name} up`} disabled={first} onClick={() => onMove(-1)}>↑</Button>
          <Button type="button" variant="ghost" className="px-2 py-1" aria-label={`Move ${m.name} down`} disabled={last} onClick={() => onMove(1)}>↓</Button>
          {m.origin === 'local' && !m.locked && (
            <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => run.mutate(() => api.deleteMilestone(m.id))}>Delete</Button>
          )}
        </div>
      )}
      {skipping && (
        <form className="mt-2 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); run.mutate(() => api.updateMilestone(m.id, { status: 'skipped', skipReason: reason })); setSkipping(false); }}>
          <Input aria-label={`Reason for skipping ${m.name}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this required step skipped?" />
          <Button type="submit" disabled={!reason.trim()}>Skip</Button>
          <Button type="button" variant="ghost" onClick={() => setSkipping(false)}>Cancel</Button>
        </form>
      )}
      {editing && (
        <form className="mt-2 flex flex-wrap items-end gap-3" onSubmit={(e) => {
          e.preventDefault();
          run.mutate(() => api.updateMilestone(m.id, { name, dueDate: due || null, ownerId: owner || null }));
          setEditing(false);
        }}>
          <label className="flex flex-col text-xs">Name<Input aria-label="Milestone name" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="flex flex-col text-xs">Due date<Input aria-label="Milestone due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
          <label className="flex flex-col text-xs">Owner
            <select aria-label="Milestone owner" className={select} value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">No owner</option>
              {members.map((x) => <option key={x.userId} value={x.userId}>{x.fullName}</option>)}
            </select>
          </label>
          <Button type="submit">Save</Button>
        </form>
      )}
    </li>
  );
}

export function RoadmapTab({ api, detail, canManage, onChanged }: { api: EngagementApi; detail: EngagementDetail; canManage: boolean; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const reorder = useMutation({ mutationFn: (v: { phase: Milestone['phase']; ids: string[] }) => act(() => api.reorder(detail.engagement.id, { phase: v.phase, milestoneIds: v.ids })), onSuccess: onChanged });
  return (
    <div>
      {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
      {detail.phases.map((p) => {
        const ms = detail.milestones.filter((m) => m.phase === p.type).sort((a, b) => a.displayOrder - b.displayOrder);
        return (
          <section key={p.type} aria-label={p.name} className="mb-6">
            <h2 className="mb-1 flex items-baseline gap-2 text-lg font-semibold">
              {p.name} {p.current && <span className="rounded bg-primary px-2 py-0.5 text-xs font-normal text-primary-foreground">Current</span>}
              <span className="text-sm font-normal text-muted-foreground">{p.requiredDone}/{p.requiredTotal} required done</span>
            </h2>
            <ul className="divide-y divide-border rounded-lg border border-border px-4">
              {ms.map((m, i) => (
                <MilestoneRow key={m.id} api={api} m={m} members={detail.members} canManage={canManage} first={i === 0} last={i === ms.length - 1} setError={setError} onChanged={onChanged}
                  onMove={(dir) => { const ids = ms.map((x) => x.id); const j = i + dir; [ids[i], ids[j]] = [ids[j]!, ids[i]!]; reorder.mutate({ phase: p.type, ids }); }} />
              ))}
              {ms.length === 0 && <li className="py-3 text-sm text-muted-foreground">No milestones in this phase.</li>}
            </ul>
            {canManage && <AddMilestoneForm api={api} engagementId={detail.engagement.id} phase={p.type} onChanged={onChanged} setError={setError} />}
          </section>
        );
      })}
    </div>
  );
}

function AddMilestoneForm({ api, engagementId, phase, onChanged, setError }: { api: EngagementApi; engagementId: string; phase: Milestone['phase']; onChanged: () => void; setError: (e: string | null) => void }) {
  const [name, setName] = useState('');
  const act = useAction(setError);
  const add = useMutation({ mutationFn: () => act(() => api.addMilestone(engagementId, { phase, name })), onSuccess: () => { setName(''); onChanged(); } });
  return (
    <form className="mt-2 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(); }}>
      <Input aria-label={`Add a milestone to ${phase.replace('_', ' ')}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Add your own step, e.g. steering committee" />
      <Button type="submit" disabled={!name.trim()}>Add</Button>
    </form>
  );
}
