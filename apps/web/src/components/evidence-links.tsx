import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EvidenceLink } from '@ams/shared';
import type { EvidenceApi } from '../lib/evidence-api';
import { ContentText } from './content-text';
import { Button } from './ui/button';
import { Input } from './ui/input';

const REVIEW = { proposed: 'Proposed', approved: 'Approved', rejected: 'Rejected' } as const;
const REVIEW_CLS = { proposed: 'bg-muted text-muted-foreground', approved: 'bg-emerald-50 text-emerald-900', rejected: 'bg-red-50 text-red-900' } as const;
const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';

/** Evidence links with their reason, review state and the flags the PRD asks for (newer version, stale). */
export function EvidenceLinkList({ links, api, canReview, canRemove, onChange, setError, showTarget = false }: {
  links: EvidenceLink[]; api: EvidenceApi; canReview: boolean; canRemove: boolean; onChange: () => void; setError: (m: string) => void; showTarget?: boolean;
}) {
  const act = (fn: () => Promise<unknown>) => { setError(''); fn().then(onChange, (e: Error) => setError(e.message)); };
  if (links.length === 0) return <p className="text-sm text-muted-foreground">No evidence linked yet.</p>;
  return (
    <ul className="space-y-2">
      {links.map((l) => (
        <li key={l.id} className="rounded-md border border-border p-2 text-sm" data-testid="evidence-link">
          <div className="flex flex-wrap items-center gap-2">
            {showTarget
              ? <span className="font-medium"><ContentText>{l.target.kind === 'internal' ? `Internal ${l.target.code}${l.target.title ? ` · ${l.target.title}` : ''}` : `${l.target.engagementTitle ?? ''} · ${l.target.code}`}</ContentText></span>
              : <a className="font-medium underline" href={api.fileUrl(l.evidenceVersionId)} target="_blank" rel="noreferrer"><ContentText>{l.evidenceTitle}</ContentText></a>}
            <span className="text-xs text-muted-foreground">v{l.versionNo}{l.periodLabel ? ` · ${l.periodLabel}` : ''}</span>
            <span className={`rounded px-1.5 text-xs ${REVIEW_CLS[l.reviewStatus]}`}>{REVIEW[l.reviewStatus]}</span>
            {l.newerVersionAvailable && <span className="rounded bg-amber-50 px-1.5 text-xs text-amber-900">Newer version available (v{l.latestVersionNo})</span>}
            {l.stale && <span className="rounded bg-amber-50 px-1.5 text-xs text-amber-900" title="The evidence period is older than this review allows">Stale</span>}
          </div>
          <p className="mt-1"><ContentText>{l.rationale}</ContentText></p>
          {l.reviewComment && <p className="text-xs text-muted-foreground">Review: <ContentText>{l.reviewComment}</ContentText></p>}
          <div className="mt-1 flex flex-wrap gap-2">
            {canReview && l.reviewStatus !== 'approved' && <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => act(() => api.review(l.id, { decision: 'approved' }))}>Approve</Button>}
            {canReview && l.reviewStatus === 'proposed' && <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => act(() => api.review(l.id, { decision: 'rejected' }))}>Reject</Button>}
            {(canRemove || canReview) && <Button type="button" variant="ghost" className="px-2 py-1" aria-label={`Remove link to ${l.evidenceTitle}`} onClick={() => act(() => api.remove(l.id))}>Remove</Button>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Pick an evidence item (its newest version) and say why it supports this. */
export function LinkEvidenceForm({ api, onLink, label = 'Link evidence' }: { api: EvidenceApi; onLink: (evidenceVersionId: string, rationale: string) => Promise<unknown>; label?: string }) {
  const list = useQuery({ queryKey: ['evidence', ''], queryFn: () => api.list() });
  const [rationale, setRationale] = useState('');
  const usable = (list.data ?? []).filter((e) => e.latest && e.status === 'active');
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const version = String(new FormData(form).get('version'));
    if (!version || !rationale.trim()) return;
    void onLink(version, rationale.trim()).then(() => { setRationale(''); form.reset(); });
  };
  return (
    <form onSubmit={submit} aria-label={label} className="space-y-2 rounded border border-dashed border-border p-2">
      <select name="version" aria-label="Evidence" required defaultValue="" className={`${select} w-full`}>
        <option value="" disabled>{usable.length ? 'Choose evidence…' : 'No evidence yet: add some on the Evidence page'}</option>
        {usable.map((e) => <option key={e.id} value={e.latest!.id}>{e.title} (v{e.latest!.versionNo}{e.periodLabel ? `, ${e.periodLabel}` : ''})</option>)}
      </select>
      <Input aria-label="Why it supports this" placeholder="Why it supports this (required)" value={rationale} onChange={(e) => setRationale(e.target.value)} dir="auto" />
      <Button type="submit" disabled={!rationale.trim()}>{label}</Button>
    </form>
  );
}
