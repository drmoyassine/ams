import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AuthorityBadge, REQUIREMENT_STATUS, RequirementStatusBadge } from '../components/badges';
import { ContentText } from '../components/content-text';
import { TermModeSelect } from '../components/term-mode';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { EvidenceLinkList } from '../components/evidence-links';
import { LinkEvidenceDialog } from '../components/link-evidence-dialog';
import { useEngagementApi, type EngagementApi } from '../lib/engagement-api';
import { useEvidenceApi, type EvidenceApi } from '../lib/evidence-api';
import { ApiError } from '../lib/framework-api';
import { requirementLabel } from '../lib/format';
import { useLevelLabel } from '../lib/glossary-api';
import { useAction } from '../lib/use-action';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
const NOTE_TYPE = { guidance: 'Guidance', evidence_expectation: 'Evidence expected', data_request: 'Data requested', quantitative_norm: 'Quantitative norm' } as const;

const RELATION = { covers: 'covers', partly_covers: 'partly covers', related: 'is related to' } as const;

/**
 * Evidence on this requirement (PRD 9.2, DEC-016): what is linked, with its reason and review; what the internal
 * framework already holds for it through the mappings, offered to link with this requirement's own reason; and any
 * other evidence from the repository.
 */
function RequirementEvidence({ id, canLink, canReview, evidence }: { id: string; canLink: boolean; canReview: boolean; evidence?: EvidenceApi }) {
  const api = useEvidenceApi(evidence);
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [linking, setLinking] = useState(false);
  const links = useQuery({ queryKey: ['er-evidence', id], queryFn: () => api.requirementLinks(id) });
  const suggestions = useQuery({ queryKey: ['er-suggestions', id], queryFn: () => api.suggestions(id) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['er-evidence', id] }); void qc.invalidateQueries({ queryKey: ['er-suggestions', id] }); };
  const link = (evidenceVersionId: string, rationale: string) => api.linkRequirement(id, { evidenceVersionId, rationale }).then(refresh, (e: Error) => setError(e.message));
  return (
    <Card>
      <section aria-label="Evidence">
      <h2 className="mb-2 text-lg font-semibold">Evidence</h2>
      {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
      <EvidenceLinkList links={links.data ?? []} api={api} canReview={canReview} canRemove={canLink} onChange={refresh} setError={setError} />
      {(suggestions.data ?? []).length > 0 && (
        <section aria-label="Suggested from your framework" className="mt-4 space-y-2">
          <h3 className="font-medium">Suggested from your framework</h3>
          <p className="text-xs text-muted-foreground">Evidence already attached to the internal items this requirement is mapped to. Linking it here needs this requirement's own justification.</p>
          <ul className="space-y-2">
            {suggestions.data!.map((s) => (
              <li key={s.evidenceVersionId} className="rounded-md border border-dashed border-border p-2 text-sm" data-testid="evidence-suggestion">
                <p><a className="font-medium underline" href={api.fileUrl(s.evidenceVersionId)} target="_blank" rel="noreferrer"><ContentText>{s.title}</ContentText></a> <span className="text-xs text-muted-foreground">v{s.versionNo}{s.periodLabel ? ` · ${s.periodLabel}` : ''}</span></p>
                <p className="text-xs text-muted-foreground">On internal {s.internalCode}{s.internalTitle ? ` · ${s.internalTitle}` : ''}, which {RELATION[s.relation]} this requirement: “<ContentText>{s.internalRationale}</ContentText>”</p>
                {canLink && (
                  <form className="mt-1 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); const r = (reasons[s.evidenceVersionId] ?? '').trim(); if (r) void link(s.evidenceVersionId, r); }}>
                    <Input aria-label={`Justification for ${s.title}`} placeholder="Justification: why it supports this requirement (required)" dir="auto" className="min-w-64 flex-1"
                      value={reasons[s.evidenceVersionId] ?? ''} onChange={(e) => { const v = e.target.value; setReasons((x) => ({ ...x, [s.evidenceVersionId]: v })); }} />
                    <Button type="submit" disabled={!(reasons[s.evidenceVersionId] ?? '').trim()}>Link</Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {canLink && <div className="mt-4"><Button type="button" variant="ghost" onClick={() => setLinking(true)}>+ Link other evidence</Button></div>}
      {linking && <LinkEvidenceDialog api={api} title="this requirement" onClose={() => setLinking(false)} onLink={(v, j) => api.linkRequirement(id, { evidenceVersionId: v, rationale: j }).then(refresh)} />}
      </section>
    </Card>
  );
}

/** One page per engagement requirement (PRD 8.4): context, work, evidence, reporting, history. */
export function RequirementWorkspacePage({ id, api: override, evidence }: { id: string; api?: EngagementApi; evidence?: EvidenceApi }) {
  const api = useEngagementApi(override);
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const act = useAction(setError);
  const { data: ws, isError, error: loadError } = useQuery({ queryKey: ['workspace', id], queryFn: () => api.workspace(id) });
  const engagementId = ws?.item.engagementId;
  const levelLabel = useLevelLabel(api);
  const engagement = useQuery({ queryKey: ['engagement', ws?.item.engagementId], queryFn: () => api.get(ws!.item.engagementId), enabled: !!ws });
  const members = useQuery({ queryKey: ['members', engagementId], queryFn: () => api.members(engagementId!), enabled: !!engagementId });
  const run = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => { setError(null); return act(fn); },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['workspace', id] }); await qc.invalidateQueries({ queryKey: ['engagement-requirements', engagementId] }); },
  });

  if (isError) return <p role="alert">{loadError instanceof ApiError ? loadError.message : 'Could not load the requirement.'}</p>;
  if (!ws) return <p>Loading…</p>;
  const { item, requirement: r } = ws;
  const people = (roles: string[]) => (members.data ?? []).filter((m) => roles.includes(m.role));
  const grouped = Object.entries(NOTE_TYPE).map(([type, label]) => ({ label, notes: ws.notes.filter((n) => n.type === type) })).filter((g) => g.notes.length);

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm"><Link to="/engagements/$id" params={{ id: item.engagementId }} className="underline">← Back to the engagement</Link></p>
        <TermModeSelect />
      </div>
      <header className="mb-4">
        {engagement.data && <p className="text-xs text-muted-foreground" data-testid="level">{levelLabel(engagement.data.engagement.frameworkId, r.levelLabel)}</p>}
        <p className="text-sm text-muted-foreground">{r.path.map((p) => p.code).join(' › ')}{r.path.length > 0 && ' ›'}</p>
        <h1 className="text-2xl font-semibold"><ContentText>{requirementLabel(r.code, r.title, ' — ')}</ContentText></h1>
        <p className="mt-1 flex items-center gap-2 text-sm">{item.applicable ? <RequirementStatusBadge status={item.status} /> : <span className="rounded border border-border px-2 py-0.5">Not applicable{item.naReason ? `: ${item.naReason}` : ''}</span>}</p>
      </header>
      {error && <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card aria-label="Context">
          <h2 className="mb-2 text-lg font-semibold">Context</h2>
          {r.officialText ? (
            <>
              <p dir="auto" lang={r.language} className="whitespace-pre-wrap" data-testid="official-text">{showTranslation && r.translationEn ? r.translationEn : r.officialText}</p>
              {r.translationEn && <Button type="button" variant="ghost" className="mt-1 px-2 py-1" onClick={() => setShowTranslation(!showTranslation)}>{showTranslation ? 'Show original' : 'Show English translation'}</Button>}
            </>
          ) : <p className="text-sm text-muted-foreground">This is a heading; its official text is in the items below it.</p>}
          {r.source && <p className="mt-2 text-xs text-muted-foreground">Source: page {r.source.page}{r.source.quoteVerified ? ' · quote verified' : ' · quote not verified'}</p>}
          {grouped.map((g) => (
            <div key={g.label} className="mt-3">
              <h3 className="text-sm font-medium">{g.label}</h3>
              <ul className="mt-1 space-y-2">
                {g.notes.map((n) => (
                  <li key={n.id} className="text-sm">
                    <AuthorityBadge authority={n.authority} /> <ContentText>{n.text}</ContentText>
                    {n.source && <span className="ms-1 text-xs text-muted-foreground">(page {n.source.page}{n.source.quoteVerified ? ', verified' : ''})</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Card>

        <Card aria-label="Work">
          <h2 className="mb-2 text-lg font-semibold">Work</h2>
          {ws.canAssign && item.applicable ? (
            <div className="mb-3 flex flex-wrap gap-3">
              <label className="flex flex-col text-xs">Owner
                <select aria-label="Owner" className={select} value={item.ownerId ?? ''} onChange={(e) => { const ownerId = e.target.value || null; run.mutate(() => api.work(id, { ownerId })); }}>
                  <option value="">Unassigned</option>
                  {people(['engagement_lead', 'co_lead', 'contributor']).map((m) => <option key={m.userId} value={m.userId}>{m.fullName}</option>)}
                </select>
              </label>
              <label className="flex flex-col text-xs">Reviewer
                <select aria-label="Reviewer" className={select} value={item.reviewerId ?? ''} onChange={(e) => { const reviewerId = e.target.value || null; run.mutate(() => api.work(id, { reviewerId })); }}>
                  <option value="">Unassigned</option>
                  {people(['engagement_lead', 'co_lead', 'reviewer']).map((m) => <option key={m.userId} value={m.userId}>{m.fullName}</option>)}
                </select>
              </label>
              <label className="flex flex-col text-xs">Due date
                <Input aria-label="Due date" type="date" defaultValue={item.dueDate ?? ''} onBlur={(e) => { const dueDate = e.target.value; if (dueDate !== (item.dueDate ?? '')) run.mutate(() => api.work(id, { dueDate: dueDate || null })); }} />
              </label>
            </div>
          ) : (
            <p className="mb-3 text-sm text-muted-foreground">
              Owner: {members.data?.find((m) => m.userId === item.ownerId)?.fullName ?? 'unassigned'} · Reviewer: {members.data?.find((m) => m.userId === item.reviewerId)?.fullName ?? 'unassigned'}{item.dueDate && ` · due ${item.dueDate}`}
            </p>
          )}
          {ws.allowedStatuses.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="Status actions">
              <span className="text-sm">Move to:</span>
              {ws.allowedStatuses.map((s) => <Button key={s} type="button" onClick={() => run.mutate(() => api.work(id, { status: s }))}>{REQUIREMENT_STATUS[s]}</Button>)}
            </div>
          )}
          <label className="flex flex-col gap-1 text-sm">Working notes
            <textarea aria-label="Working notes" dir="auto" rows={6} disabled={!ws.canEdit} value={notes ?? ws.workingNotes ?? ''} onChange={(e) => setNotes(e.target.value)} className="rounded-md border border-border p-2 text-sm disabled:opacity-60" />
          </label>
          {ws.canEdit && <Button type="button" className="mt-2" disabled={notes === null} onClick={() => { run.mutate(() => api.work(id, { workingNotes: notes })); setNotes(null); }}>Save notes</Button>}
          {ws.canAssign && (
            <form className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-3" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) { run.mutate(() => api.applicability(id, { applicable: !item.applicable, reason })); setReason(''); } }}>
              <label className="flex flex-1 flex-col text-xs">{item.applicable ? 'Mark as not applicable to this engagement' : 'Switch on for this engagement'} (reason)
                <Input aria-label="Applicability reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <Button type="submit" disabled={!reason.trim()}>{item.applicable ? 'Mark not applicable' : 'Switch on'}</Button>
            </form>
          )}
        </Card>

        <RequirementEvidence id={id} canLink={ws.canLinkEvidence} canReview={ws.canReviewEvidence} {...(evidence ? { evidence } : {})} />

        <Card aria-label="Reporting">
          <h2 className="mb-2 text-lg font-semibold">Reporting</h2>
          {ws.reports.length === 0 ? <p className="text-sm text-muted-foreground">No report section cites this requirement yet.</p> : (
            <ul className="text-sm">{ws.reports.map((x) => <li key={`${x.reportId}${x.sectionKey}`}>{x.title} · {x.sectionKey}</li>)}</ul>
          )}
        </Card>

        <Card aria-label="History">
          <h2 className="mb-2 text-lg font-semibold">History</h2>
          <ul className="space-y-2 text-sm">
            {ws.history.map((h, n) => (
              <li key={n}>
                <span className="text-muted-foreground">{new Date(h.at).toLocaleString()}</span> · {h.actorName ?? 'System'} · {h.action}
                {Object.entries(h.changes).map(([k, c]) => <div key={k} className="text-xs text-muted-foreground">{k.replace(/_/g, ' ')}: {String(c.from ?? '—')} → {String(c.to ?? '—')}</div>)}
              </li>
            ))}
            {ws.history.length === 0 && <li className="text-muted-foreground">No changes yet.</li>}
          </ul>
        </Card>
      </div>
    </section>
  );
}
