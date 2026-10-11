import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AiMarker } from '../../components/badges';
import { ContentText } from '../../components/content-text';
import { Dialog } from '../../components/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { requirementLabel } from '../../lib/format';
import type { FrameworkApi, IqfItemProposal, Mapping, Mappings } from '../../lib/framework-api';
import { useAction } from '../../lib/use-action';

const RELATION = { covers: 'Covers', partly_covers: 'Partly covers', related: 'Related' } as const;
type View = 'suggested' | 'accepted' | 'rejected';
const VIEW_LABEL: Record<View, string> = { suggested: 'Suggested', accepted: 'Accepted', rejected: 'Rejected' };
const naturalCompare = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** The suggested links of the view, grouped by external requirement (the AI's, still to be decided, or decided by a person). */
const inView = (m: Mapping, view: View) => m.origin === 'ai' && m.reviewStatus === (view === 'suggested' ? 'pending' : view === 'accepted' ? 'approved' : 'rejected');

/**
 * What the analysis suggests for this standard: links to the institution's quality framework (the IQF) and new IQF items.
 * Only suggestions until a person accepts them. Never a score: the relation and the model's reason are all it shows.
 */
export function Suggestions({ api, versionId, maps, requirements, canReview, canWrite, onChanged }: {
  api: FrameworkApi; versionId: string; maps: Mappings; requirements: { code: string; title: string }[]; canReview: boolean; canWrite: boolean; onChanged: () => void;
}) {
  const [view, setView] = useState<View>('suggested');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState<IqfItemProposal | null>(null);
  const run = useAction(setError);
  const proposals = useQuery({ queryKey: ['iqf-proposals', versionId], queryFn: () => api.iqfProposals(versionId) });
  const act = (fn: () => Promise<unknown>) => { setError(''); setNotice(''); void run(fn).then(() => onChanged()); };

  const counts: Record<View, number> = { suggested: 0, accepted: 0, rejected: 0 };
  for (const m of maps.mappings) for (const v of Object.keys(counts) as View[]) if (inView(m, v)) counts[v]++;
  const pending = (proposals.data?.proposals ?? []).filter((p) => p.status === 'pending');
  const decided = (proposals.data?.proposals ?? []).filter((p) => p.status !== 'pending');
  if (counts.suggested + counts.accepted + counts.rejected === 0 && pending.length === 0 && decided.length === 0) return null;

  const titleOf = new Map(requirements.map((r) => [r.code, r.title]));
  const shown = maps.mappings.filter((m) => inView(m, view));
  const groups = [...new Set(shown.map((m) => m.externalCode))].sort(naturalCompare);
  const covers = shown.filter((m) => m.relation === 'covers');

  return (
    <section aria-label="Suggestions from the analysis" className="mb-6 space-y-6 rounded-md border border-border p-3">
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">Suggested links</h3>
          <div role="group" aria-label="Show links" className="flex flex-wrap gap-1">
            {(Object.keys(VIEW_LABEL) as View[]).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
                className={`rounded-md border px-2 py-1 text-sm ${view === v ? 'border-foreground bg-muted font-medium' : 'border-border hover:bg-muted'}`}>
                {VIEW_LABEL[v]} <span className="text-muted-foreground">({counts[v]})</span>
              </button>
            ))}
          </div>
          {canReview && view === 'suggested' && covers.length > 0 && (
            <Button type="button" variant="outline" className="ms-auto" onClick={() => setConfirming(true)}>Accept all that cover ({covers.length})</Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          The analysis compared each requirement with the items of your internal quality framework (IQF). A suggestion is only a proposal, with the reason it gives; nothing counts until a person accepts it.
        </p>
        {groups.length === 0 && <p className="text-sm text-muted-foreground">{view === 'suggested' ? 'No suggested links waiting.' : `No ${VIEW_LABEL[view].toLowerCase()} links.`}</p>}
        <ul className="space-y-3">
          {groups.map((code) => (
            <li key={code} data-testid="suggestion-group" className="space-y-1">
              <h4 className="text-sm font-medium break-words"><ContentText>{requirementLabel(code, titleOf.get(code) ?? '')}</ContentText></h4>
              <ul className="space-y-2">
                {shown.filter((m) => m.externalCode === code).sort((a, b) => naturalCompare(a.internalCode, b.internalCode)).map((m) => (
                  <li key={m.id} data-testid="suggested-link" className="rounded-md border border-border p-2 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="rounded bg-muted px-1.5 text-xs font-medium">{RELATION[m.relation]}</span>
                      <span className="min-w-0 break-words"><ContentText>{requirementLabel(m.internalCode, m.internalTitle ?? '')}</ContentText></span>
                      {m.internalRequirementId === null && <span className="text-xs text-muted-foreground">(not in the published IQF yet)</span>}
                      <AiMarker />
                    </div>
                    {m.rationale && <p className="mt-1 break-words text-muted-foreground"><ContentText>{m.rationale}</ContentText></p>}
                    {canReview && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {m.reviewStatus !== 'approved' && <Button type="button" aria-label={`Accept link of ${code} to ${m.internalCode}`} onClick={() => act(() => api.reviewMapping(m.id, 'approved'))}>Accept</Button>}
                        {m.reviewStatus !== 'rejected' && <Button type="button" variant="ghost" aria-label={`Reject link of ${code} to ${m.internalCode}`} onClick={() => act(() => api.reviewMapping(m.id, 'rejected'))}>Reject</Button>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>

      {(pending.length > 0 || decided.length > 0) && (
        <div className="space-y-3">
          <h3 className="font-medium">Suggested new IQF items</h3>
          <p className="text-xs text-muted-foreground">
            Nothing in your IQF fits these requirements. The analysis drafted an item for each group, in your IQF's own words. Accepting adds it to the IQF's draft version and links the requirements.
          </p>
          {proposals.data && proposals.data.draftVersionId === null && pending.length > 0 && (
            <p role="note" className="rounded bg-amber-50 px-2 py-1 text-sm text-amber-900">
              Your quality framework has no draft version, so nothing can be added yet. <Link to="/settings/quality-framework" className="underline">Start a new version of the IQF</Link>, then come back to accept.
            </p>
          )}
          <ul className="space-y-3">
            {pending.map((p) => (
              <li key={p.id}>
                <section aria-label={`Suggested new IQF item ${p.code}`} data-testid="suggested-item" className="space-y-2 rounded-md border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words font-medium"><ContentText>{requirementLabel(p.code, p.title)}</ContentText></span>
                    <span className="rounded bg-muted px-1.5 text-xs">{p.levelLabel}</span>
                    <AiMarker />
                    <span className="text-xs text-muted-foreground">AI-drafted</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{p.parentCode ? <>Under <ContentText>{requirementLabel(p.parentCode, p.parentTitle ?? '')}</ContentText></> : 'At the top level'}</p>
                  {p.description && <p className="break-words"><ContentText>{p.description}</ContentText></p>}
                  {p.reason && <p className="break-words text-muted-foreground"><ContentText>{p.reason}</ContentText></p>}
                  <div>
                    <p className="text-xs font-medium">Would answer</p>
                    <ul className="list-disc ps-5">
                      {p.links.map((l) => (
                        <li key={l.externalCode} className="break-words">
                          <ContentText>{requirementLabel(l.externalCode, l.externalTitle ?? '')}</ContentText> <span className="text-muted-foreground">({RELATION[l.relation].toLowerCase()})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {canReview && (
                    <div className="flex flex-wrap gap-2">
                      {canWrite && <Button type="button" disabled={proposals.data?.draftVersionId === null} aria-label={`Accept suggested item ${p.code}`} onClick={() => { setError(''); setEditing(p); }}>Accept…</Button>}
                      <Button type="button" variant="ghost" aria-label={`Dismiss suggested item ${p.code}`} onClick={() => act(() => api.dismissIqfProposal(p.id))}>Dismiss</Button>
                    </div>
                  )}
                </section>
              </li>
            ))}
          </ul>
          {decided.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {decided.filter((p) => p.status === 'accepted').length} accepted, {decided.filter((p) => p.status === 'dismissed').length} dismissed. A later analysis does not suggest them again.
            </p>
          )}
        </div>
      )}

      {confirming && (
        <ConfirmCovers count={covers.length} onClose={() => setConfirming(false)} onConfirm={() => {
          setConfirming(false);
          setError(''); setNotice('');
          void run(() => api.acceptCovers(versionId, covers.map((m) => m.id))).then((r) => {
            if (r) setNotice(`Accepted ${r.accepted} link${r.accepted === 1 ? '' : 's'}${r.skipped ? `; ${r.skipped} left as they were` : ''}.`);
            onChanged();
          });
        }} />
      )}
      {editing && <AcceptItemDialog proposal={editing} options={maps.internalOptions} api={api} onClose={() => setEditing(null)} onDone={() => { setEditing(null); setNotice('Added to the IQF draft.'); onChanged(); }} />}
    </section>
  );
}

function ConfirmCovers({ count, onClose, onConfirm }: { count: number; onClose: () => void; onConfirm: () => void }) {
  return (
    <Dialog labelledBy="accept-covers-title" onClose={onClose} size="sm">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="accept-covers-title" className="min-w-0 pt-1 text-lg font-semibold break-words">Accept {count} suggested link{count === 1 ? '' : 's'}?</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <p className="text-sm">Only the suggested links that say "Covers" in this list are accepted. Links that only partly cover or are related stay as suggestions. You can still change or remove any accepted link.</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="button" onClick={onConfirm}>Accept {count} link{count === 1 ? '' : 's'}</Button>
      </div>
    </Dialog>
  );
}

/** Accepting a suggested new IQF item: the person may change its code, title, description and where it goes first. */
function AcceptItemDialog({ proposal, options, api, onClose, onDone }: {
  proposal: IqfItemProposal; options: Mappings['internalOptions']; api: FrameworkApi; onClose: () => void; onDone: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = useAction(setError);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parent = String(f.get('parent'));
    setBusy(true); setError('');
    void run(() => api.acceptIqfProposal(proposal.id, {
      code: String(f.get('code')).trim(), title: String(f.get('title')).trim(), description: String(f.get('description')).trim() || null, parentCode: parent || null,
    })).then((r) => { setBusy(false); if (r) onDone(); });
  };
  return (
    <Dialog labelledBy="accept-item-title" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="accept-item-title" className="min-w-0 pt-1 text-lg font-semibold break-words">Accept suggested new IQF item</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <form onSubmit={submit} aria-label="Accept suggested new IQF item" className="space-y-3">
        <p className="text-sm text-muted-foreground">It is added to the draft of your quality framework, marked as made by the AI and still to be approved when the version is published. The requirements it answers are linked.</p>
        <label className="flex flex-col text-sm">Code<Input name="code" aria-label="Code" required defaultValue={proposal.code} dir="auto" /></label>
        <label className="flex flex-col text-sm">Title<Input name="title" aria-label="Title" required defaultValue={proposal.title} dir="auto" /></label>
        <label className="flex flex-col text-sm">Description
          <textarea name="description" aria-label="Description" rows={4} dir="auto" defaultValue={proposal.description ?? ''} className="rounded-md border border-border bg-background p-2 text-sm" />
        </label>
        <label className="flex flex-col text-sm">Goes under
          <select name="parent" aria-label="Goes under" defaultValue={proposal.parentCode ?? ''} className="rounded-md border border-border bg-background px-2 py-2 text-sm">
            <option value="">Top level</option>
            {options.map((o) => <option key={o.id} value={o.code}>{requirementLabel(o.code, o.title)}</option>)}
          </select>
        </label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Adding…' : 'Accept and add to the IQF draft'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
