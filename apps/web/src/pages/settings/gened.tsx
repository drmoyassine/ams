// General Education (DEC-046): the credits every degree asks, and its areas, each with a minimum and a pool of courses. Owned by Academic
// Affairs: whoever may write programs for the whole institution. Deep-linked: ?tab=gened.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GenedArea } from '@ams/shared';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useConfirm } from '../../components/confirm-dialog';
import { useCatalogApi, type CatalogApi } from '../../lib/catalog-api';
import { can, useMe } from '../../lib/me';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';
import { useUrlId } from '../../lib/url-state';

const fmt = (n: number) => String(Math.round(n * 10) / 10);

function Pool({ area, courses, canWrite, onSave }: { area: GenedArea; courses: { id: string; code: string; titleEn: string; credits: number | null }[]; canWrite: boolean; onSave: (ids: string[]) => void }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set(area.courseIds));
  const needle = q.trim().toLowerCase();
  const shown = courses.filter((c) => picked.has(c.id) || !needle || `${c.code} ${c.titleEn}`.toLowerCase().includes(needle));
  const dirty = picked.size !== area.courseIds.length || area.courseIds.some((id) => !picked.has(id));
  return (
    <div className="space-y-2" role="group" aria-label={`Pool of ${area.nameEn}`}>
      <Input aria-label={`Find a course for ${area.nameEn}`} placeholder="Find a course by code or title" className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="max-h-60 overflow-auto rounded-md border border-border text-sm">
        {shown.slice(0, 200).map((c) => (
          <li key={c.id} className="flex items-center gap-2 border-b border-border px-2 py-1 last:border-b-0">
            <input type="checkbox" aria-label={`${c.code} in ${area.nameEn}`} disabled={!canWrite} checked={picked.has(c.id)}
              onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />
            <span className="font-mono">{c.code}</span><span>{c.titleEn}</span><span className="ms-auto text-xs text-muted-foreground">{c.credits ?? '—'} cr</span>
          </li>
        ))}
        {shown.length === 0 && <li className="px-2 py-2 text-muted-foreground">No course matches.</li>}
      </ul>
      {canWrite && <Button type="button" variant="outline" className="px-3 py-1" disabled={!dirty} onClick={() => onSave([...picked])}>Save the pool ({picked.size})</Button>}
    </div>
  );
}

export function GenedSection({ catalog: catalogOverride, api: settingsOverride, outcomes: outcomesOverride }: { catalog?: CatalogApi; api?: SettingsApi; outcomes?: OutcomesApi }) {
  const api = useCatalogApi(catalogOverride);
  const settings = useSettingsApi(settingsOverride);
  const oapi = useOutcomesApi(outcomesOverride);
  const me = useMe(settings);
  // Academic Affairs: program:write for the whole institution (the service decides; the page shows the buttons to those who hold it).
  const canWrite = can(me.data, 'program:write');
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['gened'], queryFn: () => api.gened() });
  const courses = useQuery({ queryKey: ['courses'], queryFn: () => oapi.courses() });
  const [openId, setOpenId] = useUrlId('area');
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['gened'] }); void qc.invalidateQueries({ queryKey: ['requirements'] }); } });
  const [credits, setCredits] = useState<string | null>(null);
  const [free, setFree] = useState<string | null>(null);
  const [area, setArea] = useState({ code: '', nameEn: '', minCredits: '3' });
  const data = q.data;
  if (q.isError) return <p role="alert" className="text-sm text-red-700">Could not load General education.</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const total = data.settings.genedCredits;
  const freeTotal = data.settings.freeElectiveCredits;
  const sumMin = data.areas.filter((a) => a.active).reduce((n, a) => n + a.minCredits, 0);
  const list = (courses.data ?? []).filter((c) => c.active).sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">General education</h3>
        <p className="text-sm text-muted-foreground">Owned by Academic Affairs: the credits of General education and of Free electives every degree asks by default, and the areas of General education with a minimum each. A program may set its own credits and its own minimum for an area (on the program page, Requirements); it marks which courses it requires and fills the rest as electives.</p>
        {!canWrite && me.data && <p className="text-xs text-muted-foreground">You can read General education; Academic Affairs changes it.</p>}
      </div>
      <Card>
        <form aria-label="General education credits" className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
          e.preventDefault();
          const n = (credits ?? (total === null ? '' : String(total))).trim(); const f = (free ?? (freeTotal === null ? '' : String(freeTotal))).trim();
          run.mutate(() => api.setSettings({ genedCredits: n === '' ? null : Number(n), freeElectiveCredits: f === '' ? null : Number(f) })); setCredits(null); setFree(null);
        }}>
          <label className="flex flex-col gap-1 text-xs"><span>Credits of General education (default)</span>
            <Input aria-label="General education credits" className="h-9 w-28" inputMode="decimal" disabled={!canWrite} value={credits ?? (total === null ? '' : String(total))} onChange={(e) => setCredits(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs"><span>Free elective credits (default)</span>
            <Input aria-label="Free elective credits" className="h-9 w-28" inputMode="decimal" disabled={!canWrite} value={free ?? (freeTotal === null ? '' : String(freeTotal))} onChange={(e) => setFree(e.target.value)} />
          </label>
          {canWrite && <Button type="submit" variant="outline" disabled={credits === null && free === null}>Save</Button>}
          <span className="text-xs text-muted-foreground">{total === null ? 'Not set: the total is not checked.' : `The areas' minimums add up to ${fmt(sumMin)} of ${fmt(total)}.`}</span>
        </form>
      </Card>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <ul aria-label="Areas" className="space-y-2">
        {data.areas.map((a) => (
          <li key={a.id} data-testid="area">
            <Card>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" aria-expanded={openId === a.id} aria-label={`Pool of ${a.nameEn}`} className="min-w-0 flex-1 text-start" onClick={() => setOpenId(openId === a.id ? '' : a.id)}>
                  <span className="font-mono font-semibold">{a.code}</span> <span className="font-medium">{a.nameEn}</span>
                  <span className="block text-xs text-muted-foreground">At least {fmt(a.minCredits)} credits · {a.courseIds.length} course{a.courseIds.length === 1 ? '' : 's'} in the pool{a.active ? '' : ' · inactive'}</span>
                </button>
                {canWrite && (
                  <>
                    <label className="flex items-center gap-1 text-xs">Minimum
                      <Input aria-label={`Minimum credits of ${a.nameEn}`} className="h-8 w-20" inputMode="decimal" defaultValue={a.minCredits}
                        onBlur={(e) => { const n = Number(e.target.value); if (e.target.value.trim() !== '' && !Number.isNaN(n) && n !== a.minCredits) run.mutate(() => api.updateArea(a.id, { minCredits: n })); }} />
                    </label>
                    <Button type="button" variant="ghost" className="px-2 py-0.5 text-xs" aria-label={`${a.active ? 'Deactivate' : 'Reactivate'} ${a.nameEn}`} onClick={() => run.mutate(() => api.updateArea(a.id, { active: !a.active }))}>{a.active ? 'Deactivate' : 'Reactivate'}</Button>
                    <Button type="button" variant="ghost" className="px-2 py-0.5 text-xs" aria-label={`Delete ${a.nameEn}`}
                      onClick={() => { void confirm({ title: `Delete ${a.nameEn}?`, message: 'Its pool goes with it. Courses and programs stay.', confirmLabel: 'Delete', tone: 'danger' }).then((ok) => { if (ok) run.mutate(() => api.deleteArea(a.id)); }); }}>Delete</Button>
                  </>
                )}
              </div>
              {openId === a.id && <div className="mt-3"><Pool key={`${a.id}-${a.courseIds.join()}`} area={a} courses={list} canWrite={canWrite} onSave={(ids) => run.mutate(() => api.setAreaCourses(a.id, ids))} /></div>}
            </Card>
          </li>
        ))}
        {data.areas.length === 0 && <li className="text-sm text-muted-foreground">No areas yet.</li>}
      </ul>
      {canWrite && (
        <form aria-label="Add an area" className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (!area.code.trim() || !area.nameEn.trim()) return; run.mutate(() => api.createArea({ code: area.code.trim(), nameEn: area.nameEn.trim(), minCredits: Number(area.minCredits) || 0 })); setArea({ code: '', nameEn: '', minCredits: '3' }); }}>
          <Input aria-label="Area code" className="h-9 w-28" placeholder="Code" value={area.code} onChange={(e) => setArea({ ...area, code: e.target.value })} />
          <Input aria-label="Area name" className="h-9 w-60" placeholder="Name (English)" value={area.nameEn} onChange={(e) => setArea({ ...area, nameEn: e.target.value })} />
          <Input aria-label="Area minimum credits" className="h-9 w-24" inputMode="decimal" placeholder="Minimum" value={area.minCredits} onChange={(e) => setArea({ ...area, minCredits: e.target.value })} />
          <Button type="submit" variant="outline" disabled={!area.code.trim() || !area.nameEn.trim()}>Add area</Button>
        </form>
      )}
    </div>
  );
}
