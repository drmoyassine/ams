// Settings -> Organization -> Courses: the syllabus template. An admin reorders and renames the sections, adds free-text sections that then
// appear in every syllabus, and chooses which unlocked fields must be filled before a syllabus can be submitted. The sections the rules
// depend on (CLOs, assessments, rubrics, basic information) stay: only their order and wording can change.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CUSTOM_PREFIX, MAX_CUSTOM_SECTIONS, OPTIONAL_FIELDS, OPTIONAL_FIELD_LABEL, type SyllabusSectionDef, type SyllabusTemplate } from '@ams/shared';
import { errorText } from '../evidence-item-form';
import { useSyllabusApi, type SyllabusApi } from '../../lib/syllabus-api';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

const move = <T,>(xs: T[], i: number, by: number) => { const j = i + by; if (j < 0 || j >= xs.length) return xs; const out = [...xs]; [out[i], out[j]] = [out[j]!, out[i]!]; return out; };
const slug = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'section';

export function SyllabusTemplateEditor({ canWrite, api: override }: { canWrite: boolean; api?: SyllabusApi }) {
  const api = useSyllabusApi(override);
  const q = useQuery({ queryKey: ['syllabus-template'], queryFn: () => api.template() });
  const [saved, setSaved] = useState(false);
  if (!q.data) return <p className="text-sm">Loading…</p>;
  return (
    <>
      <TemplateForm key={JSON.stringify(q.data)} template={q.data} canWrite={canWrite} api={api} onSaved={() => setSaved(true)} onEdit={() => setSaved(false)} />
      {saved && <p role="status" className="text-sm text-emerald-800">Template saved. Every syllabus was checked again.</p>}
    </>
  );
}

function TemplateForm({ template, canWrite, api, onSaved, onEdit }: { template: SyllabusTemplate; canWrite: boolean; api: SyllabusApi; onSaved: () => void; onEdit: () => void }) {
  const qc = useQueryClient();
  const [sections, setSections] = useState<SyllabusSectionDef[]>(template.sections);
  const [optional, setOptional] = useState<string[]>(template.optional);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const edit = <T,>(fn: (v: T) => void) => (v: T) => { onEdit(); fn(v); };
  const customCount = sections.filter((s) => s.key.startsWith(CUSTOM_PREFIX)).length;
  const save = useMutation({
    mutationFn: () => api.setTemplate({ sections, optional }),
    onSuccess: async () => { setError(''); onSaved(); await qc.invalidateQueries({ queryKey: ['syllabus-template'] }); await qc.invalidateQueries({ queryKey: ['syllabus'] }); await qc.invalidateQueries({ queryKey: ['syllabi'] }); },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <section aria-label="Syllabus template" className="space-y-3 rounded-lg border border-border p-4">
      <div><h4 className="font-semibold">Syllabus template</h4><p className="text-xs text-muted-foreground">AIU’s Course Syllabus Template, as configuration. Rename and reorder the sections, add your own, and choose which fields are required before a syllabus is submitted. The sections the rules depend on cannot be removed.</p></div>
      <ol className="space-y-2" aria-label="Sections">
        {sections.map((s, i) => (
          <li key={s.key} className="space-y-1 rounded-md border border-border p-2" data-testid="template-section">
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label={`Section ${i + 1} title`} className="min-w-0 grow" disabled={!canWrite} value={s.title} onChange={(e) => edit(setSections)(sections.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
              {s.key.startsWith(CUSTOM_PREFIX) ? <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-900">Added section</span> : s.locked ? <span className="rounded bg-muted px-1.5 py-0.5 text-xs">Needed by the rules</span> : null}
              {canWrite && (
                <>
                  <Button type="button" variant="ghost" aria-label={`Move ${s.title} up`} disabled={i === 0} onClick={() => edit(setSections)(move(sections, i, -1))}>↑</Button>
                  <Button type="button" variant="ghost" aria-label={`Move ${s.title} down`} disabled={i === sections.length - 1} onClick={() => edit(setSections)(move(sections, i, 1))}>↓</Button>
                  {s.key.startsWith(CUSTOM_PREFIX) && <Button type="button" variant="ghost" aria-label={`Remove ${s.title}`} onClick={() => edit(setSections)(sections.filter((_, j) => j !== i))}>Remove</Button>}
                </>
              )}
            </div>
            <Input aria-label={`Section ${i + 1} help`} placeholder="Guidance shown to the coordinator" disabled={!canWrite} value={s.help} onChange={(e) => edit(setSections)(sections.map((x, j) => (j === i ? { ...x, help: e.target.value } : x)))} />
          </li>
        ))}
      </ol>
      {canWrite && (
        <form className="flex flex-wrap gap-2" aria-label="Add a section" onSubmit={(e) => { e.preventDefault(); const t = name.trim(); if (!t) return; edit(setSections)([...sections, { key: `${CUSTOM_PREFIX}${slug(t)}-${crypto.randomUUID().slice(0, 4)}`, title: t, help: '', locked: false }]); setName(''); }}>
          <Input aria-label="New section title" className="min-w-0 grow sm:max-w-xs" placeholder="Title of a new section" value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" variant="outline" disabled={!name.trim() || customCount >= MAX_CUSTOM_SECTIONS}>+ Section</Button>
        </form>
      )}
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Required before a syllabus can be submitted</legend>
        <p className="text-xs text-muted-foreground">Untick a field to make it optional. The CLOs, their PLO and coverage level, the assessment weights and the rubrics are always required.</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {OPTIONAL_FIELDS.map((f) => (
            <label key={f} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!canWrite} checked={!optional.includes(f)} aria-label={`${OPTIONAL_FIELD_LABEL[f]} is required`}
              onChange={(e) => edit(setOptional)(e.target.checked ? optional.filter((x) => x !== f) : [...optional, f])} />{OPTIONAL_FIELD_LABEL[f]}</label>
          ))}
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {canWrite && <Button type="button" variant="outline" disabled={save.isPending} onClick={() => save.mutate()}>Save template</Button>}
    </section>
  );
}
