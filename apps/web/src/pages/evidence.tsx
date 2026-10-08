import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EvidenceItem } from '@ams/shared';
import { EvidenceCard } from '../components/evidence-card';
import { RequestList } from '../components/evidence-requests';
import { NewEvidenceDialog } from '../components/link-evidence-dialog';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { useEvidenceApi, type EvidenceApi } from '../lib/evidence-api';
import { type FrameworkApi } from '../lib/framework-api';
import { can, useApi, useMe } from '../lib/me';

const TABS = [['library', 'Library'], ['requests', 'Requests']] as const;
type Tab = (typeof TABS)[number][0];

/** The library's filters; every one but Archived shows active items only. */
const FILTERS = {
  all: { label: 'All', keep: (e: EvidenceItem) => e.status === 'active' },
  documents: { label: 'Documents', keep: (e: EvidenceItem) => e.status === 'active' && e.type === 'document' },
  data: { label: 'Data', keep: (e: EvidenceItem) => e.status === 'active' && e.type === 'data' },
  unlinked: { label: 'Not linked', keep: (e: EvidenceItem) => e.status === 'active' && e.linkCount === 0 },
  review: { label: 'To review', keep: (e: EvidenceItem) => e.status === 'active' && e.proposedLinkCount > 0 },
  archived: { label: 'Archived', keep: (e: EvidenceItem) => e.status === 'archived' },
} as const;
type Filter = keyof typeof FILTERS;

/** The evidence repository (PRD 9.1): stored once, versioned, linked many times; and every request for evidence. */
export function EvidencePage({ api: override, framework: frameworkOverride }: { api?: EvidenceApi; framework?: FrameworkApi }) {
  const api = useEvidenceApi(override);
  const framework = useApi(frameworkOverride);
  const me = useMe(framework);
  const [tab, setTab] = useState<Tab>('library');
  const canWrite = can(me.data, 'evidence:write');
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Evidence</h1>
      <div role="tablist" aria-label="Evidence" className="flex gap-1 border-b border-border">
        {TABS.map(([k, label]) => (
          <Button key={k} type="button" role="tab" aria-selected={tab === k} variant="ghost"
            className={`rounded-b-none ${tab === k ? 'border-b-2 border-primary font-medium' : ''}`} onClick={() => setTab(k)}>{label}</Button>
        ))}
      </div>
      {tab === 'library'
        ? <Library api={api} framework={framework} canWrite={canWrite} canReview={can(me.data, 'evidence:review')} />
        : <AllRequests api={api} canWrite={canWrite} />}
    </section>
  );
}

function Library({ api, framework, canWrite, canReview }: { api: EvidenceApi; framework: FrameworkApi; canWrite: boolean; canReview: boolean }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [adding, setAdding] = useState(false);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  // Archived items come along so the Archived filter needs no second request.
  const list = useQuery({ queryKey: ['evidence', q, 'with-archived'], queryFn: () => api.list(q || undefined, { includeArchived: true }) });
  const shown = (list.data ?? []).filter(FILTERS[filter].keep);
  const toggle = (id: string, open: boolean) => setOpened((s) => { const n = new Set(s); if (open) n.add(id); else n.delete(id); return n; });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input aria-label="Search evidence" placeholder="Search by title or tag" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
          {(Object.keys(FILTERS) as Filter[]).map((k) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}
              className={`rounded-full border px-3 py-1 text-xs ${filter === k ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}>{FILTERS[k].label}</button>
          ))}
        </div>
        {canWrite && <Button type="button" className="ms-auto" onClick={() => setAdding(true)}>+ Evidence</Button>}
      </div>
      <p className="text-sm text-muted-foreground">Evidence belongs to the institution: add it once, attach it to your internal framework, and link it to every accreditor requirement it supports, each with its own reason.</p>
      {adding && canWrite && (
        <NewEvidenceDialog api={api} dataWithoutFile onClose={() => setAdding(false)}
          onCreated={(item) => { setAdding(false); setFilter('all'); toggle(item.id, true); void qc.invalidateQueries({ queryKey: ['evidence'] }); }} />
      )}
      <div className="space-y-2" role="list" aria-label="Evidence">
        {shown.map((e) => (
          <div role="listitem" key={e.id}>
            <EvidenceCard item={e} api={api} framework={framework} canWrite={canWrite} canReview={canReview} open={opened.has(e.id)} onToggle={(o) => toggle(e.id, o)} />
          </div>
        ))}
        {list.data && shown.length === 0 && <p className="text-sm text-muted-foreground">{q || filter !== 'all' ? 'Nothing matches.' : 'No evidence yet.'}</p>}
        {list.isLoading && <p className="text-sm">Loading…</p>}
      </div>
    </div>
  );
}

/** Every request for evidence in the institution, open ones first, to follow up. */
function AllRequests({ api, canWrite }: { api: EvidenceApi; canWrite: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const list = useQuery({ queryKey: ['evidence-requests', 'all'], queryFn: () => api.requests(false) });
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Every request for evidence, open ones first. Ask for evidence from a standard’s ⋯ menu in the internal quality framework, or for an update from an item’s ⋯ menu in the library.</p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <Card>
        {list.data
          ? <RequestList requests={list.data} api={api} canManage={canWrite} showTarget setError={setError} onChange={() => void qc.invalidateQueries({ queryKey: ['evidence-requests'] })} />
          : <p className="text-sm">Loading…</p>}
      </Card>
    </div>
  );
}
