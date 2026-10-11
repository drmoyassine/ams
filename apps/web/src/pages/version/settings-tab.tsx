import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Me } from '@ams/shared';
import { AccreditorMark } from '../../components/standard-card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import type { FrameworkApi, FrameworkListItem, Version } from '../../lib/framework-api';
import type { GlossaryApi } from '../../lib/glossary-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';
import { ConfigTab } from './config-tab';
import { SourcesSection } from './sources-section';
import { TemplatesTab } from './templates-tab';
import { TerminologyTab } from './terminology-tab';

const SECTIONS = [
  { id: 'details', label: 'Details' },
  { id: 'sources', label: 'Sources' },
  { id: 'lifecycle', label: 'Lifecycle and vocabularies' },
  { id: 'templates', label: 'Report templates' },
  { id: 'terminology', label: 'Terminology' },
] as const;
export type SettingsSection = (typeof SECTIONS)[number]['id'];
const MAX_LOGO_KB = 512;
const select = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm';

/**
 * What describes the standard and its accreditor, and the logo. These belong to the standard, not to a version, so they
 * stay editable while its versions are published.
 */
function Details({ api, f, me }: { api: FrameworkApi; f: FrameworkListItem; me: Me | undefined }) {
  const qc = useQueryClient();
  const canWrite = can(me, 'framework:write');
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const run = useAction(setError);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['framework', f.id] }), qc.invalidateQueries({ queryKey: ['frameworks'] })]);
  const text = (data: FormData, k: string) => String(data.get(k) ?? '').trim();
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    setError(''); setSaved(false);
    const ok = await run(async () => {
      await api.updateFramework(f.id, { name: text(d, 'name'), scope: text(d, 'scope') as FrameworkListItem['scope'], description: text(d, 'description') || null });
      await api.updateAccreditor(f.accreditorId, {
        name: text(d, 'accName'), shortName: text(d, 'accShort'), type: text(d, 'accType') as FrameworkListItem['accreditorType'],
        website: text(d, 'website') || null, country: text(d, 'country') || null,
      });
      return true;
    });
    await refresh();
    if (ok) setSaved(true);
  };
  const logo = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    if (file.size > MAX_LOGO_KB * 1024) { setError(`The logo is larger than ${MAX_LOGO_KB} KB.`); return; }
    await run(() => api.uploadLogo(f.accreditorId, file));
    await refresh();
  };
  const logoUrl = f.logoVersion ? api.logoUrl(f.accreditorId, f.logoVersion) : null;
  return (
    <form key={`${f.name}-${f.accreditorName}-${f.accreditorShortName}`} onSubmit={(e) => void save(e)} className="max-w-2xl min-w-0 space-y-6" aria-label="Details">
      <fieldset className="min-w-0 space-y-3" disabled={!canWrite}>
        <legend className="mb-2 font-medium">Standard</legend>
        <label className="flex flex-col text-sm">Name<Input name="name" aria-label="Standard name" defaultValue={f.name} required dir="auto" /></label>
        <label className="flex flex-col text-sm">Scope
          <select name="scope" aria-label="Scope" defaultValue={f.scope} className={select}>
            <option value="institution">Institutional</option><option value="program">Programmatic</option><option value="both">Institutional and programmatic</option>
          </select>
        </label>
        <label className="flex flex-col text-sm">Description
          <textarea name="description" aria-label="Description" rows={3} dir="auto" defaultValue={f.description ?? ''} className="rounded-md border border-border p-2 text-sm" />
        </label>
      </fieldset>
      <fieldset className="min-w-0 space-y-3" disabled={!canWrite}>
        <legend className="mb-2 font-medium">Accreditor</legend>
        <div className="flex flex-wrap items-center gap-3">
          <AccreditorMark shortName={f.accreditorShortName} logoUrl={logoUrl} />
          {canWrite && (
            <>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Logo file" className="sr-only" onChange={(e) => { void logo(e.target.files?.[0]); e.target.value = ''; }} />
              <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>{logoUrl ? 'Change logo' : 'Upload logo'}</Button>
              {logoUrl && <Button type="button" variant="ghost" onClick={() => void run(() => api.removeLogo(f.accreditorId)).then(refresh)}>Remove logo</Button>}
              <span className="text-xs text-muted-foreground">PNG, JPEG or WebP, up to {MAX_LOGO_KB} KB</span>
            </>
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_10rem]">
          <label className="flex flex-col text-sm">Name<Input name="accName" aria-label="Accreditor name" defaultValue={f.accreditorName} required dir="auto" /></label>
          <label className="flex flex-col text-sm">Short name<Input name="accShort" aria-label="Short name" defaultValue={f.accreditorShortName} required dir="auto" /></label>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex flex-col text-sm">Type
            <select name="accType" aria-label="Accreditor type" defaultValue={f.accreditorType} className={select}>
              <option value="institutional">Institutional</option><option value="programmatic">Programmatic</option><option value="regulatory">Regulatory</option>
            </select>
          </label>
          <label className="flex flex-col text-sm">Country<Input name="country" aria-label="Country" defaultValue={f.accreditorCountry ?? ''} /></label>
          <label className="flex flex-col text-sm">Website<Input name="website" type="url" aria-label="Website" defaultValue={f.accreditorWebsite ?? ''} placeholder="https://" dir="ltr" /></label>
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {saved && !error && <p role="status" className="text-sm text-emerald-800">Saved.</p>}
      {canWrite && <Button type="submit">Save details</Button>}
      <p className="text-xs text-muted-foreground">These describe the standard and its accreditor in every version; the requirements of a published version do not change.</p>
    </form>
  );
}

/** A standard's settings: its details (any time), and its version's sources and configuration (while the version is a draft). */
export function SettingsTab({ api, version, framework, me, glossary, initial = 'details', onShowRequirement, onShowReport, focusPage }: {
  api: FrameworkApi; version: Version; framework: FrameworkListItem | undefined; me: Me | undefined; glossary?: GlossaryApi; initial?: SettingsSection;
  /** Opens a requirement card on the Requirements tab (the analysis's gap links). */ onShowRequirement?: (id: string) => void;
  /** Opens a run's report on the Report tab. */ onShowReport?: (runId: string) => void;
  /** A source page to open and scroll to (a report's link to the page). */ focusPage?: { documentId: string; page: number; n: number };
}) {
  const [section, setSection] = useState<SettingsSection>(initial);
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:gap-6">
      <nav aria-label="Standard settings" className="-mb-1 flex min-w-0 shrink-0 flex-row gap-1 overflow-x-auto pb-1 lg:mb-0 lg:w-52 lg:flex-col lg:overflow-visible lg:pb-0">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" aria-current={section === s.id ? 'page' : undefined} onClick={() => setSection(s.id)}
            className={`shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-start text-sm hover:bg-muted ${section === s.id ? 'bg-muted font-medium' : 'text-muted-foreground'}`}>{s.label}</button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {section === 'details' && (framework ? <Details api={api} f={framework} me={me} /> : <p className="text-sm">Loading…</p>)}
        {section === 'sources' && <SourcesSection api={api} version={version} me={me} {...(onShowRequirement ? { onShowRequirement } : {})} {...(onShowReport ? { onShowReport } : {})} {...(focusPage ? { focusPage } : {})} />}
        {section === 'lifecycle' && <ConfigTab api={api} version={version} me={me} />}
        {section === 'templates' && <TemplatesTab api={api} version={version} me={me} />}
        {section === 'terminology' && <TerminologyTab version={version} me={me} {...(glossary ? { glossary } : {})} />}
      </div>
    </div>
  );
}
