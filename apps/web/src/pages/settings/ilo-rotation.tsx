import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssessmentBenchmarks } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useAssessmentApi, type AssessmentApi } from '../../lib/assessment-api';
import { useAction } from '../../lib/use-action';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';

/** The institution's assessment targets (TASK-114): empty until decided; a program's plan may set its own per PLO. */
export function BenchmarksCard({ api: override, canEdit }: { api?: AssessmentApi; canEdit: boolean }) {
  const api = useAssessmentApi(override);
  const data = useQuery({ queryKey: ['benchmarks'], queryFn: () => api.benchmarks() });
  if (!data.data) return <Card><p className="text-sm text-muted-foreground">Loading…</p></Card>;
  return <BenchmarksForm key={JSON.stringify(data.data)} api={api} canEdit={canEdit} initial={data.data} />;
}
function BenchmarksForm({ api, canEdit, initial }: { api: AssessmentApi; canEdit: boolean; initial: AssessmentBenchmarks }) {
  const qc = useQueryClient();
  const keys = ['cloScore', 'cloShare', 'ploScore', 'ploShare', 'indirectScore', 'indirectScale', 'minResponseRate'] as const;
  const label = { cloScore: 'CLO: score %', cloShare: 'CLO: % of students', ploScore: 'PLO: score %', ploShare: 'PLO: % of students', indirectScore: 'Indirect: mean at least', indirectScale: 'Indirect: on a scale of', minResponseRate: 'Survey: response rate %' } as const;
  const [v, setV] = useState(Object.fromEntries(keys.map((k) => [k, initial[k]?.toString() ?? ''])) as Record<(typeof keys)[number], string>);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const act = useAction(setError);
  const save = useMutation({ mutationFn: async () => {
    setError(null); setSaved(false);
    const b = Object.fromEntries(keys.filter((k) => v[k].trim() !== '').map((k) => [k, Number(v[k])])) as AssessmentBenchmarks;
    if (await act(() => api.setBenchmarks(b))) { setSaved(true); await qc.invalidateQueries(); }
  } });
  return (
    <Card aria-label="Assessment targets">
      <h3 className="mb-1 text-lg font-semibold">Assessment targets</h3>
      <p className="mb-3 text-sm text-muted-foreground">The university's thresholds, e.g. 70% of students at 70% or above. Results are shown at or above, or below, these targets unless a program's plan sets its own. Leave empty until decided.</p>
      <div className="grid gap-2 sm:grid-cols-4">
        {keys.map((k) => <label key={k} className="flex flex-col gap-1 text-xs">{label[k]}<Input aria-label={label[k]} inputMode="decimal" value={v[k]} disabled={!canEdit} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></label>)}
      </div>
      {canEdit && <div className="mt-3 flex items-center gap-2"><Button type="button" onClick={() => save.mutate()}>Save targets</Button>{saved && <span role="status" className="text-sm text-emerald-700">Saved</span>}</div>}
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </Card>
  );
}

/** The five-year ILO rotation and the institutional report (TASK-117): per ILO, its years, the PLOs linked to it and their latest results. */
export function IloRotationCard({ api: override, canEdit }: { api?: AssessmentApi; canEdit: boolean }) {
  const api = useAssessmentApi(override);
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['ilo-report'], queryFn: () => api.iloReport() });
  const [f, setF] = useState({ iloId: '', academicYear: '', mechanism: '' });
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ilo-report'] }); } });
  const v = data.data;
  return (
    <Card aria-label="ILO rotation">
      <h3 className="mb-1 text-lg font-semibold">ILO rotation and report</h3>
      <p className="mb-3 text-sm text-muted-foreground">Each ILO is assessed on a five-year rotation from the PLOs that programs link to it. The latest direct result of each program's linked PLO is shown against its target.</p>
      {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
      {!v ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <div className="space-y-3">
          {v.issues.length > 0 && <ul className="text-sm" aria-label="Rotation gaps">{v.issues.map((i) => <li key={i}><span className="me-2 rounded bg-amber-50 px-1.5 text-xs text-amber-900">Gap</span>{i}</li>)}</ul>}
          <ul className="divide-y divide-border rounded border border-border" aria-label="ILO report">
            {v.ilos.map((i) => (
              <li key={i.iloId} className="px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">{i.code}</span><ContentText className="flex-1">{i.text}</ContentText>
                  <span className="text-xs text-muted-foreground">{i.years.length ? `assessed ${i.years.join(', ')}` : 'not scheduled'}</span>
                </div>
                <p className="text-xs text-muted-foreground">{i.programs} program{i.programs === 1 ? '' : 's'} link to it · {i.atOrAbove} at or above target · {i.below} below · {i.noResult} without a result</p>
                {i.plos.length > 0 && <p className="text-xs">{i.plos.map((p) => `${p.program} ${p.code}${p.latest ? ` (${p.latest.term}: ${p.latest.standing === 'at_or_above' ? 'at or above' : p.latest.standing === 'below' ? 'below' : 'no target'})` : ''}`).join(' · ')}</p>}
                {canEdit && v.schedule.filter((s) => s.iloId === i.iloId).map((s) => (
                  <button key={s.id} type="button" className="me-2 text-xs underline" aria-label={`Remove ${i.code} from ${s.academicYear}`} onClick={() => run.mutate(() => api.deleteIloSchedule(s.id))}>Remove {s.academicYear}</button>
                ))}
              </li>
            ))}
          </ul>
          {canEdit && v.ilos.length > 0 && (
            <form className="flex flex-wrap items-end gap-2" aria-label="Schedule an ILO" onSubmit={(e) => { e.preventDefault(); if (f.iloId && f.academicYear) { run.mutate(() => api.saveIloSchedule({ iloId: f.iloId, academicYear: f.academicYear, mechanism: f.mechanism || null })); setF({ ...f, mechanism: '' }); } }}>
              <select aria-label="ILO to schedule" className={select} value={f.iloId} onChange={(e) => setF({ ...f, iloId: e.target.value })}><option value="">ILO…</option>{v.ilos.map((i) => <option key={i.iloId} value={i.iloId}>{i.code}</option>)}</select>
              <Input aria-label="Rotation year" className="w-24" placeholder="2026-27" value={f.academicYear} onChange={(e) => setF({ ...f, academicYear: e.target.value })} />
              <Input aria-label="Mechanism" className="w-72" placeholder="Embedded assessment in capstone courses" value={f.mechanism} onChange={(e) => setF({ ...f, mechanism: e.target.value })} />
              <Button type="submit" variant="outline" className="px-3 py-1">Schedule</Button>
            </form>
          )}
        </div>
      )}
    </Card>
  );
}
