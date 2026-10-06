import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import type { FrameworkApi } from '../../lib/framework-api';
import { can, useApi, useMe } from '../../lib/me';
import type { EvidenceApi } from '../../lib/evidence-api';
import type { GlossaryApi } from '../../lib/glossary-api';
import type { SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';
import { GlossaryPage } from './glossary';
import { DATE, STATUS_LABEL } from '../frameworks';
import { PublishTab } from '../version/publish-tab';
import { RequirementsTab } from '../version/requirements-tab';

const TABS = [
  { id: 'framework', label: 'Framework' },
  { id: 'terms', label: 'Terms' },
  { id: 'publish', label: 'Review and publish' },
] as const;

/**
 * The level names on one line above the tree: an item's level is its depth, and these name the depths. Changed on the
 * newest version while it is a draft; renaming a level renames every item at that depth.
 */
function LevelsLine({ labels: saved, editable, onSave }: { labels: string[]; editable: boolean; onSave: (labels: string[]) => void }) {
  const [labels, setLabels] = useState(saved);
  const dirty = JSON.stringify(labels.map((l) => l.trim())) !== JSON.stringify(saved);
  const valid = labels.length > 0 && labels.every((l) => l.trim());
  if (!editable) return <p className="text-sm"><span className="text-muted-foreground">Levels:</span> {saved.join(' › ')}</p>;
  return (
    <form aria-label="Levels" className="flex flex-wrap items-center gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); if (valid && dirty) onSave(labels.map((l) => l.trim())); }}>
      <span className="text-muted-foreground">Levels:</span>
      {labels.map((l, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden="true" className="text-muted-foreground">›</span>}
          <Input aria-label={`Level ${i + 1} name`} value={l} dir="auto" className="w-36" onChange={(e) => { const v = e.target.value; setLabels(labels.map((x, j) => (j === i ? v : x))); }} />
        </span>
      ))}
      <Button type="button" variant="ghost" className="px-2 py-1" aria-label="Add a level" title="Add a level" onClick={() => setLabels([...labels, ''])}>+</Button>
      {labels.length > 1 && <Button type="button" variant="ghost" className="px-2 py-1" aria-label="Remove the lowest level" title="Remove the lowest level" onClick={() => setLabels(labels.slice(0, -1))}>−</Button>}
      {dirty && <Button type="submit" disabled={!valid}>Save levels</Button>}
    </form>
  );
}

/**
 * The institution's own quality framework (AMS/QMS): its standards, named and levelled as the institution chooses.
 * It is edited, reviewed and published like any standard, and external standards are mapped onto it.
 */
export function QualityFrameworkPage({ api: apiProp, glossary, settings, evidence }: { api?: FrameworkApi; glossary?: GlossaryApi; settings?: SettingsApi; evidence?: EvidenceApi }) {
  const api = useApi(apiProp);
  const me = useMe(api);
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('framework');
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
  const reqs = useQuery({ queryKey: ['requirements', current?.id], queryFn: () => api.requirements(current!.id), enabled: !!current });
  const reqCount = { data: reqs.data?.length };

  if (isError) return <p role="alert">Could not load the internal quality framework.</p>;
  if (!data) return <p>Loading…</p>;

  const setUp = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const levelLabels = String(f.get('levels')).split(',').map((l) => l.trim()).filter(Boolean);
    const name = String(f.get('name')).trim();
    act(() => api.setUpQualityFramework({ ...(name ? { name } : {}), levelLabels, template: f.get('template') === 'on' }));
  };


  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Internal Quality Framework</h2>
        <p className="text-sm text-muted-foreground">Your institution's own standards, in a few levels you name. Each external standard maps onto it from its own page, so evidence and data are collected once, against your framework, and reported to every accreditor.</p>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      {!data.framework && (canWrite ? (
        <Card>
          <form onSubmit={setUp} aria-label="Set up the internal quality framework" className="space-y-3 p-4">
            <label className="flex flex-col text-sm">Name<Input name="name" aria-label="Name" defaultValue="Internal Quality Framework" dir="auto" /></label>
            <label className="flex flex-col text-sm">Level names, from the top, separated by commas
              <Input name="levels" aria-label="Level names" defaultValue="Standard, Sub-standard" dir="auto" required />
            </label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="template" defaultChecked /> Start from the generic template (eight areas you can rename and change)</label>
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
            {tab === 'framework' && (
              <div className="space-y-4">
                <LevelsLine key={`${latest.id}|${JSON.stringify(latest.levelLabels)}`} labels={(latest.levelLabels as string[] | undefined) ?? []}
                  editable={canWrite && latest.status === 'draft' && current!.id === latest.id} onSave={(labels) => act(() => api.setQualityLevels(labels))} />
                {canWrite && current!.status === 'draft' && reqCount.data === 0 && (
                  <div className="rounded-md border border-dashed border-border p-3 text-sm">
                    <p className="mb-2">Start from a generic framework of eight areas (mission and governance, programs, teaching and learning, students, faculty and staff, research and community, resources, quality assurance), each with a few items. Rename, remove and add as you like.</p>
                    <Button type="button" onClick={() => act(() => api.applyQualityTemplate(current!.id))}>Start from the generic template</Button>
                  </div>
                )}
                <RequirementsTab key={current!.id} api={api} version={{ ...current!, internal: true }} me={me.data} {...(evidence ? { evidence } : {})} />
              </div>
            )}
            {tab === 'terms' && <GlossaryPage api={glossary} settings={settings} embedded />}
            {tab === 'publish' && <PublishTab key={current!.id} api={api} version={current!} me={me.data} onOpenVersion={(id) => { setPick(id); void refresh(); setTab('framework'); }} />}
          </div>
        </div>
      )}
    </div>
  );
}
