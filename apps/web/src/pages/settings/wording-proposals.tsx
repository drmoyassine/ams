// The wording stage's review (TASK-107): diffs the analysis proposed against the wording of the institution's own
// items, each backed by a quote from its documents. A person accepts or declines every one — nothing is applied by
// itself, and an accepted wording becomes one edit on the item (back to review, undoable). Decided ones stay on show.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WordingProposal } from '@ams/shared';
import { Button } from '../../components/ui/button';
import { ContentText } from '../../components/content-text';
import type { FrameworkApi } from '../../lib/framework-api';
import { useAction } from '../../lib/use-action';
import { DATE } from '../frameworks';

function Proposal({ p, editable, busy, onDecide }: {
  p: WordingProposal; editable: boolean; busy: boolean; onDecide: (id: string, accept: boolean) => void;
}) {
  return (
    <article className="space-y-2 rounded-md border border-border p-3" data-testid="wording-proposal">
      <div className="flex flex-wrap items-baseline gap-2">
        <h4 className="min-w-0 font-medium" dir="auto">Item {p.requirementCode}</h4>
        {p.status !== 'pending' ? (
          <span className={`rounded px-1.5 text-xs ${p.status === 'accepted' ? 'bg-emerald-50 text-emerald-900' : 'bg-muted text-muted-foreground'}`}>
            {p.status === 'accepted' ? 'Accepted' : 'Declined'}{p.decidedAt ? ` · ${DATE.format(new Date(p.decidedAt))}` : ''}
          </span>
        ) : editable ? (
          <span className="ms-auto flex gap-2">
            <Button type="button" disabled={busy} onClick={() => onDecide(p.id, true)}>Accept</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onDecide(p.id, false)}>Decline</Button>
          </span>
        ) : <span className="ms-auto text-xs text-muted-foreground">Waiting for a decision</span>}
      </div>
      <p className="break-words text-xs text-muted-foreground">Page {p.sourcePage}: “<ContentText>{p.sourceQuote}</ContentText>”</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Now</p>
          <p className="break-words text-sm line-through decoration-border" dir="auto">{p.currentText}</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Proposed</p>
          <p className="break-words text-sm" dir="auto">{p.proposedText}</p>
        </div>
      </div>
      {p.reason && <p className="break-words text-xs text-muted-foreground" dir="auto">{p.reason}</p>}
    </article>
  );
}

/** The wording proposals of one version (the internal quality framework's draft). Hidden while there are none. */
export function WordingProposals({ api, versionId, editable }: { api: FrameworkApi; versionId: string; editable: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['wording-proposals', versionId], queryFn: () => api.wordingProposals(versionId) });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = useAction(setError);
  const decide = (id: string, accept: boolean) => {
    setBusy(true);
    void run(() => api.decideWordingProposal(id, accept)).then(() => {
      // An acceptance rewrites the item, so the requirements and their validation go stale with the list.
      void qc.invalidateQueries({ queryKey: ['wording-proposals', versionId] });
      void qc.invalidateQueries({ queryKey: ['requirements', versionId] });
      void qc.invalidateQueries({ queryKey: ['validation'] });
    }).finally(() => setBusy(false));
  };
  const all = list.data ?? [];
  if (all.length === 0) return null;
  const pending = all.filter((p) => p.status === 'pending');
  const decided = all.filter((p) => p.status !== 'pending');
  return (
    <section aria-label="Wording proposals" className="space-y-2 rounded-md border border-border p-3">
      <h3 className="font-medium">Wording proposals
        <span className="ms-2 text-sm font-normal text-muted-foreground">{pending.length > 0 ? `${pending.length} waiting for you` : 'all decided'}</span>
      </h3>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {pending.map((p) => <Proposal key={p.id} p={p} editable={editable} busy={busy} onDecide={decide} />)}
      {decided.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{decided.length} decided earlier</summary>
          <div className="mt-2 space-y-2">
            {decided.map((p) => <Proposal key={p.id} p={p} editable={false} busy={busy} onDecide={decide} />)}
          </div>
        </details>
      )}
    </section>
  );
}
