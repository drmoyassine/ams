import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnalysisGap, AnalysisGapKind, AnalysisGapStatus, AnalysisMapping, AnalysisStage, AnalysisStats, AnalysisStatus } from '@ams/shared';
import { Button } from '../../components/ui/button';
import { ContentText } from '../../components/content-text';
import type { AnalysisRun, FrameworkApi } from '../../lib/framework-api';
import { useAction } from '../../lib/use-action';

const STAGE_LABEL: Record<AnalysisStage, string> = {
  read: 'Reading the files', survey: 'Looking at each document', structure: 'Finding how the standards are organised',
  extract: 'Taking out requirements and notes', gaps: 'Checking for gaps', recover: 'Asking about the gaps',
  write: 'Checking quotes and writing to the draft', config_survey: 'Looking for the lifecycle, vocabularies and report templates', config_extract: 'Reading the process and template documents',
  config_write: 'Checking quotes and writing the configuration', wording: 'Proposing better wording for your items', embed: 'Preparing to compare with your quality framework', map: 'Suggesting links to your quality framework',
  propose_new: 'Drafting new quality framework items', finalise: 'Finishing',
};
const STATUS_LABEL: Record<AnalysisStatus, string> = { queued: 'Queued', running: 'Running', succeeded: 'Finished', failed: 'Stopped', cancelled: 'Cancelled' };
const STATUS_CLS: Record<AnalysisStatus, string> = {
  queued: 'bg-muted text-muted-foreground', running: 'bg-sky-50 text-sky-900', succeeded: 'bg-emerald-50 text-emerald-900',
  failed: 'bg-red-50 text-red-900', cancelled: 'bg-muted text-muted-foreground',
};
const GAP_KIND_LABEL: Record<AnalysisGapKind, string> = {
  numbering_gap: 'Possibly missing', missing_parent: 'Parent not found', unverified_quote: 'Quote not found', low_confidence: 'Low confidence',
  uncovered_page: 'Page not covered', conflict: 'Conflicting wording',
};
const GAP_STATUS_LABEL: Record<AnalysisGapStatus, string> = {
  open: 'Unresolved', unresolved: 'Unresolved', conflict: 'Conflict', confirmed_absent: 'Confirmed absent', recovered: 'Recovered',
};
const GAP_STATUS_CLS: Record<AnalysisGapStatus, string> = {
  open: 'bg-amber-50 text-amber-900', unresolved: 'bg-amber-50 text-amber-900', conflict: 'bg-red-50 text-red-900',
  confirmed_absent: 'bg-muted text-muted-foreground', recovered: 'bg-emerald-50 text-emerald-900',
};
/** What a person must look at first: unresolved, then conflicts, then the rest. */
const GAP_ORDER: Record<AnalysisGapStatus, number> = { open: 0, unresolved: 0, conflict: 1, confirmed_absent: 2, recovered: 3 };
const active = (r: AnalysisRun | undefined) => r?.status === 'queued' || r?.status === 'running';
const n = (x: number) => x.toLocaleString('en');
const plural = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;

/** Tokens and, when prices are set in Settings -> AI, the cost so far. */
export function spendText(u: AnalysisRun['usage']): string {
  const tokens = `${n(u.inputTokens + u.outputTokens)} tokens`;
  return u.costUsd === null ? tokens : `${tokens}, $${u.costUsd.toFixed(2)}`;
}

/** Where a run stands, in words, for the progress strip. */
export function progressText(r: AnalysisRun): string {
  const p = r.progress;
  const parts: string[] = [];
  const checking = r.stage === 'gaps' || r.stage === 'recover';
  if (r.status === 'queued') parts.push('Waiting for the worker');
  else if (r.stage) parts.push(STAGE_LABEL[r.stage]);
  if (r.stage === 'read' || r.stage === 'survey') { if (p.docsTotal) parts.push(`document ${Math.min((p.docsDone ?? 0) + 1, p.docsTotal)} of ${p.docsTotal}`); }
  if (checking && p.maxRounds !== undefined) parts.push(`round ${Math.max(1, p.round ?? 1)} of ${p.maxRounds}`);
  if (r.stage === 'recover' && p.tasksTotal) parts.push(`${p.tasksDone ?? 0}/${p.tasksTotal} questions`);
  const config = r.stage === 'config_survey' || r.stage === 'config_extract' || r.stage === 'config_write';
  if (r.stage === 'config_survey' && p.configDocsTotal) parts.push(`document ${Math.min((p.configDocsDone ?? 0) + 1, p.configDocsTotal)} of ${p.configDocsTotal}`);
  if (r.stage === 'config_extract' && p.configWindowsTotal) parts.push(`${p.configWindowsDone ?? 0}/${p.configWindowsTotal} windows`);
  if (config && p.configItems !== undefined && r.stage !== 'config_survey') parts.push(`${n(p.configItems)} configuration item${p.configItems === 1 ? '' : 's'} so far`);
  // The wording stage re-reads the extraction's windows and counts its own thing; the windows/items lines are the extraction's.
  if (p.windowsTotal && !checking && !config && r.stage !== 'wording' && r.stage !== 'map' && r.stage !== 'propose_new' && r.stage !== 'embed') parts.push(`${p.windowsDone ?? 0}/${p.windowsTotal} windows`);
  if (r.stage === 'map' && p.mapTotal) parts.push(`${Math.min(p.mapDone ?? 0, p.mapTotal)}/${p.mapTotal} requirements`);
  if (r.stage === 'propose_new' && p.groupsTotal) parts.push(`${Math.min(p.groupsDone ?? 0, p.groupsTotal)}/${p.groupsTotal} groups`);
  if (r.stage === 'wording') { if (p.wordingProposed) parts.push(`${n(p.wordingProposed)} wording proposal${p.wordingProposed === 1 ? '' : 's'} so far`); }
  else if (p.items !== undefined && !config && r.stage !== 'map' && r.stage !== 'propose_new' && r.stage !== 'embed') parts.push(`${n(p.items)} item${p.items === 1 ? '' : 's'} so far`);
  parts.push(spendText(r.usage));
  return parts.join(' · ');
}

/** What a finished run wrote, in words. Never a score: only counts of what was found and checked. */
export function statsText(s: AnalysisStats | undefined): string {
  if (!s) return '';
  const levels = Object.entries(s.requirementsByLevel).map(([l, c]) => `${c} ${l}`).join(', ');
  return [
    `${s.requirements} requirement${s.requirements === 1 ? '' : 's'}${levels ? ` (${levels})` : ''}`, `${s.notes} note${s.notes === 1 ? '' : 's'}`,
    `quotes found in the source: ${Math.round(s.quoteVerifiedShare * 100)}%`,
    ...(s.orphans ? [`${s.orphans} without a parent`] : []), ...(s.lowConfidence ? [`${s.lowConfidence} low confidence`] : []),
    ...(s.keptHumanEdits ? [`${s.keptHumanEdits} of your edits kept`] : []),
    ...(s.recoveryRounds ? [plural(s.recoveryRounds, 'recovery round')] : []),
    ...(s.gapsRecovered ? [`${plural(s.gapsRecovered, 'gap')} recovered`] : []),
    ...(s.gapsUnresolved ? [`${s.gapsUnresolved} unresolved`] : []),
    ...(s.conflicts ? [plural(s.conflicts, 'conflict')] : []),
    ...(s.uncoveredPages ? [`${plural(s.uncoveredPages, 'page')} not covered`] : []),
    ...(s.dismissedSkipped ? [`${plural(s.dismissedSkipped, 'item')} you deleted ${s.dismissedSkipped === 1 ? 'was' : 'were'} not re-added`] : []),
    ...(s.configWritten ? [`${plural(s.configWritten, 'configuration item')} written`] : []),
    ...(s.configFlagged ? [`${s.configFlagged} kept out as flagged`] : []),
    ...(s.wordingProposed ? [`${plural(s.wordingProposed, 'wording proposal')} made`] : []),
  ].join(' · ');
}

/**
 * What the IQF mapping suggested, in words (step E): counts only, never a score or a share. Says how candidates were found
 * ("words and meaning" or "words only") and why mapping did not run or stopped early.
 */
export function mappingText(m: AnalysisMapping | undefined): string {
  if (!m) return '';
  if (m.skipped) return `No links suggested: ${m.skipped.charAt(0).toLowerCase()}${m.skipped.slice(1)}`;
  const by = [m.links.covers && `${m.links.covers} covers`, m.links.partly_covers && `${m.links.partly_covers} partly covers`, m.links.related && `${m.links.related} related`].filter(Boolean).join(', ');
  return [
    `Suggested links: ${plural(m.mapped, 'requirement')}${by ? ` (${by})` : ''}`,
    ...(m.noSuggestion ? [`${m.noSuggestion} without a suggestion`] : []),
    ...(m.newItems ? [`${plural(m.newItems, 'suggested new IQF item')}`] : []),
    ...(m.skippedDecided ? [`${m.skippedDecided} already decided, left alone`] : []),
    m.retrieval === 'hybrid' ? 'candidates found by words and meaning' : 'candidates found by words only',
    ...(m.stopped === 'budget' ? ['stopped at the spend limit'] : []),
  ].join(' · ');
}

const STOP_TEXT: Record<string, string> = {
  budget: 'Recovery stopped at the spend limit.', max_rounds: 'Recovery used all its rounds.', nothing_new: 'Recovery stopped: the last round found nothing new.',
};

/**
 * The gaps of a finished run, compact: what a person must look at (unresolved, conflicts) first, each with a link to the
 * requirement card or the source page; the rest behind "Show all". The full report is a later step.
 */
function GapList({ gaps, stopped, documentTitle, onShowRequirement, onShowPage }: {
  gaps: AnalysisGap[]; stopped: string | null; documentTitle: (id: string) => string;
  onShowRequirement?: (id: string) => void; onShowPage?: (documentId: string, page: number) => void;
}) {
  const [all, setAll] = useState(false);
  const sorted = [...gaps].sort((a, b) => GAP_ORDER[a.status] - GAP_ORDER[b.status]);
  const urgent = sorted.filter((g) => GAP_ORDER[g.status] <= 1);
  const shown = all ? sorted : urgent.slice(0, 10);
  const rest = sorted.length - shown.length;
  return (
    <section aria-label="Gaps" className="space-y-1 rounded bg-muted/40 px-2 py-1.5 text-xs">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">Gaps</span>
        <span className="text-muted-foreground">
          {urgent.length ? `${urgent.length} to look at` : 'Nothing left to look at'}{stopped && STOP_TEXT[stopped] ? ` · ${STOP_TEXT[stopped]}` : ''}
        </span>
      </p>
      {shown.length > 0 && (
        <ul className="space-y-1">
          {shown.map((g) => (
            <li key={g.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 break-words" data-testid="gap">
              <span className={`rounded px-1.5 ${GAP_STATUS_CLS[g.status]}`}>{GAP_STATUS_LABEL[g.status]}</span>
              <span>{GAP_KIND_LABEL[g.kind]}</span>
              {g.requirementId && onShowRequirement
                ? <a href={`#requirement-${g.requirementId}`} className="underline" onClick={(e) => { e.preventDefault(); onShowRequirement(g.requirementId!); }}><ContentText>{g.code ?? ''}</ContentText></a>
                : g.code && <span className="font-medium"><ContentText>{g.code}</ContentText></span>}
              {g.documentId && g.page !== null && (onShowPage
                ? <a href={`#source-${g.documentId}`} className="underline" onClick={(e) => { e.preventDefault(); onShowPage(g.documentId!, g.page!); }}><ContentText>{documentTitle(g.documentId)}</ContentText>, page {g.page}</a>
                : <span><ContentText>{documentTitle(g.documentId)}</ContentText>, page {g.page}</span>)}
              <span className="min-w-0 text-muted-foreground"><ContentText>{g.reason ?? g.detail ?? ''}</ContentText></span>
            </li>
          ))}
        </ul>
      )}
      {(rest > 0 || all) && sorted.length > 0 && (
        <button type="button" className="underline" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${sorted.length} gaps`}</button>
      )}
    </section>
  );
}

/**
 * "Analyse sources": a background run that reads the draft's sources and writes the accreditor's requirements into it in
 * their exact wording, each marked as AI-made with its page and quote. A strip shows its progress while it runs (the
 * list polls), including the check-and-recover rounds; the last runs follow with their counts, and the latest finished
 * run its gaps. The full report and the review screen come later.
 */
export function AnalysisPanel({ api, versionId, editable, hasSources, onWritten, documentTitle = () => 'a source', onShowRequirement, onShowPage, onShowReport }: {
  api: FrameworkApi; versionId: string; editable: boolean; hasSources: boolean; onWritten: () => void;
  documentTitle?: (id: string) => string; onShowRequirement?: (id: string) => void; onShowPage?: (documentId: string, page: number) => void;
  /** Opens the run's report on the Report tab. */ onShowReport?: (runId: string) => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const run = useAction(setError);
  const runs = useQuery({
    queryKey: ['analysis', versionId], queryFn: () => api.analysisRuns(versionId),
    refetchInterval: (q) => (active(q.state.data?.[0]) ? 2000 : false),
  });
  const list = runs.data ?? [];
  const current = list[0];
  const busy = active(current);
  const wasBusy = useRef(false);
  useEffect(() => {
    // A run just ended: what it wrote shows in the requirements and sources.
    if (wasBusy.current && !busy) onWritten();
    wasBusy.current = busy;
  }, [busy, onWritten]);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['analysis', versionId] }), qc.invalidateQueries({ queryKey: ['analysis-preflight', versionId] })]);
  // Can a run start now? Checked before the click, so the button says why not instead of failing after it.
  const preflight = useQuery({ queryKey: ['analysis-preflight', versionId], queryFn: () => api.analysisPreflight(versionId), enabled: editable && !busy });
  const blocked = preflight.data && !preflight.data.canStart ? preflight.data.firstProblem : null;
  const report = (current?.report ?? {}) as { gaps?: AnalysisGap[]; recovery?: { stopped?: string | null } };
  return (
    <section aria-label="Analysis" className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">Analysis</h3>
        <span className="text-xs text-muted-foreground">The AI reads these sources and adds the accreditor's requirements to this draft, word for word, each with its page and quote.</span>
        {editable && !busy && (
          <Button type="button" className="ms-auto" disabled={!hasSources || !!blocked} title={blocked ?? undefined} aria-describedby={blocked ? 'analysis-blocked' : undefined}
            onClick={() => { setError(''); void run(() => api.startAnalysis(versionId)).then(refresh); }}>Analyse sources</Button>
        )}
        {editable && busy && current && (
          <Button type="button" variant="outline" className="ms-auto" onClick={() => { void run(() => api.cancelAnalysis(current.id)).then(refresh); }}>Stop</Button>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {editable && !busy && blocked && <p id="analysis-blocked" className="text-sm text-amber-900">{blocked}</p>}
      {editable && !busy && preflight.data && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Before you start: {preflight.data.checks.filter((c) => c.status === 'ok').length} of {preflight.data.checks.length} checks fine</summary>
          <ul aria-label="Before you start" className="mt-1 space-y-1">
            {preflight.data.checks.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-x-2" data-testid="preflight-check">
                <span className={`rounded px-1.5 ${c.status === 'ok' ? 'bg-emerald-50 text-emerald-900' : c.status === 'problem' ? 'bg-red-50 text-red-900' : 'bg-muted text-muted-foreground'}`}>{c.status === 'ok' ? 'OK' : c.status === 'problem' ? 'Fix' : 'Note'}</span>
                <span className="min-w-0 break-words">{c.message}</span>
                {c.fix?.where === 'ai' && <Link to="/settings/ai" className="underline">{c.fix.label}</Link>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {busy && current && (
        <div role="status" aria-label="Analysis progress" aria-live="polite" className="rounded bg-muted px-2 py-1 text-sm break-words">{progressText(current)}</div>
      )}
      {!busy && current && report.gaps && report.gaps.length > 0 && (
        <GapList gaps={report.gaps} stopped={report.recovery?.stopped ?? null} documentTitle={documentTitle}
          {...(onShowRequirement ? { onShowRequirement } : {})} {...(onShowPage ? { onShowPage } : {})} />
      )}
      {list.length > 0 && (
        <ul aria-label="Recent analyses" className="space-y-1 text-sm">
          {list.slice(0, 5).map((r) => {
            const stats = (r.report as { stats?: AnalysisStats }).stats;
            return (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 break-words">
                <span className={`rounded px-1.5 text-xs ${STATUS_CLS[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                <span className="text-xs text-muted-foreground">{new Date(r.startedAt ?? r.createdAt).toLocaleString('en')}</span>
                {stats && <span className="min-w-0 text-xs">{statsText(stats)}</span>}
                {(r.report as { mapping?: AnalysisMapping }).mapping && <span data-testid="mapping-summary" className="min-w-0 text-xs">{mappingText((r.report as { mapping?: AnalysisMapping }).mapping)}</span>}
                <span className="text-xs text-muted-foreground">{spendText(r.usage)}</span>
                {r.status === 'failed' && r.error && <span className="min-w-0 text-xs text-red-700">{r.error}</span>}
                {onShowReport && r.status !== 'queued' && r.status !== 'running' && (
                  <a href={`?tab=report&run=${r.id}`} className="text-xs underline" onClick={(e) => { e.preventDefault(); onShowReport(r.id); }}>View report</a>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {runs.data && list.length === 0 && <p className="text-xs text-muted-foreground">Not analysed yet.</p>}
    </section>
  );
}
