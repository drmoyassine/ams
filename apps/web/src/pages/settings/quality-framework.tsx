import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import type { FrameworkApi, Version } from '../../lib/framework-api';
import { can, useApi, useMe } from '../../lib/me';
import type { GlossaryApi } from '../../lib/glossary-api';
import type { SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';
import { GlossaryPage } from './glossary';
import { DATE, STATUS_LABEL } from '../frameworks';
import { CycleTab } from '../version/cycle-tab';
import { PublishTab } from '../version/publish-tab';
import { RequirementsTab } from '../version/requirements-tab';

/** The level names, top first, edited where the terms are: they are the framework's levels and the glossary's level terms. */
function LevelsEditor({ latest, canWrite, onSave }: { latest: Version; canWrite: boolean; onSave: (labels: string[]) => void }) {
  const saved = (latest.levelLabels as string[] | undefined) ?? [];
  const [labels, setLabels] = useState(saved);
  const editable = canWrite && latest.status === 'draft';
  const dirty = JSON.stringify(labels.map((l) => l.trim())) !== JSON.stringify(saved);
  const valid = labels.length > 0 && labels.every((l) => l.trim());
  if (!editable) {
    return canWrite && latest.status !== 'draft'
      ? <p className="mb-2 text-xs text-muted-foreground">The newest version is {latest.status.replace('_', ' ')}. Create a new version to change the level names.</p>
      : null;
  }
  return (
    <form aria-label="Level names" className="mb-3 space-y-2 rounded border border-dashed border-border p-3"
      onSubmit={(e) => { e.preventDefault(); if (valid && dirty) onSave(labels.map((l) => l.trim())); }}>
      <p className="text-xs text-muted-foreground">Name your levels from the top, e.g. Standard then Sub-standard.</p>
      {labels.map((l, i) => (
        <label key={i} className="flex items-center gap-2 text-sm">
          <span className="w-16 text-xs text-muted-foreground">Level {i + 1}</span>
          <Input aria-label={`Level ${i + 1} name`} value={l} dir="auto" onChange={(e) => { const v = e.target.value; setLabels(labels.map((x, j) => (j === i ? v : x))); }} />
        </label>
      ))}
      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={() => setLabels([...labels, ''])}>Add a level</Button>
        {labels.length > 1 && <Button type="button" variant="ghost" onClick={() => setLabels(labels.slice(0, -1))}>Remove the lowest level</Button>}
        <Button type="submit" disabled={!valid || !dirty}>Save level names</Button>
      </div>
    </form>
  );
}

const TABS = [
  { id: 'definitions', label: 'Definitions' },
  { id: 'requirements', label: 'Requirements' },
  { id: 'cycle', label: 'Cycle' },
  { id: 'publish', label: 'Review and publish' },
] as const;

/**
 * The institution's own quality framework (AMS/QMS): its standards, named and levelled as the institution chooses.
 * It is edited, reviewed and published like any standard, and external standards are mapped onto it.
 */
export function QualityFrameworkPage({ api: apiProp, glossary, settings }: { api?: FrameworkApi; glossary?: GlossaryApi; settings?: SettingsApi }) {
  const api = useApi(apiProp);
  const me = useMe(api);
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('definitions');
  const { data, isError } = useQuery({ queryKey: ['quality-framework'], queryFn: () => api.qualityFramework() });
  // Its levels are the glossary's level terms, so the terms below change with it.
  const refresh = () => Promise.all(['quality-framework', 'glossary', 'external-terms', 'version', 'requirements', 'validation'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const run = useAction(setError);
  const act = (fn: () => Promise<unknown>) => { setError(''); void run(fn).then(refresh); };
  const canWrite = can(me.data, 'framework:write');

  const versions = data?.versions ?? [];
  const latest = versions[versions.length - 1];
  const listed = versions.find((v) => v.id === pick) ?? latest;
  // The list carries the same fields as the version page; the query keeps the open version fresh after a save or publish.
  const detail = useQuery({ queryKey: ['version', listed?.id], queryFn: () => api.version(listed!.id), enabled: !!listed });
  const current = detail.data ?? listed;

  if (isError) return <p role="alert">Could not load the internal quality framework.</p>;
  if (!data) return <p>Loading…</p>;

  const setUp = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const levelLabels = String(f.get('levels')).split(',').map((l) => l.trim()).filter(Boolean);
    const name = String(f.get('name')).trim();
    act(() => api.setUpQualityFramework({ ...(name ? { name } : {}), levelLabels }));
  };


  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Internal Quality Framework</h2>
        <p className="text-sm text-muted-foreground">Your institution's own standards and the words you use for them. You choose how many levels it has and what they are called, for example Standard then Sub-standard. External standards are mapped onto it from each standard's own page; evidence attaches to its items.</p>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      {!data.framework && (canWrite ? (
        <Card>
          <form onSubmit={setUp} aria-label="Set up the internal quality framework" className="space-y-3 p-4">
            <label className="flex flex-col text-sm">Name<Input name="name" aria-label="Name" defaultValue="Internal Quality Framework" dir="auto" /></label>
            <label className="flex flex-col text-sm">Level names, from the top, separated by commas
              <Input name="levels" aria-label="Level names" defaultValue="Standard, Sub-standard" dir="auto" required />
            </label>
            <Button type="submit">Set up</Button>
          </form>
        </Card>
      ) : <p className="text-sm text-muted-foreground">The internal quality framework has not been set up yet. An administrator or accreditation lead can set it up.</p>)}

      {data.framework && latest && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-medium">{data.framework.name}</h3>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">Version
              <select aria-label="Version" className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" value={current!.id}
                onChange={(e) => { const id = e.target.value; setPick(id); }}>
                {versions.map((v) => <option key={v.id} value={v.id}>{v.edition} · {STATUS_LABEL[v.status]}</option>)}
              </select>
            </label>
            {current!.publishedAt && <span className="text-sm text-muted-foreground">Published {DATE.format(new Date(current!.publishedAt))}</span>}
          </div>
          <div role="tablist" className="flex flex-wrap gap-1 border-b border-border">
            {TABS.map((t) => (
              <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                className={`px-3 py-2 text-sm ${tab === t.id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`}>{t.label}</button>
            ))}
          </div>
          <div role="tabpanel">
            {tab === 'requirements' && <RequirementsTab key={current!.id} api={api} version={{ ...current!, internal: true }} me={me.data} />}
            {tab === 'definitions' && (
              <GlossaryPage api={glossary} settings={settings} embedded
                levelsEditor={<LevelsEditor key={`${latest.id}|${JSON.stringify(latest.levelLabels)}`} latest={latest} canWrite={canWrite} onSave={(labels) => act(() => api.setQualityLevels(labels))} />} />
            )}
            {tab === 'cycle' && <CycleTab key={current!.id} api={api} version={{ ...current!, internal: true }} me={me.data} />}
            {tab === 'publish' && <PublishTab key={current!.id} api={api} version={current!} me={me.data} onOpenVersion={(id) => { setPick(id); void refresh(); setTab('requirements'); }} />}
          </div>
        </div>
      )}
    </div>
  );
}
