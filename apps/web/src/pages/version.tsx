import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { VersionStatusBadge } from '../components/badges';
import { type FrameworkApi } from '../lib/framework-api';
import { type GlossaryApi } from '../lib/glossary-api';
import { useApi, useMe } from '../lib/me';
import { ConfigTab } from './version/config-tab';
import { TerminologyTab } from './version/terminology-tab';
import { MappingsTab } from './version/mappings-tab';
import { PublishTab } from './version/publish-tab';
import { ExternalRequirements } from './version/external-requirements';
import { RequirementsTab } from './version/requirements-tab';
import { SourcesTab } from './version/sources-tab';
import { TemplatesTab } from './version/templates-tab';

const INTERNAL_TABS = ['requirements', 'publish'];
const TABS = [
  { id: 'requirements', label: 'Requirements' },
  { id: 'config', label: 'Lifecycle and vocabularies' },
  { id: 'templates', label: 'Report templates' },
  { id: 'sources', label: 'Sources' },
  { id: 'mappings', label: 'Mappings' },
  { id: 'terminology', label: 'Terminology' },
  { id: 'publish', label: 'Review and publish' },
] as const;

export function VersionPage({ versionId, api: apiProp, glossary, onOpenVersion }: { versionId: string; api?: FrameworkApi; glossary?: GlossaryApi; onOpenVersion?: (id: string) => void }) {
  const api = useApi(apiProp);
  const me = useMe(api);
  const navigate = useNavigate();
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('requirements');
  const { data: version, isError } = useQuery({ queryKey: ['version', versionId], queryFn: () => api.version(versionId) });
  const open = onOpenVersion ?? ((id: string) => { void navigate({ to: '/settings/versions/$versionId', params: { versionId: id } }); });

  if (isError) return <p role="alert">Could not load this version.</p>;
  if (!version) return <p>Loading…</p>;
  return (
    <section className="space-y-4">
      <p className="text-sm">
        {version.internal
          ? <Link to="/settings/quality-framework" className="underline">Internal Quality Framework</Link>
          : <Link to="/settings/external-standards" className="underline">External Standards</Link>}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{version.internal ? `Version ${version.edition}` : `Edition ${version.edition}`}</h1>
        <VersionStatusBadge status={version.status} />
        {version.supersedesId && <span className="text-sm text-muted-foreground">supersedes an earlier version</span>}
      </div>
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.filter((t) => !version.internal || INTERNAL_TABS.includes(t.id)).map((t) => (
          <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm ${tab === t.id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'requirements' && (version.internal ? <RequirementsTab api={api} version={version} me={me.data} /> : <ExternalRequirements api={api} version={version} me={me.data} />)}
        {tab === 'config' && <ConfigTab api={api} version={version} me={me.data} />}
        {tab === 'templates' && <TemplatesTab api={api} version={version} me={me.data} />}
        {tab === 'mappings' && <MappingsTab api={api} version={version} me={me.data} />}
        {tab === 'terminology' && <TerminologyTab version={version} me={me.data} glossary={glossary} />}
        {tab === 'sources' && <SourcesTab api={api} version={version} me={me.data} />}
        {tab === 'publish' && <PublishTab api={api} version={version} me={me.data} onOpenVersion={open} />}
      </div>
    </section>
  );
}
