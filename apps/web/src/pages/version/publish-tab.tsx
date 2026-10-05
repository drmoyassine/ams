import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { ApiError, type FrameworkApi, type Issue, type Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import type { Me } from '@ams/shared';

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/** Validation, the status workflow, export and "new version". Publishing is final: a published version never changes. */
export function PublishTab({ api, version, me, onOpenVersion }: { api: FrameworkApi; version: Version; me: Me | undefined; onOpenVersion: (id: string) => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [edition, setEdition] = useState('');
  const validation = useQuery({ queryKey: ['validation', version.id], queryFn: () => api.validation(version.id) });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['version', version.id] }); await qc.invalidateQueries({ queryKey: ['validation', version.id] }); await qc.invalidateQueries({ queryKey: ['versions'] }); };
  const act = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => {
      setError(''); setIssues([]);
      try { await fn(); await refresh(); } catch (e) { if (e instanceof ApiError) { setError(e.message); setIssues(e.issues); } else throw e; }
    },
  });
  const canWrite = can(me, 'framework:write');
  const canPublish = can(me, 'framework:publish');

  return (
    <div className="space-y-6">
      <section aria-label="Configuration check">
        <h3 className="mb-1 font-medium">Configuration check</h3>
        {validation.data?.ok && <p role="status" className="text-sm text-emerald-800">The configuration is valid.</p>}
        {validation.data && !validation.data.ok && (
          <ul aria-label="Configuration issues" className="list-disc space-y-1 ps-5 text-sm text-red-700">
            {validation.data.issues.map((i, n) => <li key={n}><code>{i.path}</code>: {i.message}</li>)}
          </ul>
        )}
      </section>

      <section aria-label="Workflow" className="space-y-2">
        <h3 className="font-medium">Workflow</h3>
        <p className="text-sm text-muted-foreground">Draft → In review → Published. Everything must be reviewed before it can be published, and a published version never changes: edit by creating a new version.</p>
        <div className="flex flex-wrap gap-2">
          {version.status === 'draft' && canWrite && <Button type="button" onClick={() => act.mutate(() => api.submit(version.id))}>Submit for review</Button>}
          {version.status === 'in_review' && canWrite && <Button type="button" variant="ghost" onClick={() => act.mutate(() => api.returnToDraft(version.id))}>Return to draft</Button>}
          {version.status === 'in_review' && canPublish && <Button type="button" onClick={() => act.mutate(() => api.publish(version.id))}>Publish</Button>}
          {version.status === 'published' && canPublish && <Button type="button" variant="ghost" onClick={() => act.mutate(() => api.retire(version.id))}>Retire</Button>}
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {issues.length > 0 && <ul aria-label="Problems" className="list-disc space-y-1 ps-5 text-sm text-red-700">{issues.map((i, n) => <li key={n}><code>{i.path}</code>: {i.message}</li>)}</ul>}
        {version.publishedAt && <p className="text-sm text-muted-foreground">Published {new Date(version.publishedAt).toLocaleString()}.</p>}
      </section>

      <section aria-label="Export and new version" className="space-y-2">
        <h3 className="font-medium">Export and new version</h3>
        <Button type="button" variant="ghost" onClick={() => act.mutate(async () => download(`framework-${version.edition}.json`, await api.exportFile(version.id)))}>Download JSON</Button>
        {canWrite && (
          <div className="flex items-end gap-2">
            <label className="text-sm">New edition <Input value={edition} onChange={(e) => setEdition(e.target.value)} placeholder="e.g. 2025" className="w-40" /></label>
            <Button type="button" disabled={!edition} onClick={() => act.mutate(async () => { const r = await api.newVersion(version.id, { edition }); onOpenVersion(r.version.id); })}>Create a new draft from this version</Button>
          </div>
        )}
      </section>
    </div>
  );
}
