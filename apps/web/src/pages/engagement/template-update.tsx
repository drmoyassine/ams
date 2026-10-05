import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import type { EngagementApi } from '../../lib/engagement-api';
import { useAction } from '../../lib/use-action';

const KIND = { added: 'Added', removed: 'Removed', redated: 'Re-dated', changed: 'Changed' } as const;

/** "Template updated — review changes" (PRD 8.5): the lead accepts or ignores each change; nothing happens by itself. */
export function TemplateUpdatePanel({ api, engagementId, canManage, onApplied }: { api: EngagementApi; engagementId: string; canManage: boolean; onApplied: () => void }) {
  const [open, setOpen] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, 'accept' | 'ignore'>>({});
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const act = useAction(setError);
  const { data, refetch } = useQuery({ queryKey: ['template-update', engagementId], queryFn: () => api.templateUpdate(engagementId) });
  const apply = useMutation({
    mutationFn: async () => {
      setError(null);
      const r = await act(() => api.applyTemplateUpdate(engagementId, { toVersionId: data!.toVersion!.id, decisions }));
      if (!r) return;
      setResult(`${r.applied.length} change(s) applied, ${r.left.length} left as they were.`);
      setOpen(false); setDecisions({});
      await refetch();
      onApplied();
    },
  });
  if (result && !data?.available) return <p role="status" className="mb-4 text-sm text-emerald-800">{result}</p>;
  if (!data?.available || !data.toVersion) return null;
  const all = data.changes.every((c) => decisions[c.id]);

  return (
    <Card className="mb-4 border-amber-300 bg-amber-50">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Template updated — review changes ({data.changes.length}). Edition {data.toVersion.edition} replaces {data.fromVersion.edition}; this engagement is unchanged until you decide.</p>
        <Button type="button" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Close' : 'Review changes'}</Button>
      </div>
      {open && (
        <div className="mt-3">
          {data.changes.length === 0 && <p className="text-sm">No milestone changes. Accepting records the new edition as reviewed.</p>}
          <ul className="divide-y divide-border" aria-label="Template changes">
            {data.changes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 py-2 text-sm">
                <div>
                  <span className="me-2 rounded border border-border bg-background px-2 py-0.5 text-xs">{KIND[c.kind]}</span>
                  <ContentText>{c.name}</ContentText> <span className="text-muted-foreground">({c.phase.replace('_', ' ')})</span>
                  {c.kind === 'redated' && <div className="text-xs text-muted-foreground">Due {String((c.before as { dueDate?: string })?.dueDate ?? 'not set')} → {String((c.after as { dueDate?: string })?.dueDate ?? 'not set')}</div>}
                  {c.protectedByEdit && <div className="text-xs text-amber-900">You changed this milestone, so accepting will not overwrite it.</div>}
                  {c.blocked && <div className="text-xs text-amber-900">{c.blocked}.</div>}
                </div>
                {canManage && (
                  <div className="flex gap-3" role="radiogroup" aria-label={`Decision for ${c.name}`}>
                    {(['accept', 'ignore'] as const).map((d) => (
                      <label key={d}><input type="radio" name={c.id} checked={decisions[c.id] === d} onChange={() => setDecisions({ ...decisions, [c.id]: d })} /> {d === 'accept' ? 'Accept' : 'Ignore'}</label>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
          {canManage && <div className="mt-3"><Button type="button" disabled={!all || apply.isPending} onClick={() => apply.mutate()}>Apply decisions</Button></div>}
        </div>
      )}
    </Card>
  );
}
