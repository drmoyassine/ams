import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnalysisStage, AnalysisStats, AnalysisStatus } from '@ams/shared';
import { Button } from '../../components/ui/button';
import type { AnalysisRun, FrameworkApi } from '../../lib/framework-api';
import { useAction } from '../../lib/use-action';

const STAGE_LABEL: Record<AnalysisStage, string> = {
  read: 'Reading the files', survey: 'Looking at each document', structure: 'Finding how the standards are organised',
  extract: 'Taking out requirements and notes', write: 'Checking quotes and writing to the draft', finalise: 'Finishing',
};
const STATUS_LABEL: Record<AnalysisStatus, string> = { queued: 'Queued', running: 'Running', succeeded: 'Finished', failed: 'Stopped', cancelled: 'Cancelled' };
const STATUS_CLS: Record<AnalysisStatus, string> = {
  queued: 'bg-muted text-muted-foreground', running: 'bg-sky-50 text-sky-900', succeeded: 'bg-emerald-50 text-emerald-900',
  failed: 'bg-red-50 text-red-900', cancelled: 'bg-muted text-muted-foreground',
};
const active = (r: AnalysisRun | undefined) => r?.status === 'queued' || r?.status === 'running';
const n = (x: number) => x.toLocaleString('en');

/** Tokens and, when prices are set in Settings -> AI, the cost so far. */
export function spendText(u: AnalysisRun['usage']): string {
  const tokens = `${n(u.inputTokens + u.outputTokens)} tokens`;
  return u.costUsd === null ? tokens : `${tokens}, $${u.costUsd.toFixed(2)}`;
}

/** Where a run stands, in words, for the progress strip. */
export function progressText(r: AnalysisRun): string {
  const p = r.progress;
  const parts: string[] = [];
  if (r.status === 'queued') parts.push('Waiting for the worker');
  else if (r.stage) parts.push(STAGE_LABEL[r.stage]);
  if (r.stage === 'read' || r.stage === 'survey') { if (p.docsTotal) parts.push(`document ${Math.min((p.docsDone ?? 0) + 1, p.docsTotal)} of ${p.docsTotal}`); }
  if (p.windowsTotal) parts.push(`${p.windowsDone ?? 0}/${p.windowsTotal} windows`);
  if (p.items !== undefined) parts.push(`${n(p.items)} item${p.items === 1 ? '' : 's'} so far`);
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
  ].join(' · ');
}

/**
 * "Analyse sources": a background run that reads the draft's sources and writes the accreditor's requirements into it in
 * their exact wording, each marked as AI-made with its page and quote. A strip shows its progress while it runs (the
 * list polls); the last runs follow with their counts. The full report and the review screen come later.
 */
export function AnalysisPanel({ api, versionId, editable, hasSources, onWritten }: {
  api: FrameworkApi; versionId: string; editable: boolean; hasSources: boolean; onWritten: () => void;
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
  const refresh = () => qc.invalidateQueries({ queryKey: ['analysis', versionId] });
  return (
    <section aria-label="Analysis" className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">Analysis</h3>
        <span className="text-xs text-muted-foreground">The AI reads these sources and adds the accreditor's requirements to this draft, word for word, each with its page and quote.</span>
        {editable && !busy && (
          <Button type="button" className="ms-auto" disabled={!hasSources} onClick={() => { setError(''); void run(() => api.startAnalysis(versionId)).then(refresh); }}>Analyse sources</Button>
        )}
        {editable && busy && current && (
          <Button type="button" variant="outline" className="ms-auto" onClick={() => { void run(() => api.cancelAnalysis(current.id)).then(refresh); }}>Stop</Button>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {busy && current && (
        <div role="status" aria-label="Analysis progress" aria-live="polite" className="rounded bg-muted px-2 py-1 text-sm break-words">{progressText(current)}</div>
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
                <span className="text-xs text-muted-foreground">{spendText(r.usage)}</span>
                {r.status === 'failed' && r.error && <span className="min-w-0 text-xs text-red-700">{r.error}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {runs.data && list.length === 0 && <p className="text-xs text-muted-foreground">Not analysed yet.</p>}
    </section>
  );
}
