import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import type { FrameworkApi } from '../../lib/framework-api';
import { can, useApi, useMe } from '../../lib/me';
import { useAction } from '../../lib/use-action';
import { DATE, EyeIcon, PencilIcon, STATUS_LABEL } from '../frameworks';

/**
 * The institution's own quality framework (AMS/QMS): its standards, named and levelled as the institution chooses.
 * It is edited, reviewed and published like any standard, and external standards are mapped onto it.
 */
export function QualityFrameworkPage({ api: apiProp }: { api?: FrameworkApi }) {
  const api = useApi(apiProp);
  const me = useMe(api);
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [edition, setEdition] = useState('');
  const { data, isError } = useQuery({ queryKey: ['quality-framework'], queryFn: () => api.qualityFramework() });
  const refresh = () => qc.invalidateQueries({ queryKey: ['quality-framework'] });
  const run = useAction(setError);
  const act = (fn: () => Promise<unknown>) => { setError(''); void run(fn).then(refresh); };
  const canWrite = can(me.data, 'framework:write');

  if (isError) return <p role="alert">Could not load the quality framework.</p>;
  if (!data) return <p>Loading…</p>;

  const setUp = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const levelLabels = String(f.get('levels')).split(',').map((l) => l.trim()).filter(Boolean);
    const name = String(f.get('name')).trim();
    act(() => api.setUpQualityFramework({ ...(name ? { name } : {}), levelLabels }));
  };

  const versions = data.versions;
  const latest = versions[versions.length - 1];
  const draftOpen = versions.some((v) => v.status === 'draft' || v.status === 'in_review');

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Quality framework</h2>
        <p className="text-sm text-muted-foreground">Your institution's own standards. You choose how many levels it has and what they are called, for example Standard then Sub-standard. External standards are mapped onto it from each standard's own page; evidence attaches to its items.</p>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      {!data.framework && (canWrite ? (
        <Card>
          <form onSubmit={setUp} aria-label="Set up the quality framework" className="space-y-3 p-4">
            <label className="flex flex-col text-sm">Name<Input name="name" aria-label="Name" defaultValue="Quality framework" dir="auto" /></label>
            <label className="flex flex-col text-sm">Level names, from the top, separated by commas
              <Input name="levels" aria-label="Level names" defaultValue="Standard, Sub-standard" dir="auto" required />
            </label>
            <Button type="submit">Set up</Button>
          </form>
        </Card>
      ) : <p className="text-sm text-muted-foreground">The quality framework has not been set up yet. An administrator or accreditation lead can set it up.</p>)}

      {data.framework && (
        <Card>
          <div className="space-y-3 p-4">
            <h3 className="font-medium">{data.framework.name}</h3>
            <ul aria-label="Versions of the quality framework" className="divide-y divide-border rounded-md border border-border">
              {versions.map((v) => {
                const editable = v.status === 'draft' || v.status === 'in_review';
                const labels = (v.levelLabels as string[] | undefined) ?? [];
                return (
                  <li key={v.id} className="flex items-center justify-between gap-3 px-3 py-2" data-testid="version-row">
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">Version {v.edition}</span>
                      <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{STATUS_LABEL[v.status]}</span>
                      <span className="text-xs text-muted-foreground">{labels.join(' › ')}</span>
                    </span>
                    <span className="flex items-center gap-3 text-sm text-muted-foreground">
                      <span>{v.publishedAt ? `Published ${DATE.format(new Date(v.publishedAt))}` : 'Not published'}</span>
                      <Link to="/versions/$versionId" params={{ versionId: v.id }} aria-label={`${editable ? 'Edit' : 'View'} version ${v.edition} of the quality framework`}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-foreground hover:bg-muted">
                        {editable ? <PencilIcon /> : <EyeIcon />}<span className="text-xs">{editable ? 'Edit' : 'View'}</span>
                      </Link>
                    </span>
                  </li>
                );
              })}
            </ul>
            {canWrite && latest && !draftOpen && (
              <form className="flex flex-wrap items-end gap-2" aria-label="New version"
                onSubmit={(e) => { e.preventDefault(); const ed = edition.trim(); if (ed) act(async () => { await api.newVersion(latest.id, { edition: ed }); setEdition(''); }); }}>
                <label className="flex flex-col text-sm">New version<Input aria-label="Version name" value={edition} onChange={(e) => setEdition(e.target.value)} className="w-40" placeholder="e.g. 2" /></label>
                <Button type="submit" variant="ghost">Create new version</Button>
              </form>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
