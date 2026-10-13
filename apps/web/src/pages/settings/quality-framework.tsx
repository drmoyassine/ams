import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ActionsMenu } from '../../components/accordion';
import { useConfirm } from '../../components/confirm-dialog';
import { confirmAndDeleteAll } from '../../lib/delete-requirements';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { ReadOnlyNote } from '../../components/read-only-note';
import type { FrameworkApi } from '../../lib/framework-api';
import { can, useApi, useMe } from '../../lib/me';
import type { EvidenceApi } from '../../lib/evidence-api';
import type { GlossaryApi } from '../../lib/glossary-api';
import type { SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';
import { GlossaryPage } from './glossary';
import { DATE, STATUS_LABEL } from '../frameworks';
import { IqfRequirements } from './iqf-requirements';

const TABS = [
  { id: 'requirements', label: 'Requirements' },
  { id: 'terms', label: 'Terms' },
] as const;

/**
 * The institution's own quality framework (AMS/QMS): its standards, named and levelled as the institution chooses.
 * It is edited, reviewed and published like any standard, and external standards are mapped onto it.
 */
export function QualityFrameworkPage({ api: apiProp, glossary, settings, evidence }: { api?: FrameworkApi; glossary?: GlossaryApi; settings?: SettingsApi; evidence?: EvidenceApi }) {
  const api = useApi(apiProp);
  const me = useMe(api);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [error, setError] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('requirements');
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
  // The status shown in the picker and the one that decides whether editing is allowed come from the same place.
  const current = detail.data && listed ? { ...detail.data, status: listed.status } : listed;
  const reqs = useQuery({ queryKey: ['requirements', current?.id], queryFn: () => api.requirements(current!.id), enabled: !!current });
  const reqCount = { data: reqs.data?.length };

  if (isError) return <p role="alert">Could not load the internal quality framework.</p>;
  if (!data) return <p>Loading…</p>;

  const setUp = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name')).trim();
    act(() => api.setUpQualityFramework({ ...(name ? { name } : {}), levelLabels: ['Standard', 'Sub-standard'], template: f.get('template') === 'on' }));
  };


  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Internal Quality Framework</h2>
        <p className="text-sm text-muted-foreground">Your institution's own standards and sub-standards, each with the evidence that supports it. Each accreditor's standard maps onto it from its own page, so evidence is collected once and reported to every accreditor.</p>
      </div>
      <ReadOnlyNote show={!!me.data && !canWrite} />
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      {!data.framework && (canWrite ? (
        <Card>
          <form onSubmit={setUp} aria-label="Set up the internal quality framework" className="space-y-3 p-4">
            <label className="flex flex-col text-sm">Name<Input name="name" aria-label="Name" defaultValue="Internal Quality Framework" dir="auto" /></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="template" defaultChecked /> Start from the generic template (eight areas you can rename and change)</label>
            <Button type="submit">Set up</Button>
          </form>
        </Card>
      ) : <p className="text-sm text-muted-foreground">The internal quality framework has not been set up yet. An administrator or accreditation lead can set it up.</p>)}

      {data.framework && latest && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="min-w-0 font-medium break-words" dir="auto">{data.framework.name}</h3>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">Version
              <select aria-label="Version" className="max-w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" value={current!.id}
                onChange={(e) => { const id = e.target.value; setPick(id); }}>
                {versions.map((v) => <option key={v.id} value={v.id}>{v.edition} · {STATUS_LABEL[v.status]}</option>)}
              </select>
            </label>
            {current!.publishedAt && <span className="text-sm text-muted-foreground">Published {DATE.format(new Date(current!.publishedAt))}</span>}
            <span className="ms-auto flex flex-wrap justify-end gap-2">
              {current!.status !== 'published' && current!.status !== 'retired' && can(me.data, 'framework:publish') && (
                <Button type="button" onClick={() => act(() => api.publishQuality(current!.id))}>Publish this version</Button>
              )}
              {canWrite && current!.id === latest.id && latest.status === 'published' && (
                <Button type="button" variant="ghost" onClick={() => act(async () => { const v = await api.newQualityVersion(); setPick(v.id); })}>Start a new version</Button>
              )}
              {canWrite && current!.status === 'draft' && (reqs.data?.length ?? 0) > 0 && (
                <ActionsMenu label="More actions" items={[{
                  label: 'Delete all standards in this version',
                  onSelect: () => act(async () => {
                    const done = await confirmAndDeleteAll(api, confirm, current!.id, `version ${current!.edition}`);
                    if (done === 'empty') setError('There is nothing to delete in this version.');
                  }),
                }]} />
              )}
            </span>
          </div>
          {current!.status === 'published' && <p className="text-xs text-muted-foreground">This version is published and fixed. Start a new version to change it; mappings and evidence carry over.</p>}
          <div role="tablist" className="flex flex-wrap gap-1 border-b border-border">
            {TABS.map((t) => (
              <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                className={`px-3 py-2 text-sm ${tab === t.id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`}>{t.label}</button>
            ))}
          </div>
          <div role="tabpanel">
            {tab === 'requirements' && (
              <div className="space-y-4">
                {canWrite && current!.status === 'draft' && reqCount.data === 0 && (
                  <div className="rounded-md border border-dashed border-border p-3 text-sm">
                    <p className="mb-2">Start from a generic framework of eight standards (mission and governance, programs, teaching and learning, students, faculty and staff, research and community, resources, quality assurance), each with a few sub-standards. Rename, remove and add as you like.</p>
                    <Button type="button" onClick={() => act(() => api.applyQualityTemplate(current!.id))}>Start from the generic template</Button>
                  </div>
                )}
                <IqfRequirements key={current!.id} api={api} version={{ ...current!, internal: true }} me={me.data} {...(evidence ? { evidence } : {})} />
              </div>
            )}
            {tab === 'terms' && <GlossaryPage api={glossary} settings={settings} embedded />}
          </div>
        </div>
      )}
    </div>
  );
}
