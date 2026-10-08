import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contrastWithWhite, isReadableAccent, ORG_UNIT_TYPES, type Institution, type OrgUnit } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { can, useMe } from '../../lib/me';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
const TYPE_LABEL = { college: 'College', school: 'School', department: 'Department', admin_unit: 'Administrative unit', other: 'Other' } as const;

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
  const [locale, setLocale] = useState<'en' | 'ar'>(initial.defaultLocale === 'ar' ? 'ar' : 'en');
  const [accent, setAccent] = useState(initial.accentColor ?? '');
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const accentOk = accent === '' || isReadableAccent(accent);
  const save = useMutation({
    mutationFn: async () => {
      setError(null); onSaved(false);
      const r = await act(() => api.updateInstitution({ nameEn, nameAr: nameAr || null, country: country || null, defaultLocale: locale, accentColor: accent || null }));
      if (r) { onSaved(true); await qc.invalidateQueries({ queryKey: ['institution'] }); }
    },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (accentOk) save.mutate(); };
  const field = 'flex flex-col gap-1 text-sm';
  return (
    <Card>
      <h2 className="mb-1 text-lg font-semibold">Institution</h2>
      <p className="mb-3 text-sm text-muted-foreground">{canEdit ? 'The name and look of the institution across the application.' : 'Only an administrator can change these.'}</p>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" aria-label="Institution">
        <label className={field}>Name (English)<Input aria-label="Name (English)" value={nameEn} onChange={(e) => setNameEn(e.target.value)} disabled={!canEdit} required /></label>
        <label className={field}>Name (Arabic)<Input aria-label="Name (Arabic)" dir="auto" value={nameAr} onChange={(e) => setNameAr(e.target.value)} disabled={!canEdit} /></label>
        <label className={field}>Country<Input aria-label="Country" value={country} onChange={(e) => setCountry(e.target.value)} disabled={!canEdit} /></label>
        <label className={field}>Default language
          <select aria-label="Default language" className={select} value={locale} onChange={(e) => setLocale(e.target.value as 'en' | 'ar')} disabled={!canEdit}>
            <option value="en">English</option><option value="ar">Arabic</option>
          </select>
        </label>
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
          <span className="text-xs text-muted-foreground">Logo upload arrives with file storage in a later milestone.</span>
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

interface Node extends OrgUnit { children: Node[] }
function buildTree(units: OrgUnit[]): Node[] {
  const byId = new Map(units.map((u) => [u.id, { ...u, children: [] as Node[] }]));
  const roots: Node[] = [];
  for (const n of byId.values()) (n.parentId ? byId.get(n.parentId)?.children : roots)?.push(n);
  const sort = (xs: Node[]) => { xs.sort((a, b) => a.nameEn.localeCompare(b.nameEn)); xs.forEach((x) => sort(x.children)); };
  sort(roots);
  return roots;
}
const descendants = (n: Node): string[] => n.children.flatMap((c) => [c.id, ...descendants(c)]);

function UnitRow({ node, depth, all, canEdit, api, onChanged, setError }: {
  node: Node; depth: number; all: OrgUnit[]; canEdit: boolean; api: SettingsApi; onChanged: () => void; setError: (e: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [nameEn, setNameEn] = useState(node.nameEn);
  const [nameAr, setNameAr] = useState(node.nameAr ?? '');
  const [type, setType] = useState(node.type);
  const [childName, setChildName] = useState('');
  const [childType, setChildType] = useState<OrgUnit['type']>('department');
  const act = useAction(setError);
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onSuccess: onChanged });
  const blocked = new Set([node.id, ...descendants(node)]);
  return (
    <li>
      <div className="flex flex-wrap items-center gap-2 rounded px-2 py-1 hover:bg-muted" style={{ paddingInlineStart: `${0.5 + depth * 1.5}rem` }} data-testid="org-unit">
        <span className="text-xs text-muted-foreground">{TYPE_LABEL[node.type]}</span>
        <ContentText className={`min-w-0 break-words ${node.active ? 'font-medium' : 'text-muted-foreground line-through'}`}>{node.nameEn}</ContentText>
        {node.nameAr && <ContentText className="text-sm text-muted-foreground">{node.nameAr}</ContentText>}
        {!node.active && <span className="rounded border border-border px-1.5 text-xs">Inactive</span>}
        {canEdit && (
          <span className="ms-auto flex items-center gap-1">
            <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => setAdding(!adding)} aria-label={`Add a unit under ${node.nameEn}`}>＋</Button>
            <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => setEditing(!editing)} aria-label={`Edit ${node.nameEn}`}>Edit</Button>
          </span>
        )}
      </div>
      {editing && (
        <form className="mb-2 flex flex-wrap items-end gap-2 ps-4 sm:ps-8" onSubmit={(e) => { e.preventDefault(); run.mutate(() => api.updateOrgUnit(node.id, { nameEn, nameAr: nameAr || null, type })); setEditing(false); }}>
          <label className="flex flex-col text-xs">Name<Input aria-label="Unit name" value={nameEn} onChange={(e) => setNameEn(e.target.value)} /></label>
          <label className="flex flex-col text-xs">Arabic name<Input aria-label="Unit Arabic name" dir="auto" value={nameAr} onChange={(e) => setNameAr(e.target.value)} /></label>
          <label className="flex flex-col text-xs">Type
            <select aria-label="Unit type" className={select} value={type} onChange={(e) => setType(e.target.value as OrgUnit['type'])}>{ORG_UNIT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select>
          </label>
          <label className="flex flex-col text-xs">Sits under
            <select aria-label="Unit parent" className={select} value={node.parentId ?? ''} onChange={(e) => { const parentId = e.target.value || null; run.mutate(() => api.updateOrgUnit(node.id, { parentId })); }}>
              <option value="">Top level</option>
              {all.filter((u) => !blocked.has(u.id) && u.active).map((u) => <option key={u.id} value={u.id}>{u.nameEn}</option>)}
            </select>
          </label>
          <Button type="submit" disabled={!nameEn.trim()}>Save</Button>
          <Button type="button" variant="ghost" onClick={() => run.mutate(() => api.updateOrgUnit(node.id, { active: !node.active }))}>{node.active ? 'Deactivate' : 'Reactivate'}</Button>
        </form>
      )}
      {adding && (
        <form className="mb-2 flex flex-wrap items-end gap-2 ps-4 sm:ps-8" onSubmit={(e) => { e.preventDefault(); if (childName.trim()) { run.mutate(() => api.createOrgUnit({ parentId: node.id, type: childType, nameEn: childName })); setChildName(''); setAdding(false); } }}>
          <label className="flex flex-col text-xs">New unit<Input aria-label={`Name of the new unit under ${node.nameEn}`} value={childName} onChange={(e) => setChildName(e.target.value)} /></label>
          <label className="flex flex-col text-xs">Type
            <select aria-label="New unit type" className={select} value={childType} onChange={(e) => setChildType(e.target.value as OrgUnit['type'])}>{ORG_UNIT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select>
          </label>
          <Button type="submit" disabled={!childName.trim()}>Add unit</Button>
        </form>
      )}
      {node.children.length > 0 && (
        <ul>{node.children.map((c) => <UnitRow key={c.id} node={c} depth={depth + 1} all={all} canEdit={canEdit} api={api} onChanged={onChanged} setError={setError} />)}</ul>
      )}
    </li>
  );
}

function OrgChartCard({ api, canEdit, canAddTop }: { api: SettingsApi; canEdit: boolean; canAddTop: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['org-units'], queryFn: () => api.orgUnits() });
  const tree = useMemo(() => buildTree(data ?? []), [data]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const act = useAction(setError);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org-units'] });
  const add = useMutation({ mutationFn: () => act(() => api.createOrgUnit({ parentId: null, type: 'college', nameEn: name })), onSuccess: () => { setName(''); void refresh(); } });
  return (
    <Card>
      <h2 className="mb-1 text-lg font-semibold">Org chart</h2>
      <p className="mb-3 text-sm text-muted-foreground">Colleges, schools, departments and administrative units. Programs sit in a unit, and roles can be given for a whole unit.</p>
      {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
      <ul aria-label="Org chart" className="text-sm">
        {tree.map((n) => <UnitRow key={n.id} node={n} depth={0} all={data ?? []} canEdit={canEdit} api={api} onChanged={() => void refresh()} setError={setError} />)}
        {tree.length === 0 && <li className="text-muted-foreground">No units yet.</li>}
      </ul>
      {canAddTop && (
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(); }}>
          <label className="flex flex-col text-xs">New top-level unit (a college, for example)<Input aria-label="New top-level unit" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <Button type="submit" disabled={!name.trim()}>Add</Button>
        </form>
      )}
    </Card>
  );
}

export function OrganizationPage({ api: override }: { api?: SettingsApi }) {
  const api = useSettingsApi(override);
  const me = useMe(api);
  return (
    <div className="space-y-6">
      <InstitutionCard api={api} canEdit={can(me.data, 'institution:write')} />
      <OrgChartCard api={api} canEdit={can(me.data, 'org:write')} canAddTop={me.data?.roles.some((r) => r === 'admin') ?? false} />
    </div>
  );
}
