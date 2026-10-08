import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AccordionCard, HoverCard, Shaded } from './accordion';
import { ContentText } from './content-text';
import { versionLabel } from '../lib/version-label';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type { FrameworkApi, FrameworkListItem } from '../lib/framework-api';

type VersionSummary = FrameworkListItem['versions'][number];

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const STATUS = { draft: 'Draft', in_review: 'In review', published: 'Published', retired: 'Retired' } as const;
const SCOPE = { institution: 'Institutional', program: 'Programmatic', both: 'Institutional and programmatic' } as const;

/** "Published 5 Oct 2026", "Effective 1 Jan 2027" or "Not published". */
function dateOf(v: VersionSummary): string {
  return v.publishedAt ? `Published ${DATE.format(new Date(v.publishedAt))}` : v.effectiveFrom ? `Effective ${DATE.format(new Date(v.effectiveFrom))}` : 'Not published';
}

/** The version in use: the newest published one; with none published, the newest there is. */
export function currentVersion(versions: VersionSummary[]): VersionSummary | undefined {
  const published = versions.filter((v) => v.status === 'published').sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''));
  return published[published.length - 1] ?? versions[versions.length - 1];
}
const isOpenDraft = (v: VersionSummary) => v.status === 'draft' || v.status === 'in_review';

/** The accreditor's logo, or its short name on a tile when it has none. */
export function AccreditorMark({ shortName, logoUrl }: { shortName: string; logoUrl: string | null }) {
  return logoUrl
    ? <img src={logoUrl} alt={`${shortName} logo`} className="h-10 w-10 shrink-0 rounded-md border border-border bg-white object-contain p-0.5" />
    : <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-[0.65rem] font-semibold uppercase tracking-tight text-muted-foreground">{shortName.slice(0, 5)}</span>;
}

/** How much of a version's assessable requirements are mapped onto the institution's own standards. */
function MappedBar({ v }: { v: VersionSummary }) {
  const pct = v.assessableCount ? Math.round((v.mappedCount / v.assessableCount) * 100) : 0;
  return (
    <div className="min-w-40">
      <p className="text-sm">{v.mappedCount} of {v.assessableCount} mapped</p>
      <div className="mt-1 h-1.5 w-full rounded bg-muted" role="img" aria-label={`${pct}% of the requirements are mapped to your standards`}>
        <div className="h-1.5 rounded bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * One accreditor's standard on the External Standards page: logo, accreditor, name, scope and the version in use on the
 * closed card; opening it shows how complete it is and every version, and lets an editor start a new edition or change
 * the accreditor's logo.
 */
export function StandardCard({ f, api, canWrite, onImport }: { f: FrameworkListItem; api: FrameworkApi; canWrite: boolean; onImport: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [edition, setEdition] = useState('');
  const [error, setError] = useState('');
  const current = currentVersion(f.versions);
  const draft = f.versions.find((v) => isOpenDraft(v) && v.id !== current?.id);
  const logoUrl = f.logoVersion ? api.logoUrl(f.accreditorId, f.logoVersion) : null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['frameworks'] });
  const act = (fn: () => Promise<unknown>) => { setError(''); void fn().then(refresh, (e: Error) => setError(e.message)); };
  const openVersion = (id: string) => void navigate({ to: '/settings/versions/$versionId', params: { versionId: id } });
  const verb = (v: VersionSummary) => (isOpenDraft(v) ? 'Edit' : 'View');

  const startNew = () => {
    if (!current || !edition.trim()) return;
    act(async () => { const r = await api.newVersion(current.id, { edition: edition.trim() }); setStarting(false); setEdition(''); openVersion(r.version.id); });
  };

  const menu = [
    ...(current ? [{ label: 'Open', onSelect: () => openVersion(current.id) }] : []),
    ...(current ? [{ label: canWrite ? 'Edit details' : 'Details', onSelect: () => void navigate({ to: '/settings/versions/$versionId', params: { versionId: current.id }, search: { tab: 'settings', section: 'details' } }) }] : []),
    ...(canWrite && current ? [{ label: 'Start a new version', onSelect: () => { setOpen(true); setStarting(true); } }] : []),
    ...(canWrite ? [{ label: 'Import a new edition', onSelect: onImport }] : []),
  ];

  return (
    <div className="space-y-1">
    <AccordionCard label={f.name} title={f.name} strong tone="shaded" testId="standard-card"
      lead={<AccreditorMark shortName={f.accreditorShortName} logoUrl={logoUrl} />}
      open={open} onToggle={() => setOpen(!open)} menuLabel={`Actions for ${f.name}`} menu={menu}
      subtitle={(
        <>
          {[SCOPE[f.scope], current && versionLabel(current.edition), current && (current.status === 'published' ? dateOf(current) : STATUS[current.status])].filter(Boolean).join(' · ')}
          {draft && <span className="ms-2 rounded bg-amber-50 px-1.5 py-0.5 text-amber-900">Draft {draft.edition} in progress</span>}
        </>
      )}
      hover={(
        <HoverCard>
          <p className="font-semibold"><ContentText>{f.name}</ContentText></p>
          <p className="text-muted-foreground"><ContentText>{f.accreditorName}</ContentText> · {SCOPE[f.scope]}</p>
          {current && <p className="mt-1 text-xs">{current.requirementCount} requirements · {current.mappedCount} of {current.assessableCount} mapped · {current.engagementCount} engagement{current.engagementCount === 1 ? '' : 's'}</p>}
        </HoverCard>
      )}>
      <div className="space-y-2">
        <Shaded>Accreditor</Shaded>
        <p className="text-sm"><ContentText>{f.accreditorName}</ContentText> <span className="text-muted-foreground">· {f.accreditorType}</span></p>
      </div>
      {current && (
        <div className="space-y-2">
          <Shaded>{current.status === 'published' ? `In use: ${versionLabel(current.edition)}` : `Latest: ${versionLabel(current.edition)} (${STATUS[current.status].toLowerCase()})`}</Shaded>
          <div className="flex flex-wrap items-start gap-x-8 gap-y-3 text-sm" data-testid="standard-summary">
            <p>{current.requirementCount} requirement{current.requirementCount === 1 ? '' : 's'}</p>
            <MappedBar v={current} />
            <p>{current.engagementCount} engagement{current.engagementCount === 1 ? '' : 's'} use{current.engagementCount === 1 ? 's' : ''} it</p>
          </div>
        </div>
      )}
      <div className="space-y-2">
        <Shaded>Versions</Shaded>
        <ul className="divide-y divide-border rounded-md border border-border bg-background" aria-label={`Versions of ${f.name}`}>
          {[...f.versions].reverse().map((v) => {
            const date = dateOf(v);
            return (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2" data-testid="version-row">
                <span className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{versionLabel(v.edition)}</span>
                  <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{STATUS[v.status]}</span>
                  {v.id === current?.id && v.status === 'published' && <span className="text-xs text-muted-foreground">in use</span>}
                </span>
                <span className="flex items-center gap-3 text-sm text-muted-foreground">
                  <span>{v.requirementCount} requirements · {v.mappedCount}/{v.assessableCount} mapped</span>
                  <span>{date}</span>
                  <Link to="/settings/versions/$versionId" params={{ versionId: v.id }} aria-label={`${verb(v)} version ${v.edition} of ${f.name}`}
                    className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted">{verb(v)}</Link>
                </span>
              </li>
            );
          })}
          {f.versions.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No versions yet.</li>}
        </ul>
      </div>
      {canWrite && (
        <div className="flex flex-wrap items-end gap-2">
          {starting && current ? (
            <>
              <label className="flex flex-col text-sm">New edition (copied from {current.edition})<Input aria-label="New edition" value={edition} onChange={(e) => setEdition(e.target.value)} placeholder="e.g. 2028-29" className="w-48" autoFocus /></label>
              <Button type="button" disabled={!edition.trim()} onClick={startNew}>Create draft</Button>
              <Button type="button" variant="ghost" onClick={() => setStarting(false)}>Cancel</Button>
            </>
          ) : (
            <>
              {current && <Button type="button" variant="outline" onClick={() => setStarting(true)}>Start a new version</Button>}
              <Button type="button" variant="outline" onClick={onImport}>Import a new edition</Button>
            </>
          )}
        </div>
      )}
    </AccordionCard>
    {error && <p role="alert" className="px-1 text-sm text-red-700">{error}</p>}
    </div>
  );
}
