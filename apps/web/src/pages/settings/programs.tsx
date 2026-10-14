import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEGREE_LEVELS, type Program } from '@ams/shared';
import { DocsTab } from '../../components/docs';
import { ReadOnlyNote } from '../../components/read-only-note';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useDocumentsApi, type DocumentsApi } from '../../lib/documents-api';
import { can, useMe } from '../../lib/me';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
const LEVEL = { associate: 'Associate', bachelor: 'Bachelor', master: 'Master', doctorate: 'Doctorate', diploma: 'Diploma', certificate: 'Certificate' } as const;
const tagsOf = (s: string) => [...new Set(s.split(',').map((t) => t.trim()).filter(Boolean))];

type Unit = { id: string; nameEn: string; active: boolean };

function ProgramForm({ initial, units, submitLabel, onSubmit, onCancel }: {
  initial?: Program; units: Unit[]; submitLabel: string; onSubmit: (v: { orgUnitId: string; nameEn: string; nameAr: string; degreeLevel: Program['degreeLevel']; discipline: string; tags: string[] }) => void; onCancel?: () => void;
}) {
  const [orgUnitId, setOrgUnitId] = useState(initial?.orgUnitId ?? '');
  const [nameEn, setNameEn] = useState(initial?.nameEn ?? '');
  const [nameAr, setNameAr] = useState(initial?.nameAr ?? '');
  const [degreeLevel, setLevel] = useState<Program['degreeLevel']>(initial?.degreeLevel ?? 'bachelor');
  const [discipline, setDiscipline] = useState(initial?.discipline ?? '');
  const [tags, setTags] = useState(initial?.tags.join(', ') ?? '');
  const field = 'flex flex-col gap-1 text-xs';
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (orgUnitId && nameEn.trim()) onSubmit({ orgUnitId, nameEn, nameAr, degreeLevel, discipline, tags: tagsOf(tags) }); }}>
      <label className={field}>Name (English)<Input aria-label="Program name (English)" value={nameEn} onChange={(e) => setNameEn(e.target.value)} required /></label>
      <label className={field}>Name (Arabic)<Input aria-label="Program name (Arabic)" dir="auto" value={nameAr} onChange={(e) => setNameAr(e.target.value)} /></label>
      <label className={field}>Org unit
        <select aria-label="Program org unit" className={select} value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)} required>
          <option value="">Choose a unit</option>
          {units.filter((u) => u.active || u.id === initial?.orgUnitId).map((u) => <option key={u.id} value={u.id}>{u.nameEn}</option>)}
        </select>
      </label>
      <label className={field}>Degree level
        <select aria-label="Degree level" className={select} value={degreeLevel} onChange={(e) => setLevel(e.target.value as Program['degreeLevel'])}>
          {DEGREE_LEVELS.map((d) => <option key={d} value={d}>{LEVEL[d]}</option>)}
        </select>
      </label>
      <label className={field}>Discipline<Input aria-label="Discipline" value={discipline} onChange={(e) => setDiscipline(e.target.value)} /></label>
      <label className={field}>Tags (comma separated; they decide which requirements apply, e.g. mechanical)<Input aria-label="Tags" value={tags} onChange={(e) => setTags(e.target.value)} /></label>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button type="submit" disabled={!orgUnitId || !nameEn.trim()}>{submitLabel}</Button>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

/**
 * The Programs tab of Settings -> Organization: the list, and a Docs section where catalogues and program lists are uploaded and
 * the AI import proposes programs for review (TASK-076). `docs` is for tests; the app's own client is the default.
 */
export function ProgramsSettingsPage({ api: override, docs: docsOverride }: { api?: SettingsApi; docs?: DocumentsApi }) {
  const api = useSettingsApi(override);
  const docs = useDocumentsApi(docsOverride);
  const [section, setSection] = useState<'list' | 'docs'>('list');
  const me0 = useMe(api);
  const writer = can(me0.data, 'program:write');
  const targets = useQuery({ queryKey: ['import-targets', 'programs'], queryFn: () => docs.targets({ kind: 'programs', id: null }), enabled: section === 'docs' });
  const sections = [{ id: 'list', label: 'List' }, { id: 'docs', label: 'Docs' }] as const;
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Programs sections" className="flex flex-wrap gap-1">
        {sections.map((t) => (
          <button key={t.id} id={`programs-section-${t.id}`} role="tab" type="button" aria-selected={section === t.id} aria-controls="programs-section-panel" onClick={() => setSection(t.id)}
            className={`rounded-md px-3 py-1 text-sm ${section === t.id ? 'bg-muted font-medium' : 'text-muted-foreground'}`}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id="programs-section-panel" aria-labelledby={`programs-section-${section}`}>
        {section === 'list'
          ? <ProgramsList api={api} />
          : <DocsTab scopeKind="programs" scopeId={null} targets={targets.data ?? []} canWrite={writer} api={docs} />}
      </div>
    </div>
  );
}

function ProgramsList({ api }: { api: SettingsApi }) {
  const qc = useQueryClient();
  const me = useMe(api);
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.programs() });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.orgUnits() });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const canWrite = can(me.data, 'program:write');
  const unitName = new Map((units.data ?? []).map((u) => [u.id, u.nameEn]));
  const refresh = () => qc.invalidateQueries({ queryKey: ['programs'] });
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onSuccess: () => { void refresh(); } });
  const rows = (programs.data ?? []).filter((p) => showInactive || p.active);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Programs</h3>
          <ReadOnlyNote show={!!me.data && !canWrite} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
          {canWrite && <Button type="button" onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add program'}</Button>}
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {adding && canWrite && (
        <Card aria-label="Add program">
          <ProgramForm units={units.data ?? []} submitLabel="Add program" onCancel={() => setAdding(false)}
            onSubmit={(v) => { run.mutate(() => api.createProgram({ orgUnitId: v.orgUnitId, nameEn: v.nameEn, degreeLevel: v.degreeLevel, ...(v.nameAr ? { nameAr: v.nameAr } : {}), ...(v.discipline ? { discipline: v.discipline } : {}), tags: v.tags })); setAdding(false); }} />
        </Card>
      )}
      {programs.isError && <p role="alert">Could not load programs.</p>}
      {programs.data && rows.length === 0 && <p className="text-muted-foreground">No programs visible to you yet.</p>}
      <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Programs">
        {rows.map((p) => (
          <li key={p.id} className="px-4 py-3" data-testid="program">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <ContentText className="font-medium" data-testid="program-name">{p.nameAr ?? p.nameEn}</ContentText>
                {p.nameAr && <ContentText className="ms-2 text-sm text-muted-foreground">{p.nameEn}</ContentText>}
                <p className="text-xs text-muted-foreground">{LEVEL[p.degreeLevel]} · {unitName.get(p.orgUnitId) ?? 'Unknown unit'}{p.discipline ? ` · ${p.discipline}` : ''}{p.tags.length > 0 && ` · tags: ${p.tags.join(', ')}`}</p>
              </div>
              {!p.active && <span className="rounded border border-border px-2 py-0.5 text-xs">Inactive</span>}
              {canWrite && (
                <>
                  <Button type="button" variant="ghost" className="px-2 py-1" aria-label={`Edit ${p.nameEn}`} onClick={() => setEditing(editing === p.id ? null : p.id)}>Edit</Button>
                  <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => run.mutate(() => api.updateProgram(p.id, { active: !p.active }))}>{p.active ? 'Deactivate' : 'Reactivate'}</Button>
                </>
              )}
            </div>
            {editing === p.id && canWrite && (
              <div className="mt-3">
                <ProgramForm initial={p} units={units.data ?? []} submitLabel="Save" onCancel={() => setEditing(null)}
                  onSubmit={(v) => { run.mutate(() => api.updateProgram(p.id, { orgUnitId: v.orgUnitId, nameEn: v.nameEn, nameAr: v.nameAr || null, degreeLevel: v.degreeLevel, discipline: v.discipline || null, tags: v.tags })); setEditing(null); }} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
