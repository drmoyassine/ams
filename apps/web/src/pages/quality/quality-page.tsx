// Quality Management (DEC-048): one tab per top-level IQF standard the person is linked to by scope, nothing more. Inside a tab the
// standard and its sub-standards are read-only; below them, the person's submissions (a scoped course, program, unit or the institution
// for a period) with their status. A submission asks for the evidence linked to the standard; the person who submits for the item
// answers each with a version (uploaded, or one to reuse) and submits it; it then goes step by step through its approval chain (the
// standard's steps, the QA office, the champion) to "Internally approved". Nothing here says met or compliant (DEC-005).
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SUBMISSION_STATUS_LABEL, type QualityStandardNode, type SubmissionDetail, type SubmissionSummary } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { PageHeader } from '../../components/page-header';
import { Button } from '../../components/ui/button';
import { useEvidenceApi, type EvidenceApi } from '../../lib/evidence-api';
import { useQualityApi, type QualityApi } from '../../lib/quality-api';
import { useAction } from '../../lib/use-action';

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const TONE: Record<SubmissionSummary['status'], string> = {
  not_started: 'border-border bg-muted text-muted-foreground', draft: 'border-sky-300 bg-sky-50 text-sky-900', submitted: 'border-violet-300 bg-violet-50 text-violet-900',
  returned: 'border-amber-300 bg-amber-50 text-amber-950', approved: 'border-emerald-300 bg-emerald-50 text-emerald-900',
};
/** A submission's place in the address: standard code, item kind and id, period. */
export const openKey = (s: Pick<SubmissionSummary, 'code' | 'subjectKind' | 'subjectId' | 'periodKey'>) => [s.code, s.subjectKind, s.subjectId ?? '', s.periodKey].join('~');
const parseOpen = (k: string) => { const [code, subjectKind, subjectId, periodKey] = k.split('~'); return code && subjectKind && periodKey ? { code, subjectKind: subjectKind as SubmissionSummary['subjectKind'], subjectId: subjectId || null, periodKey } : null; };

export function StatusChip({ status }: { status: SubmissionSummary['status'] }) {
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${TONE[status]}`} data-testid="submission-status">{SUBMISSION_STATUS_LABEL[status]}</span>;
}

export function QualityPage({ api: override, evidence, tab, period, open, onNavigate }: {
  api?: QualityApi; evidence?: EvidenceApi; tab?: string | undefined; period?: string | undefined; open?: string | undefined;
  /** Writes the tab, period and open submission back to the address; without it the page keeps them itself. */
  onNavigate?: (next: { tab?: string | undefined; period?: string | undefined; open?: string | undefined }) => void;
}) {
  const api = useQualityApi(override);
  const [own, setOwn] = useState<{ tab?: string | undefined; period?: string | undefined; open?: string | undefined }>({});
  const state = onNavigate ? { tab, period, open } : own;
  const go = (next: typeof state) => (onNavigate ? onNavigate(next) : setOwn(next));
  const tabs = useQuery({ queryKey: ['quality-tabs'], queryFn: () => api.tabs() });
  const list = tabs.data?.tabs ?? [];
  const current = list.find((t) => t.code === state.tab) ?? list[0];
  return (
    <div className="space-y-4">
      <PageHeader title="Quality Management" intro="The IQF standards you submit or approve evidence for, each on the frequency set for it." />
      {tabs.isError && <p role="alert" className="text-sm text-red-700">Could not load your standards.</p>}
      {tabs.data && !list.length && (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-testid="no-standards">
          No IQF standard is assigned to you yet. A standard appears here when its scope covers a course, program or unit you coordinate or head, or when you approve for it.
        </p>
      )}
      {list.length > 0 && (
        <div role="tablist" aria-label="IQF standards" className="flex gap-1 overflow-x-auto border-b border-border">
          {list.map((t) => (
            <button key={t.code} type="button" role="tab" aria-selected={current?.code === t.code} onClick={() => go({ tab: t.code })}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${current?.code === t.code ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              <span className="font-mono text-xs">{t.code}</span> <ContentText>{t.title}</ContentText>
              {t.toSubmit > 0 && <span className="rounded-full bg-sky-100 px-1.5 text-xs text-sky-900" aria-label={`${t.toSubmit} to submit`}>{t.toSubmit}</span>}
              {t.toApprove > 0 && <span className="rounded-full bg-violet-100 px-1.5 text-xs text-violet-900" aria-label={`${t.toApprove} to approve`}>{t.toApprove}</span>}
            </button>
          ))}
        </div>
      )}
      {current && (
        <StandardTab key={current.code} api={api} {...(evidence ? { evidence } : {})} code={current.code} readOnly={current.roles.length === 1 && current.roles[0] === 'read'}
          period={state.period} open={state.open}
          onPeriod={(p) => go({ tab: current.code, period: p })} onOpen={(o) => go({ tab: current.code, period: state.period, open: o })} />
      )}
      <p className="border-t border-border pt-3 text-xs text-muted-foreground">
        The earlier screens (Standards, Cycles, Plans, Programs, Syllabi, My work) are kept at <Link to="/quality-management/legacy" className="underline underline-offset-2">Quality Management: earlier screens</Link> until it is decided where they go.
      </p>
    </div>
  );
}

function StandardTree({ node }: { node: QualityStandardNode }) {
  return (
    <li className="space-y-1">
      <p className="text-sm"><span className="font-mono text-xs text-muted-foreground">{node.code}</span> <span className="font-medium"><ContentText>{node.title}</ContentText></span>
        {node.frequency && <span className="ms-2 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground" data-testid="frequency">{node.frequency}</span>}</p>
      {node.statement && <p className="text-xs text-muted-foreground" dir="auto"><ContentText>{node.statement}</ContentText></p>}
      {node.evidence.length > 0 && <p className="text-xs">Evidence: {node.evidence.map((e) => e.title).join(' · ')}</p>}
      {node.children.length > 0 && <ul className="ms-4 space-y-2 border-s border-border ps-3">{node.children.map((c) => <StandardTree key={c.code} node={c} />)}</ul>}
    </li>
  );
}

function StandardTab({ api, evidence, code, readOnly, period, open, onPeriod, onOpen }: {
  api: QualityApi; evidence?: EvidenceApi; code: string; readOnly: boolean; period?: string | undefined; open?: string | undefined;
  onPeriod: (p: string | undefined) => void; onOpen: (o: string | undefined) => void;
}) {
  const q = useQuery({ queryKey: ['quality-tab', code, period ?? 'current'], queryFn: () => api.tab(code, period) });
  const d = q.data;
  if (q.isError) return <p role="alert" className="text-sm text-red-700">Could not load the standard.</p>;
  if (!d) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const opened = open ? parseOpen(open) : null;
  return (
    <div className="space-y-4" role="tabpanel" aria-label={d.standard.title}>
      <details className="rounded-lg border border-border p-3" open>
        <summary className="cursor-pointer text-sm font-semibold">The standard</summary>
        <ul className="mt-2 space-y-2" aria-label="Standard and sub-standards"><StandardTree node={d.standard} /></ul>
      </details>
      <section aria-label="Submissions" className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h3 className="text-base font-semibold">Submissions</h3>
          <label className="flex flex-col gap-1 text-xs">Period
            <select aria-label="Period" className="h-9 rounded-md border border-border bg-background px-2 text-sm" value={period ?? 'current'} onChange={(e) => onPeriod(e.target.value === 'current' ? undefined : e.target.value)}>
              <option value="current">Open and next due</option>
              {d.periods.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </label>
        </div>
        {readOnly && <p className="text-xs text-muted-foreground">You read this standard (administrator or QA office); the people named submit and approve.</p>}
        {!d.submissions.length && <p className="text-sm text-muted-foreground" data-testid="no-submissions">Nothing for this period. A standard asks for submissions once it has a frequency and a scope (Settings, Internal Quality Framework).</p>}
        {d.submissions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Submissions of the standard">
              <thead className="text-xs text-muted-foreground"><tr>
                <th className="px-2 py-1 text-start">For</th><th className="px-2 py-1 text-start">Period</th><th className="px-2 py-1 text-start">Due</th>
                <th className="px-2 py-1 text-start">Status</th><th className="px-2 py-1 text-start">Evidence</th><th className="px-2 py-1" />
              </tr></thead>
              <tbody>
                {d.submissions.map((s) => (
                  <tr key={openKey(s)} className="border-t border-border align-top" data-testid="submission-row">
                    <td className="px-2 py-1"><ContentText>{s.subjectName}</ContentText>{s.submitter && <span className="block text-xs text-muted-foreground">{s.submitter.name}</span>}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{s.periodLabel}{s.code !== code && <span className="block font-mono text-xs text-muted-foreground">{s.code}</span>}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{DATE.format(new Date(s.dueAt))}{s.late && <span className="ms-1 rounded bg-red-100 px-1 text-xs text-red-900">Late</span>}{s.dueSoon && <span className="ms-1 rounded bg-amber-100 px-1 text-xs text-amber-900">Due soon</span>}</td>
                    <td className="px-2 py-1"><StatusChip status={s.status} />{s.waitingOn && <span className="block text-xs text-muted-foreground">With {s.waitingOn}</span>}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{s.evidenceDone} of {s.evidenceTotal}</td>
                    <td className="px-2 py-1 text-end">
                      <Button type="button" variant={s.can.submit || s.can.decide ? 'default' : 'outline'} className="h-8 px-3 py-1"
                        onClick={() => onOpen(open === openKey(s) ? undefined : openKey(s))}>{s.can.decide ? 'Review' : s.can.submit ? (s.status === 'not_started' ? 'Start' : 'Open') : 'View'}</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {opened && d.submissions.some((s) => openKey(s) === open) && (
        <SubmissionPanel key={open} api={api} {...(evidence ? { evidence } : {})} frameworkId={d.submissions[0]!.frameworkId} target={opened} onClose={() => onOpen(undefined)} />
      )}
    </div>
  );
}

function SubmissionPanel({ api, evidence: evOverride, frameworkId, target, onClose }: {
  api: QualityApi; evidence?: EvidenceApi; frameworkId: string; target: NonNullable<ReturnType<typeof parseOpen>>; onClose: () => void;
}) {
  const ev = useEvidenceApi(evOverride);
  const qc = useQueryClient();
  const key = { frameworkId, ...target };
  const q = useQuery({ queryKey: ['quality-submission', key], queryFn: () => api.submission(key) });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const act = useAction(setError);
  const run = useMutation({
    mutationFn: (fn: () => Promise<SubmissionDetail | undefined>) => { setError(null); return act(fn); },
    onSuccess: (r) => { if (r) qc.setQueryData(['quality-submission', key], r); void qc.invalidateQueries({ queryKey: ['quality-tab'] }); void qc.invalidateQueries({ queryKey: ['quality-tabs'] }); },
  });
  const s = q.data;
  if (q.isError) return <p role="alert" className="text-sm text-red-700">Could not load the submission.</p>;
  if (!s) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const ensure = async (): Promise<string> => (s.id ? s.id : (await api.open(key)).id!);
  const upload = (itemId: string, file: File) => run.mutate(async () => { const id = await ensure(); const v = await ev.upload(itemId, file, { notes: `${s.subjectName}, ${s.periodLabel}` }); return api.saveEvidence(id, { itemId, versionId: v.id }); });
  const reuse = (itemId: string, versionId: string | null) => run.mutate(async () => api.saveEvidence(await ensure(), { itemId, versionId }));
  const round = s.steps.filter((x) => x.round === s.round);
  const allAnswered = s.evidence.every((e) => e.versionId);
  return (
    <section aria-label="Submission" className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold"><ContentText>{s.subjectName}</ContentText> · {s.periodLabel}</h3>
          <p className="text-xs text-muted-foreground"><span className="font-mono">{s.code}</span> {s.title} · due {DATE.format(new Date(s.dueAt))}{s.submitter ? ` · submitted by ${s.submitter.name}` : ' · nobody named to submit'}</p>
        </div>
        <div className="flex items-center gap-2"><StatusChip status={s.status} /><Button type="button" variant="ghost" aria-label="Close the submission" onClick={onClose}>✕</Button></div>
      </div>
      {!s.submitter && <p role="note" className="text-xs text-amber-900">Nobody submits for this item yet: name its coordinator (course or program) or its head (unit), or the standard's champion for the institution.</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      <div className="space-y-2" role="list" aria-label="Evidence asked for">
        {!s.evidence.length && <p className="text-sm text-muted-foreground">No evidence is linked to this standard yet (Settings, Internal Quality Framework, Link evidence).</p>}
        {s.evidence.map((e) => (
          <div key={e.itemId} role="listitem" className="space-y-1 rounded-md border border-border p-2" data-testid="submission-evidence">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium"><ContentText>{e.title}</ContentText> <span className="text-xs font-normal text-muted-foreground">{e.type === 'dataset' ? 'KPI / data' : 'Document'} · {e.codes.join(', ')}</span></p>
              <span className={`text-xs ${e.versionId ? 'text-emerald-800' : 'text-muted-foreground'}`}>{e.versionId ? `Provided: version ${e.versionNo}${e.fileName ? ` (${e.fileName})` : ''}` : 'Not provided yet'}</span>
            </div>
            {e.rows && (
              e.rows.length
                ? <div className="overflow-x-auto"><table className="text-xs" aria-label={`Data of ${e.title}`}><thead><tr>{Object.keys(e.rows[0]!).map((k) => <th key={k} className="px-1 text-start text-muted-foreground">{k}</th>)}</tr></thead>
                  <tbody>{e.rows.slice(0, 20).map((r, i) => <tr key={i}>{Object.keys(e.rows![0]!).map((k) => <td key={k} className="px-1">{String(r[k] ?? '')}</td>)}</tr>)}</tbody></table></div>
                : <p className="text-xs text-muted-foreground">The data has no rows for this item and period yet.</p>
            )}
            {e.versionId && <a className="text-xs underline underline-offset-2" href={ev.fileUrl(e.versionId)} target="_blank" rel="noreferrer">Open what was provided</a>}
            {s.can.edit && (
              <div className="flex flex-wrap items-center gap-2">
                {e.type !== 'dataset' && (
                  <label className="inline-flex h-8 cursor-pointer items-center rounded-md border border-border px-3 text-xs hover:bg-muted">Upload a file
                    <input type="file" className="sr-only" aria-label={`Upload ${e.title}`} onChange={(x) => { const f = x.target.files?.[0]; if (f) upload(e.itemId, f); }} />
                  </label>
                )}
                {e.latestVersionId && e.latestVersionId !== e.versionId && <Button type="button" variant="outline" className="h-8 px-3 py-1 text-xs" onClick={() => reuse(e.itemId, e.latestVersionId)}>{e.type === 'dataset' ? `Use the data (version ${e.latestVersionNo})` : `Reuse version ${e.latestVersionNo}`}</Button>}
                {e.versionId && <Button type="button" variant="ghost" className="h-8 px-3 py-1 text-xs" onClick={() => reuse(e.itemId, null)}>Clear</Button>}
              </div>
            )}
          </div>
        ))}
      </div>

      {s.can.submit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={!allAnswered || run.isPending} onClick={() => run.mutate(async () => api.submit(await ensure()))}>Submit for approval</Button>
          {!allAnswered && <span className="text-xs text-muted-foreground">Provide every item to submit.</span>}
        </div>
      )}

      <section aria-label="Approval" className="space-y-1">
        <h4 className="text-sm font-semibold">Approval{s.round > 1 ? ` (round ${s.round})` : ''}</h4>
        <ol className="space-y-1 text-sm">
          {round.map((x) => (
            <li key={`${x.round}-${x.ordinal}`} className="flex flex-wrap items-center gap-2" data-testid="approval-step">
              <span className="w-5 text-xs text-muted-foreground">{x.ordinal + 1}.</span>
              <span className="font-medium">{x.label}</span>
              <span className="text-xs text-muted-foreground">{x.unresolved ? 'nobody named: the QA office can take it' : x.approvers.map((a) => a.name).join(', ')}</span>
              {x.decision !== 'pending' && <span className={`rounded px-1.5 text-xs ${x.decision === 'approved' ? 'bg-emerald-100 text-emerald-900' : x.decision === 'returned' ? 'bg-amber-100 text-amber-950' : 'bg-muted text-muted-foreground'}`}>{x.decision === 'approved' ? 'Internally approved' : x.decision === 'returned' ? 'Returned for changes' : 'Skipped'}{x.decidedBy ? ` by ${x.decidedBy}` : ''}</span>}
              {x.note && <span className="w-full ps-7 text-xs text-muted-foreground" dir="auto">“{x.note}”</span>}
            </li>
          ))}
        </ol>
        {s.steps.some((x) => x.round < s.round && x.decision === 'returned') && <p className="text-xs text-muted-foreground">Returned earlier: {s.steps.filter((x) => x.round < s.round && x.decision === 'returned').map((x) => `${x.label}: “${x.note ?? ''}”`).join('; ')}</p>}
      </section>

      {s.can.decide && (
        <form aria-label="Decision" className="space-y-2 rounded-md border border-border p-2" onSubmit={(x) => x.preventDefault()}>
          <label className="flex flex-col gap-1 text-xs">Note (required to return it)
            <textarea aria-label="Decision note" rows={2} className="rounded-md border border-border bg-background px-2 py-1 text-sm" value={note} onChange={(x) => setNote(x.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={run.isPending} onClick={() => run.mutate(() => api.decide(s.id!, { decision: 'approved', ...(note.trim() ? { note: note.trim() } : {}) }))}>Approve</Button>
            <Button type="button" variant="outline" disabled={run.isPending || !note.trim()} onClick={() => run.mutate(() => api.decide(s.id!, { decision: 'returned', note: note.trim() }))}>Return for changes</Button>
          </div>
        </form>
      )}
    </section>
  );
}
