// Settings -> Organization -> Courses: the syllabus limits (minimum and maximum CLOs and PLOs per course) and how fast a flagged
// syllabus goes up the line. Saving checks every syllabus again; the ones that now break a limit are flagged, never refused.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SyllabusSettings } from '@ams/shared';
import { errorText } from '../evidence-item-form';
import { useSyllabusApi, type SyllabusApi } from '../../lib/syllabus-api';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

const n = (s: string) => (s.trim() === '' ? NaN : Number(s));

const toText = (s: SyllabusSettings): Record<string, string> => ({
  minClos: String(s.minClos), maxClos: String(s.maxClos), minPlos: String(s.minPlos), maxPlos: String(s.maxPlos), minCloWeightPct: String(s.minCloWeightPct),
  chair: String(s.escalateDays.chair), dean: String(s.escalateDays.dean), vpaa: String(s.escalateDays.vpaa),
});

export function SyllabusLimits({ canWrite, api: override }: { canWrite: boolean; api?: SyllabusApi }) {
  const api = useSyllabusApi(override);
  const q = useQuery({ queryKey: ['syllabus-settings'], queryFn: () => api.settings() });
  const [saved, setSaved] = useState(false);
  if (!q.data) return <p className="text-sm">Loading…</p>;
  // The form starts from the saved settings and is made again only when they change, so what is being typed is never overwritten.
  return (
    <>
      <LimitsForm key={JSON.stringify(q.data)} settings={q.data} canWrite={canWrite} api={api} onSaved={() => setSaved(true)} onEdit={() => setSaved(false)} />
      {saved && <p role="status" className="text-sm text-emerald-800">Saved.</p>}
    </>
  );
}

function LimitsForm({ settings, canWrite, api, onSaved, onEdit }: { settings: SyllabusSettings; canWrite: boolean; api: SyllabusApi; onSaved: () => void; onEdit: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState(() => toText(settings));
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const body: SyllabusSettings = { minClos: n(v.minClos!), maxClos: n(v.maxClos!), minPlos: n(v.minPlos!), maxPlos: n(v.maxPlos!), minCloWeightPct: n(v.minCloWeightPct!), escalateDays: { chair: n(v.chair!), dean: n(v.dean!), vpaa: n(v.vpaa!) } };
      return api.setSettings(body);
    },
    onSuccess: async () => { setError(''); onSaved(); await qc.invalidateQueries({ queryKey: ['syllabus-settings'] }); await qc.invalidateQueries({ queryKey: ['syllabi'] }); },
    onError: (e) => { onEdit(); setError(errorText(e)); },
  });
  // A number in a sentence: the sentence says what it is, the box holds it.
  const num = (k: string, text: string) => (
    <Input aria-label={text} inputMode="numeric" className="w-16 text-center" disabled={!canWrite} value={v[k] ?? ''} onChange={(e) => { onEdit(); setV({ ...v, [k]: e.target.value }); }} />
  );
  const line = 'flex flex-wrap items-center gap-2 text-sm';
  return (
    <section aria-label="Syllabus limits" className="space-y-6 rounded-lg border border-border p-5">
      <div className="space-y-3">
        <h4 className="font-semibold">How big a syllabus may be</h4>
        <p className={line}>Course learning outcomes (CLOs) in a course: at least {num('minClos', 'Minimum CLOs per course')} and at most {num('maxClos', 'Maximum CLOs per course')}</p>
        <p className={line}>Program learning outcomes (PLOs) a course serves: at least {num('minPlos', 'Minimum PLOs per course')} and at most {num('maxPlos', 'Maximum PLOs per course')}</p>
        <p className={line}>Warn when a CLO is worth less than {num('minCloWeightPct', 'Warn below this % of the grade for a CLO')} % of the course grade</p>
      </div>
      <div className="space-y-3">
        <h4 className="font-semibold">When a syllabus has errors</h4>
        <p className="text-sm">The course coordinator is told at once, and a red bar stays at the top of their screen until it is fixed. If it is still not fixed:</p>
        <ul className="space-y-2">
          <li className={line}>after {num('chair', 'Program chair after (days)')} days the program chair is told too</li>
          <li className={line}>after {num('dean', 'Dean after (days)')} days the Dean is told</li>
          <li className={line}>after {num('vpaa', 'VPAA after (days)')} days the VPAA is told</li>
        </ul>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {canWrite && <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>}
      {!canWrite && <p className="text-xs text-muted-foreground">Only an administrator changes these.</p>}
    </section>
  );
}
