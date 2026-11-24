// Settings -> Organization -> Outcomes & Syllabus: the achievement scale every rubric is described at (and its target level, whose lowest
// score is the CLO score target), and the rubric templates coordinators start from (one per kind of assessment).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSESSMENT_CATEGORIES, DEFAULT_RUBRIC_TEMPLATES, LABEL, type AchievementScale, type RubricTemplate } from '@ams/shared';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Dialog } from '../../components/dialog';
import { useConfirm } from '../../components/confirm-dialog';
import { RubricGrid } from '../../components/syllabus/rubric-grid';
import { errorText } from '../../components/evidence-item-form';
import { useSyllabusApi, type SyllabusApi } from '../../lib/syllabus-api';

const cell = 'border-b border-border px-2 py-1';

export function AchievementScaleCard({ api: override, canEdit }: { api?: SyllabusApi; canEdit: boolean }) {
  const api = useSyllabusApi(override);
  const q = useQuery({ queryKey: ['achievement-scale'], queryFn: () => api.scale() });
  if (!q.data) return <Card><p className="text-sm text-muted-foreground">Loading…</p></Card>;
  return <ScaleForm key={JSON.stringify(q.data)} api={api} canEdit={canEdit} initial={q.data} />;
}

function ScaleForm({ api, canEdit, initial }: { api: SyllabusApi; canEdit: boolean; initial: AchievementScale }) {
  const qc = useQueryClient();
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api.setScale(v),
    onSuccess: async () => { setError(null); setSaved(true); await qc.invalidateQueries(); },
    onError: (e) => { setSaved(false); setError(errorText(e)); },
  });
  const setLevel = (i: number, p: Partial<AchievementScale['levels'][number]>) => { setSaved(false); setV({ ...v, levels: v.levels.map((l, k) => (k === i ? { ...l, ...p } : l)) }); };
  const num = (s: string) => (s.trim() === '' ? 0 : Number(s));
  return (
    <Card aria-label="Achievement scale">
      <h3 className="mb-1 text-lg font-semibold">Achievement scale</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        The levels every rubric is described at, highest first. Course coordinators write criteria against these levels; they do not set their own.
        The target level's lowest score is the CLO score target of the assessment targets below.
      </p>
      {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-sm" aria-label="Levels of the achievement scale">
          <thead><tr className="text-xs text-muted-foreground"><th className={`${cell} text-start font-medium`}>Level</th><th className={`${cell} text-start font-medium`}>From %</th><th className={`${cell} text-start font-medium`}>To %</th><th className={`${cell} text-start font-medium`}>Target</th><th className={cell} /></tr></thead>
          <tbody>
            {v.levels.map((l, i) => (
              <tr key={i}>
                <td className={cell}><Input aria-label={`Achievement level ${i + 1} name`} value={l.name} disabled={!canEdit} onChange={(e) => setLevel(i, { name: e.target.value })} /></td>
                <td className={`${cell} w-24`}><Input aria-label={`Achievement level ${i + 1} from`} inputMode="decimal" value={String(l.min)} disabled={!canEdit} onChange={(e) => setLevel(i, { min: num(e.target.value) })} /></td>
                <td className={`${cell} w-24`}><Input aria-label={`Achievement level ${i + 1} to`} inputMode="decimal" value={String(l.max)} disabled={!canEdit} onChange={(e) => setLevel(i, { max: num(e.target.value) })} /></td>
                <td className={`${cell} w-20`}><input type="radio" name="scale-target" aria-label={`${l.name || `Level ${i + 1}`} is the target`} checked={v.target === i} disabled={!canEdit} onChange={() => { setSaved(false); setV({ ...v, target: i }); }} /></td>
                <td className={`${cell} w-10 text-center`}>
                  {canEdit && v.levels.length > 2 && <button type="button" aria-label={`Remove achievement level ${i + 1}`} className="rounded px-1.5 text-muted-foreground hover:bg-muted" onClick={() => { setSaved(false); setV({ levels: v.levels.filter((_, k) => k !== i), target: Math.min(v.target > i ? v.target - 1 : v.target, v.levels.length - 2) }); }}>✕</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {v.levels.length < 6 && <Button type="button" variant="outline" onClick={() => { setSaved(false); setV({ ...v, levels: [...v.levels, { name: '', min: 0, max: 0 }] }); }}>+ Level</Button>}
          <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>Save the scale</Button>
          {saved && <span role="status" className="text-sm text-emerald-700">Saved. Every syllabus is checked against it again.</span>}
        </div>
      )}
    </Card>
  );
}

export function RubricTemplatesCard({ api: override, canEdit }: { api?: SyllabusApi; canEdit: boolean }) {
  const api = useSyllabusApi(override);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const scale = useQuery({ queryKey: ['achievement-scale'], queryFn: () => api.scale() });
  const list = useQuery({ queryKey: ['rubric-templates'], queryFn: () => api.rubricTemplates() });
  const [editing, setEditing] = useState<RubricTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (next: RubricTemplate[]) => api.setRubricTemplates(next),
    onSuccess: async () => { setError(null); setEditing(null); await qc.invalidateQueries({ queryKey: ['rubric-templates'] }); await qc.invalidateQueries({ queryKey: ['syllabus'] }); },
    onError: (e) => setError(errorText(e)),
  });
  const templates = list.data ?? [];
  const levels = (scale.data?.levels ?? []).map((l) => l.name);
  const put = (t: RubricTemplate) => save.mutate(templates.some((x) => x.id === t.id) ? templates.map((x) => (x.id === t.id ? t : x)) : [...templates, t]);
  return (
    <Card aria-label="Rubric templates">
      <h3 className="mb-1 text-lg font-semibold">Rubric templates</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        The rubric a course starts from for each type of assessment. A coordinator uses it as it is, adapts a copy for the course, or writes one from scratch.
        Changing a template does not change the copies courses already made.
      </p>
      {error && !editing && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm" aria-label="Rubric templates">
          <thead><tr className="text-xs text-muted-foreground"><th className={`${cell} text-start font-medium`}>Template</th><th className={`${cell} text-start font-medium`}>Used for</th><th className={`${cell} text-start font-medium`}>Criteria</th><th className={cell} /></tr></thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id} data-testid="rubric-template-row">
                <td className={`${cell} font-medium`}>{t.title}</td>
                <td className={cell}>{t.types.length ? t.types.map((x) => LABEL[x] ?? x).join(', ') : <span className="text-muted-foreground">Chosen by hand</span>}</td>
                <td className={cell}>{t.criteria.length}</td>
                <td className={`${cell} whitespace-nowrap text-end`}>
                  <Button type="button" variant="ghost" className="h-8 px-2" onClick={() => setEditing(t)}>{canEdit ? 'Edit' : 'View'}</Button>
                  {canEdit && <Button type="button" variant="ghost" className="h-8 px-2" onClick={() => { void confirm({ title: `Remove ${t.title}?`, message: 'Courses keep the copies they made from it.', confirmLabel: 'Remove', tone: 'danger' }).then((ok) => { if (ok) save.mutate(templates.filter((x) => x.id !== t.id)); }); }}>Remove</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setEditing({ id: `tpl-${crypto.randomUUID()}`, title: '', types: [], criteria: [{ name: '', descriptions: levels.map(() => '') }] })}>+ Template</Button>
          <Button type="button" variant="ghost" onClick={() => { void confirm({ title: 'Restore the starting templates?', message: 'Your templates are replaced by the starting set. Courses keep their copies.', confirmLabel: 'Restore' }).then((ok) => { if (ok) save.mutate(DEFAULT_RUBRIC_TEMPLATES); }); }}>Restore the starting templates</Button>
        </div>
      )}
      {editing && (
        <TemplateDialog template={editing} levels={levels} canEdit={canEdit} error={error} taken={new Map(templates.filter((x) => x.id !== editing.id).flatMap((x) => x.types.map((ty) => [ty, x.title] as const)))}
          onClose={() => { setEditing(null); setError(null); }} onSave={put} busy={save.isPending} />
      )}
    </Card>
  );
}

function TemplateDialog({ template, levels, canEdit, error, taken, onClose, onSave, busy }: {
  template: RubricTemplate; levels: string[]; canEdit: boolean; error: string | null; taken: Map<string, string>;
  onClose: () => void; onSave: (t: RubricTemplate) => void; busy: boolean;
}) {
  const [t, setT] = useState(template);
  return (
    <Dialog labelledBy="tpl-title" onClose={onClose} size="wide">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="tpl-title" className="text-lg font-semibold">{template.title ? `Template: ${template.title}` : 'New rubric template'}</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <div className="space-y-3">
        <label className="flex flex-col gap-1 text-sm">Title<Input aria-label="Template title" value={t.title} disabled={!canEdit} onChange={(e) => setT({ ...t, title: e.target.value })} /></label>
        <fieldset className="space-y-1">
          <legend className="text-sm">The starting rubric for these types of assessment</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {ASSESSMENT_CATEGORIES.map((ty) => (
              <label key={ty} className="flex items-center gap-1.5 text-sm" title={taken.has(ty) ? `Now from ${taken.get(ty)}` : undefined}>
                <input type="checkbox" checked={t.types.includes(ty)} disabled={!canEdit || (taken.has(ty) && !t.types.includes(ty))}
                  onChange={(e) => setT({ ...t, types: e.target.checked ? [...t.types, ty] : t.types.filter((x) => x !== ty) })} />
                {LABEL[ty] ?? ty}{taken.has(ty) && <span className="text-xs text-muted-foreground">({taken.get(ty)})</span>}
              </label>
            ))}
          </div>
        </fieldset>
        <RubricGrid label="Criteria of the template" levels={levels} criteria={t.criteria} readOnly={!canEdit} onChange={(criteria) => setT({ ...t, criteria })} />
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="button" disabled={busy} onClick={() => onSave({ ...t, criteria: t.criteria.map((k) => ({ ...k, descriptions: levels.map((_, j) => k.descriptions[j] ?? '') })) })}>Save template</Button>}
        </div>
      </div>
    </Dialog>
  );
}
