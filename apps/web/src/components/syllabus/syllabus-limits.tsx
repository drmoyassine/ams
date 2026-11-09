// Settings -> Organization -> Courses: the syllabus limits (minimum and maximum CLOs and PLOs per course) and how fast a flagged
// syllabus goes up the line. Saving checks every syllabus again; the ones that now break a limit are flagged, never refused.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SyllabusSettings } from '@ams/shared';
import { errorText } from '../evidence-item-form';
import { useSyllabusApi, type SyllabusApi } from '../../lib/syllabus-api';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

const field = 'flex flex-col gap-1 text-xs text-muted-foreground';
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
      {saved && <p role="status" className="text-sm text-emerald-800">Saved. Every syllabus was checked again.</p>}
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
  const num = (k: string, text: string) => (
    <label className={field}>{text}<Input aria-label={text} inputMode="numeric" disabled={!canWrite} value={v[k] ?? ''} onChange={(e) => { onEdit(); setV({ ...v, [k]: e.target.value }); }} /></label>
  );
  return (
    <section aria-label="Syllabus limits" className="space-y-3 rounded-lg border border-border p-4">
      <div><h4 className="font-semibold">Syllabus limits</h4><p className="text-xs text-muted-foreground">A syllabus that breaks a limit still loads (an import, an upsert): it is flagged to the coordinator, then up the line, until fixed.</p></div>
      <div className="grid gap-3 sm:grid-cols-5">
        {num('minClos', 'Minimum CLOs per course')}{num('maxClos', 'Maximum CLOs per course')}{num('minPlos', 'Minimum PLOs per course')}{num('maxPlos', 'Maximum PLOs per course')}{num('minCloWeightPct', 'Warn below this % of the grade for a CLO')}
      </div>
      <div className="grid gap-3 sm:grid-cols-5">
        <p className="self-end text-xs text-muted-foreground sm:col-span-2">An error goes to the coordinator at once, then, if unfixed after this many days, to the</p>
        {num('chair', 'Program chair after (days)')}{num('dean', 'Dean after (days)')}{num('vpaa', 'VPAA after (days)')}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {canWrite && <Button type="button" variant="outline" disabled={save.isPending} onClick={() => save.mutate()}>Save limits</Button>}
    </section>
  );
}
