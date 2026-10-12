import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ActionsMenu } from '../components/accordion';
import { VersionStatusBadge } from '../components/badges';
import { ContentText } from '../components/content-text';
import { AccreditorMark } from '../components/standard-card';
import { useConfirm } from '../components/confirm-dialog';
import { Dialog } from '../components/dialog';
import { versionLabel } from '../lib/version-label';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { confirmAndDeleteAll } from '../lib/delete-requirements';
import { ApiError, type FrameworkApi, type Issue, type Version } from '../lib/framework-api';
import { type GlossaryApi } from '../lib/glossary-api';
import { registerAssistantNav, usePublishScreen } from '../lib/assistant-screen';
import { can, useApi, useMe } from '../lib/me';
import { ExternalRequirements } from './version/external-requirements';
import { MappingsTab } from './version/mappings-tab';
import { ReportTab } from './version/report-tab';
import { RequirementsTab } from './version/requirements-tab';
import { SettingsTab, type SettingsSection } from './version/settings-tab';

const TABS = [
  { id: 'requirements', label: 'Requirements' },
  { id: 'mappings', label: 'Mappings' },
  { id: 'report', label: 'Report' },
  { id: 'settings', label: 'Settings' },
] as const;
export type VersionTab = (typeof TABS)[number]['id'];
const SCOPE = { institution: 'Institutional', program: 'Programmatic', both: 'Institutional and programmatic' } as const;
const STATUS = { draft: 'Draft', in_review: 'In review', published: 'Published', retired: 'Retired' } as const;

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/** Asks for the new edition's name, then copies the version into a new draft. */
function NewVersionDialog({ from, error, onCreate, onClose }: { from: Version; error: string; onCreate: (edition: string) => Promise<unknown>; onClose: () => void }) {
  const [edition, setEdition] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog labelledBy="new-version-title" onClose={onClose} size="sm">
      <h2 id="new-version-title" className="mb-1 min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">Start a new version</h2>
      <p className="mb-4 text-sm text-muted-foreground">A draft copied from {versionLabel(from.edition)}: its requirements, notes and configuration.</p>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!edition.trim()) return; setBusy(true); void onCreate(edition.trim()).finally(() => setBusy(false)); }}>
        <label className="flex flex-col text-sm">New edition<Input aria-label="New edition" value={edition} onChange={(e) => setEdition(e.target.value)} placeholder="e.g. 2028-29" autoFocus /></label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !edition.trim()}>Create draft</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * One version of a standard. The header names the standard and its accreditor, picks the version, and carries the one
 * action the version's state calls for (submit, publish, start a new version); the rest sits in its ⋯ menu.
 */
export function VersionPage({ versionId, api: apiProp, glossary, onOpenVersion, initialTab = 'requirements', initialSection, initialRunId, initialFocusRequirement, initialFocusPage, onLocation }: {
  versionId: string; api?: FrameworkApi; glossary?: GlossaryApi; onOpenVersion?: (id: string) => void; initialTab?: VersionTab; initialSection?: SettingsSection;
  /** The analysis run the Report tab opens on (the address's ?run=). */ initialRunId?: string;
  /** A requirement's card to open (the address's ?req=, from a link in the assistant). */ initialFocusRequirement?: string;
  /** A source page to open in Sources (the address's ?doc=&page=). */ initialFocusPage?: { documentId: string; page: number };
  /** Called when the tab or the selected run changes, so the address can follow and the page can be opened again later. */
  onLocation?: (where: { tab: VersionTab; run?: string }) => void;
}) {
  const api = useApi(apiProp);
  const me = useMe(api);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [tab, setTabState] = useState<VersionTab>(initialFocusPage ? 'settings' : initialTab);
  const [runId, setRunId] = useState<string | undefined>(initialRunId);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(initialFocusPage ? 'sources' : initialSection);
  const [focusPage, setFocusPage] = useState<{ documentId: string; page: number; n: number } | null>(initialFocusPage ? { ...initialFocusPage, n: 1 } : null);
  const setTab = (t: VersionTab, run: string | undefined = runId) => { setTabState(t); onLocation?.({ tab: t, ...(t === 'report' && run ? { run } : {}) }); };
  const selectRun = (id: string) => { setRunId(id); onLocation?.({ tab: 'report', run: id }); };
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [newVersion, setNewVersion] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const [focusRequirement, setFocusRequirement] = useState<string | null>(initialFocusRequirement ?? null);
  const showRequirement = (id: string) => { setFocusRequirement(id); setTab('requirements'); };
  const reportNav = {
    onShowRequirement: showRequirement,
    onShowPage: (documentId: string, page: number) => { setSettingsSection('sources'); setFocusPage((f) => ({ documentId, page, n: (f?.n ?? 0) + 1 })); setTab('settings'); },
    onShowMappings: () => setTab('mappings'),
    onShowSettings: (section: 'details' | 'sources' | 'ai') => {
      if (section === 'ai') { void navigate({ to: '/settings/ai' }); return; }
      setSettingsSection(section); setTab('settings');
    },
  };
  // "Open in Sources" in the split view: the same focus mechanism the report uses.
  const openSource = (documentId: string, page: number) => reportNav.onShowPage(documentId, page);
  const { data: version, isError } = useQuery({ queryKey: ['version', versionId], queryFn: () => api.version(versionId) });
  const internal = !!version?.internal;
  const framework = useQuery({ queryKey: ['framework', version?.frameworkId], queryFn: () => api.framework(version!.frameworkId), enabled: !!version && !internal });
  const editing = version?.status === 'draft' || version?.status === 'in_review';
  const validation = useQuery({ queryKey: ['validation', versionId], queryFn: () => api.validation(versionId), enabled: !!version && editing });
  const open = onOpenVersion ?? ((id: string) => { void navigate({ to: '/settings/versions/$versionId', params: { versionId: id } }); });

  // The assistant (DEC-027): tell it where the person is, and let its links open a requirement or a source page right here.
  const screenName = version ? `${framework.data?.accreditorShortName ?? framework.data?.name ?? 'Version'} ${version.edition}`.trim() : undefined;
  usePublishScreen('version-page', { versionId, ...(screenName ? { versionLabel: screenName } : {}), tab: internal ? 'requirements' : tab, tabLabel: TABS.find((t) => t.id === (internal ? 'requirements' : tab))?.label ?? 'Requirements' });
  useEffect(() => registerAssistantNav(versionId, { showRequirement, showPage: openSource }));

  if (isError) return <p role="alert">Could not load this version.</p>;
  if (!version) return <p>Loading…</p>;
  const m = me.data;
  const canWrite = can(m, 'framework:write');
  const canPublish = can(m, 'framework:publish');
  const f = framework.data;
  const refresh = () => Promise.all(['version', 'validation', 'versions', 'framework', 'frameworks'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const act = async (fn: () => Promise<unknown>) => {
    setError(''); setIssues([]);
    try { await fn(); await refresh(); return true; } catch (e) {
      if (e instanceof ApiError) { setError(e.message); setIssues(e.issues); void qc.invalidateQueries({ queryKey: ['validation', versionId] }); return false; }
      throw e;
    }
  };

  const primary = version.status === 'draft' && canWrite ? { label: 'Submit for review', run: () => act(() => api.submit(version.id)) }
    : version.status === 'in_review' && canPublish ? { label: 'Publish', run: () => act(() => api.publish(version.id)) }
      : version.status === 'published' && canWrite ? { label: 'Start a new version', run: async () => { setError(''); setNewVersion(true); } }
        : null;
  /** "Delete all standards in this version": one question with the counts, one action, one Trash group (drafts only). */
  const deleteAll = async () => {
    await act(async () => {
      const done = await confirmAndDeleteAll(api, confirm, version.id, versionLabel(version.edition));
      if (done === 'empty') { setError('There is nothing to delete in this version.'); return; }
      if (done) await qc.invalidateQueries({ queryKey: ['requirements', version.id] });
    });
  };
  const menu = [
    { label: 'Download JSON', onSelect: () => void act(async () => download(`${f?.accreditorShortName ?? 'standard'}-${version.edition}.json`, await api.exportFile(version.id))) },
    ...(version.status === 'in_review' && canWrite ? [{ label: 'Return to draft', onSelect: () => void act(() => api.returnToDraft(version.id)) }] : []),
    ...(version.status === 'published' && canPublish ? [{ label: 'Retire this version', onSelect: () => void confirm({
      title: `Retire ${versionLabel(version.edition)}?`, message: 'It stays readable but is no longer offered for new engagements.', confirmLabel: 'Retire', tone: 'danger',
    }).then((ok) => { if (ok) void act(() => api.retire(version.id)); }) }] : []),
    ...(version.status === 'draft' && canWrite ? [{ label: 'Delete all standards in this version', onSelect: () => void deleteAll() }] : []),
    ...((version.status === 'draft' || version.status === 'in_review') && canWrite ? [{ label: 'Delete this version', onSelect: () => void confirm({
      title: `Delete ${versionLabel(version.edition)}?`, tone: 'danger', confirmLabel: 'Delete',
      message: `The version and everything in it (its standards, notes, sources and templates) will be deleted. You can restore it from the Trash for 30 days.`,
    }).then(async (ok) => {
      if (!ok) return;
      const done = await act(() => api.deleteVersion(version.id));
      if (done) void navigate({ to: internal ? '/settings/quality-framework' : '/settings/external-standards' });
    }) }] : []),
  ];
  const problems = validation.data && !validation.data.ok ? validation.data.issues : [];
  const warnings = validation.data?.warnings ?? [];

  return (
    <section className="space-y-4">
      <p className="text-sm">
        {internal
          ? <Link to="/settings/quality-framework" className="underline">Internal Quality Framework</Link>
          : <><Link to="/settings/external-standards" className="underline">External Standards</Link>{f && <span className="text-muted-foreground"> / {f.accreditorShortName}</span>}</>}
      </p>
      {/* Phones: logo + title + accreditor, then the version row, then the actions (end-aligned) — nothing squeezes the title. */}
      <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex min-w-0 items-start gap-3">
            {f && <AccreditorMark shortName={f.accreditorShortName} logoUrl={f.logoVersion ? api.logoUrl(f.accreditorId, f.logoVersion) : null} />}
            <div className="min-w-0 flex-1 space-y-1">
              <h1 className="text-xl font-semibold leading-tight break-words sm:text-2xl"><ContentText>{internal ? 'Internal Quality Framework' : f?.name ?? ''}</ContentText></h1>
              {f && <p className="text-sm break-words text-muted-foreground"><ContentText>{f.accreditorName}</ContentText> · {SCOPE[f.scope]}</p>}
            </div>
          </div>
          <div className={`flex flex-wrap items-center gap-2 ${f ? 'sm:ps-[3.25rem]' : ''}`}>
            {f && f.versions.length > 1 ? (
              <select aria-label="Version" value={version.id} onChange={(e) => open(e.target.value)} className="max-w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 text-sm">
                {[...f.versions].reverse().map((v) => <option key={v.id} value={v.id}>{versionLabel(v.edition)}{v.id === version.id ? '' : ` (${STATUS[v.status].toLowerCase()})`}</option>)}
              </select>
            ) : <span className="text-sm font-medium break-words">{versionLabel(version.edition)}</span>}
            <VersionStatusBadge status={version.status} />
            {version.publishedAt && <span className="text-xs text-muted-foreground">Published {new Date(version.publishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {primary && <Button type="button" onClick={() => void primary.run()}>{primary.label}</Button>}
          <ActionsMenu label="More actions" items={menu} />
        </div>
      </header>
      {error && !newVersion && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm wrap-anywhere text-red-900">
          <p>{error}</p>
          {issues.length > 0 && <ul aria-label="Problems" className="mt-1 list-disc space-y-1 ps-5">{issues.map((i, n) => <li key={n}><code>{i.path}</code>: {i.message}</li>)}</ul>}
        </div>
      )}
      {problems.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm wrap-anywhere text-amber-900" data-testid="config-problems">
          <button type="button" className="underline" aria-expanded={showProblems} onClick={() => setShowProblems(!showProblems)}>
            {problems.length} problem{problems.length === 1 ? '' : 's'} to fix before this version can be published
          </button>
          {showProblems && <ul aria-label="Configuration issues" className="mt-2 list-disc space-y-1 ps-5">{problems.map((i, n) => <li key={n}><code>{i.path}</code>: {i.message}</li>)}</ul>}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm wrap-anywhere text-muted-foreground" data-testid="content-warnings">
          <button type="button" className="underline" aria-expanded={showWarnings} onClick={() => setShowWarnings(!showWarnings)}>
            {warnings.length} thing{warnings.length === 1 ? '' : 's'} to check before publishing (not blocking)
          </button>
          {showWarnings && <ul aria-label="Warnings" className="mt-2 list-disc space-y-1 ps-5">{warnings.map((i, n) => <li key={n}>{i.message}</li>)}</ul>}
        </div>
      )}
      {!internal && (
        <div role="tablist" className="flex flex-wrap gap-1 border-b border-border print:hidden">
          {TABS.map((t) => (
            <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm ${tab === t.id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`}>{t.label}</button>
          ))}
        </div>
      )}
      <div role="tabpanel">
        {(internal || tab === 'requirements') && (internal ? <RequirementsTab api={api} version={version} me={m} /> : <ExternalRequirements api={api} version={version} me={m} focusId={focusRequirement} onOpenSource={openSource} />)}
        {!internal && tab === 'mappings' && <MappingsTab api={api} version={version} me={m} />}
        {!internal && tab === 'report' && <ReportTab api={api} versionId={version.id} runId={runId} onSelectRun={selectRun} nav={reportNav} title={`${f?.name ?? 'Standard'} ${versionLabel(version.edition)}`} />}
        {!internal && tab === 'settings' && <SettingsTab api={api} version={version} framework={f} me={m} {...(glossary ? { glossary } : {})} {...(settingsSection ? { initial: settingsSection } : {})} {...(focusPage ? { focusPage } : {})} onShowRequirement={showRequirement} onShowReport={(id) => { setRunId(id); setTab('report', id); }} />}
      </div>
      {newVersion && (
        <NewVersionDialog from={version} error={error} onClose={() => { setNewVersion(false); setError(''); }}
          onCreate={async (edition) => {
            let created = '';
            const ok = await act(async () => { created = (await api.newVersion(version.id, { edition })).version.id; });
            if (ok) { setNewVersion(false); open(created); }
          }} />
      )}
    </section>
  );
}
