import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_KEY_ROLES, type ApiKeyRole, type IssuedApiKey } from '@ams/shared';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { PageHeader } from '../../components/page-header';
import { useConfirm } from '../../components/confirm-dialog';
import { useApiKeysApi, type ApiKeysApi } from '../../lib/api-keys-api';
import { useAction } from '../../lib/use-action';

const ROLE_LABEL: Record<ApiKeyRole, string> = { admin: 'Administrator', lead: 'Lead (reads and writes)', contributor: 'Contributor', reviewer: 'Reviewer', viewer: 'Viewer (reads only)' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

/**
 * Settings -> API keys (DEC-040, administrators): the keys other systems call the API with. A key has a name, a role (what it may do) and
 * an optional expiry; it is shown once, when issued, and can be revoked at any time. Calls send it as `Authorization: Bearer <key>`.
 */
export function ApiKeysPage({ api: override }: { api?: ApiKeysApi }) {
  const api = useApiKeysApi(override);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api.list() });
  const [name, setName] = useState('');
  const [role, setRole] = useState<ApiKeyRole>('viewer');
  const [expires, setExpires] = useState('');
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['api-keys'] }); } });
  const field = 'flex min-w-0 flex-col gap-1 text-xs';
  return (
    <div className="space-y-4">
      <PageHeader title="API keys" />
      <p className="max-w-prose text-sm text-muted-foreground">Other systems (the student system, the BI, scripts) call the AMS API with a key. Each key acts with one role across the institution, and everything it does is in the audit trail under its name. Send it as <code className="rounded bg-muted px-1">Authorization: Bearer &lt;key&gt;</code>; the routes are listed at <a className="underline" href="/openapi.json">/openapi.json</a>.</p>
      {issued && (
        <Card>
          <div role="region" aria-label="New key" className="space-y-2">
            <p className="text-sm font-medium">Copy the key for "{issued.key.name}" now: it is not shown again.</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 max-w-full break-all rounded bg-muted px-2 py-1 text-xs" data-testid="new-key">{issued.token}</code>
              <Button type="button" variant="outline" className="px-3 py-1" onClick={() => { void navigator.clipboard?.writeText(issued.token).then(() => setCopied(true)); }}>{copied ? 'Copied' : 'Copy'}</Button>
              <Button type="button" variant="ghost" className="px-3 py-1" onClick={() => { setIssued(null); setCopied(false); }}>Done</Button>
            </div>
          </div>
        </Card>
      )}
      <Card>
        <form className="grid gap-3 sm:grid-cols-[1fr_14rem_10rem_auto] sm:items-end" aria-label="Issue a key"
          onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; run.mutate(async () => { const r = await api.create({ name, role, ...(expires ? { expiresAt: expires } : {}) }); setIssued(r); setCopied(false); setName(''); setExpires(''); return r; }); }}>
          <label className={field}>Name (what calls with it)<Input aria-label="Key name" value={name} placeholder="Student system sync" onChange={(e) => setName(e.target.value)} required /></label>
          <label className={field}>Role
            <select aria-label="Key role" className="h-9 w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm" value={role} onChange={(e) => setRole(e.target.value as ApiKeyRole)}>
              {API_KEY_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <label className={field}>Expires (optional)<Input aria-label="Key expiry" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
          <Button type="submit" disabled={!name.trim() || run.isPending}>Issue key</Button>
        </form>
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      </Card>
      <Card>
        {!keys.data ? <p className="text-sm text-muted-foreground">{keys.isError ? 'Could not load the keys.' : 'Loading…'}</p> : keys.data.length === 0 ? <p className="text-sm text-muted-foreground">No keys yet.</p> : (
          <ul className="divide-y divide-border" aria-label="API keys">
            {keys.data.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 py-2 text-sm" data-testid="api-key">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{k.name} <span className="font-mono text-xs text-muted-foreground">…{k.hint}</span></p>
                  <p className="text-xs text-muted-foreground">{ROLE_LABEL[k.role]} · issued {when(k.createdAt)}{k.createdByName ? ` by ${k.createdByName}` : ''} · last used {when(k.lastUsedAt)}{k.expiresAt ? ` · expires ${when(k.expiresAt)}` : ''}</p>
                </div>
                {k.revokedAt ? <span className="rounded border border-border px-2 py-0.5 text-xs">Revoked {when(k.revokedAt)}</span>
                  : k.expiresAt && Date.parse(k.expiresAt) < Date.now() ? <span className="rounded border border-border px-2 py-0.5 text-xs">Expired</span>
                  : <Button type="button" variant="ghost" className="px-2 py-1" aria-label={`Revoke ${k.name}`}
                    onClick={() => { void confirm({ title: `Revoke ${k.name}?`, message: 'Calls with this key are refused from now on. This cannot be undone.', confirmLabel: 'Revoke', tone: 'danger' }).then((ok) => { if (ok) run.mutate(() => api.revoke(k.id)); }); }}>Revoke</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
