import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contrastWithWhite, isReadableAccent, type Institution } from '@ams/shared';
import { ReadOnlyNote } from '../../components/read-only-note';
import { OrgChartSection } from './org-chart/org-chart-section';
import { useTranslation } from '../../i18n';
import { LanguagesSection } from './languages-section';
import { ProgramsSettingsPage } from './programs';
import { AcademicCalendarSection } from './academic-calendar-section';
import { ScopeLevelsSection } from './scope-levels-section';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { can, useMe } from '../../lib/me';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';

/**
 * Loads the institution, then hands it to the form. The form is keyed by the saved values, so a background refetch that
 * returns the same data never resets what someone is typing, and a save (or another admin's change) refreshes it.
 */
function InstitutionCard({ api, canEdit }: { api: SettingsApi; canEdit: boolean }) {
  const { data } = useQuery({ queryKey: ['institution'], queryFn: () => api.institution() });
  const [saved, setSaved] = useState(false);
  if (!data) return <Card><p className="text-sm text-muted-foreground">Loading…</p></Card>;
  return <InstitutionForm key={JSON.stringify(data)} api={api} canEdit={canEdit} initial={data} saved={saved} onSaved={setSaved} />;
}

function InstitutionForm({ api, canEdit, initial, saved, onSaved }: { api: SettingsApi; canEdit: boolean; initial: Institution; saved: boolean; onSaved: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [nameEn, setNameEn] = useState(initial.nameEn);
  const [nameAr, setNameAr] = useState(initial.nameAr ?? '');
  const [country, setCountry] = useState(initial.country ?? '');
  const [accent, setAccent] = useState(initial.accentColor ?? '');
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const accentOk = accent === '' || isReadableAccent(accent);
  const save = useMutation({
    mutationFn: async () => {
      setError(null); onSaved(false);
      const r = await act(() => api.updateInstitution({ nameEn, nameAr: nameAr || null, country: country || null, accentColor: accent || null }));
      if (r) { onSaved(true); await qc.invalidateQueries({ queryKey: ['institution'] }); }
    },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (accentOk) save.mutate(); };
  const field = 'flex flex-col gap-1 text-sm';
  return (
    <Card>
      <h3 className="mb-1 text-lg font-semibold">Details</h3>
      <p className="mb-3 text-sm text-muted-foreground">The name and look of the institution across the application.</p>
      <ReadOnlyNote show={!canEdit} className="mb-3" />
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" aria-label="Institution details">
        <label className={field}>Name (English)<Input aria-label="Name (English)" value={nameEn} onChange={(e) => setNameEn(e.target.value)} disabled={!canEdit} required /></label>
        <label className={field}>Name (Arabic)<Input aria-label="Name (Arabic)" dir="auto" value={nameAr} onChange={(e) => setNameAr(e.target.value)} disabled={!canEdit} /></label>
        <label className={field}>Country<Input aria-label="Country" value={country} onChange={(e) => setCountry(e.target.value)} disabled={!canEdit} /></label>
        <div className={`${field} sm:col-span-2`}>
          <span>Accent colour (buttons and highlights)</span>
          <div className="flex flex-wrap items-center gap-3">
            <input type="color" aria-label="Pick accent colour" value={isReadableAccent(accent) ? accent : '#1f3b66'} onChange={(e) => setAccent(e.target.value)} disabled={!canEdit} className="h-9 w-12 rounded border border-border" />
            <Input aria-label="Accent colour" className="w-32" value={accent} onChange={(e) => setAccent(e.target.value.trim())} placeholder="#1f3b66" disabled={!canEdit} />
            {accent && /^#[0-9a-fA-F]{6}$/.test(accent) && (
              <span className="rounded px-3 py-1 text-sm text-white" style={{ background: accent }} data-testid="accent-preview">Preview · contrast {contrastWithWhite(accent).toFixed(1)}</span>
            )}
            {!accentOk && <span role="alert" className="text-sm text-red-700">Choose a darker colour: white text on it must reach a contrast of 4.5.</span>}
            {canEdit && accent && <Button type="button" variant="ghost" onClick={() => setAccent('')}>Use the default</Button>}
          </div>
        </div>
        {canEdit && (
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={!accentOk || !nameEn.trim() || save.isPending}>Save</Button>
            {saved && <span role="status" className="text-sm text-emerald-800">Saved.</span>}
            {error && <span role="alert" className="text-sm text-red-700">{error}</span>}
          </div>
        )}
      </form>
    </Card>
  );
}

const MAX_LOGO_KB = 512;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** The institution's logo: shown in the app header and on the sign-in page. Same rules as an accreditor's logo. */
function LogoCard({ api, canEdit }: { api: SettingsApi; canEdit: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['institution'], queryFn: () => api.institution() });
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = useAction(setError);
  const logoUrl = data?.logoVersion ? api.institutionLogoUrl(data.logoVersion) : null;
  const run = async (fn: () => Promise<unknown>) => {
    setError(null); setBusy(true);
    try { await act(fn); await qc.invalidateQueries({ queryKey: ['institution'] }); } finally { setBusy(false); }
  };
  const pick = (file: File | undefined) => {
    if (!file) return;
    // The server decides by the file's bytes; these checks only save a round trip.
    if (file.type && !LOGO_TYPES.includes(file.type)) { setError(file.type === 'image/svg+xml' ? 'SVG logos are not accepted. Use a PNG, JPEG or WebP image.' : 'The logo must be a PNG, JPEG or WebP image.'); return; }
    if (file.size > MAX_LOGO_KB * 1024) { setError(`The logo is larger than ${MAX_LOGO_KB} KB.`); return; }
    void run(() => api.uploadInstitutionLogo(file));
  };
  return (
    <Card>
      <h3 className="mb-1 text-lg font-semibold">Logo</h3>
      <p className="mb-3 text-sm text-muted-foreground">Shown in the application header and on the sign-in page.</p>
      <ReadOnlyNote show={!canEdit} className="mb-3" />
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-20 w-48 max-w-full items-center justify-center rounded-md border border-border bg-background p-2" data-testid="logo-preview">
          {logoUrl
            ? <img src={logoUrl} alt={data ? `Logo of ${data.nameEn}` : 'Logo'} className="max-h-full max-w-full object-contain" />
            : <span className="text-sm text-muted-foreground">No logo uploaded</span>}
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Logo file" className="sr-only" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
            <Button type="button" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>{logoUrl ? 'Change' : 'Upload logo'}</Button>
            {logoUrl && <Button type="button" variant="ghost" disabled={busy} onClick={() => void run(() => api.removeInstitutionLogo())}>Remove</Button>}
          </div>
        )}
      </div>
      {canEdit && <p className="mt-2 text-xs text-muted-foreground">PNG, JPEG or WebP, up to {MAX_LOGO_KB} KB. SVG is not accepted.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </Card>
  );
}

export const ORGANIZATION_TABS = [{ id: 'institution' }, { id: 'programs' }] as const;
export type OrganizationTab = (typeof ORGANIZATION_TABS)[number]['id'];

/**
 * Settings -> Organization: one screen, two tabs. Institution holds the details, the logo and the org chart (Languages
 * joins later); Programs holds the programs. `tab` (from the address) makes it deep-linkable; without it the page keeps its own.
 */
export function OrganizationPage({ api: override, tab: tabProp, onTab }: { api?: SettingsApi; tab?: OrganizationTab; onTab?: (tab: OrganizationTab) => void }) {
  const { t } = useTranslation();
  const api = useSettingsApi(override);
  const me = useMe(api);
  const [local, setLocal] = useState<OrganizationTab>('institution');
  const tab = tabProp ?? local;
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const choose = (id: OrganizationTab) => { setLocal(id); onTab?.(id); };
  const tabLabel = { institution: t('org.tab.institution'), programs: t('org.tab.programs') } as const;
  // Arrow keys, Home and End move between the tabs (the focused tab is the selected one).
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const rtl = window.getComputedStyle(e.currentTarget).direction === 'rtl';
    const i = ORGANIZATION_TABS.findIndex((o) => o.id === tab);
    const n = ORGANIZATION_TABS.length;
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    const next = e.key === forward ? (i + 1) % n : e.key === back ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const target = ORGANIZATION_TABS[next]!;
    choose(target.id);
    refs.current[target.id]?.focus();
  };
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">{t('settings.organization')}</h2>
      <div role="tablist" aria-label={t('settings.organization')} className="flex flex-wrap gap-1 border-b border-border">
        {ORGANIZATION_TABS.map((o) => (
          <button key={o.id} ref={(el) => { refs.current[o.id] = el; }} id={`org-tab-${o.id}`} role="tab" type="button" aria-selected={tab === o.id} aria-controls="org-tabpanel"
            tabIndex={tab === o.id ? 0 : -1} onClick={() => choose(o.id)} onKeyDown={onKey}
            className={`px-3 py-2 text-sm ${tab === o.id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`}>{tabLabel[o.id]}</button>
        ))}
      </div>
      <div role="tabpanel" id="org-tabpanel" aria-labelledby={`org-tab-${tab}`} className="space-y-6">
        {tab === 'institution' ? (
          <>
            <InstitutionCard api={api} canEdit={can(me.data, 'institution:write')} />
            <LogoCard api={api} canEdit={can(me.data, 'institution:write')} />
            <LanguagesSection api={api} canEdit={can(me.data, 'institution:write')} />
            <OrgChartSection api={api} canEdit={can(me.data, 'org:write')} onOpenPrograms={() => choose('programs')} />
            <ScopeLevelsSection api={api} canEdit={can(me.data, 'org:write')} />
            <AcademicCalendarSection api={api} canEdit={can(me.data, 'org:write')} />
          </>
        ) : <ProgramsSettingsPage api={api} />}
      </div>
    </div>
  );
}
