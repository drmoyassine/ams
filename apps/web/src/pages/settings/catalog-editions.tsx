// The catalog's editions and versions (DEC-046, step 4): one edition per academic year, numbered versions that are frozen when published, and the
// draft of the working edition (the live structure) with what publishing it now would add. Publishing is Academic Affairs'; approval of a version
// is a later workflow. Deep-linked: ?tab=catalog&edition=<id>.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CatalogChange } from '@ams/shared';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useConfirm } from '../../components/confirm-dialog';
import { useCatalogApi, type CatalogApi } from '../../lib/catalog-api';
import { can, useMe } from '../../lib/me';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';

const date = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** The changes grouped by what they are about (General education, Program, Study plan, Course). */
export function ChangeList({ changes, label }: { changes: CatalogChange[]; label: string }) {
  if (!changes.length) return <p className="text-sm text-muted-foreground">No changes.</p>;
  const groups = [...new Set(changes.map((c) => c.area))];
  return (
    <div aria-label={label} className="space-y-2 text-sm">
      {groups.map((g) => (
        <section key={g}>
          <h5 className="text-xs font-semibold uppercase text-muted-foreground">{g}</h5>
          <ul className="list-disc ps-5">{changes.filter((c) => c.area === g).map((c, i) => <li key={i}><span className="font-medium">{c.subject}</span>: {c.text}</li>)}</ul>
        </section>
      ))}
    </div>
  );
}

export function CatalogEditionsSection({ catalog: catalogOverride, api: settingsOverride }: { catalog?: CatalogApi; api?: SettingsApi }) {
  const api = useCatalogApi(catalogOverride);
  const settings = useSettingsApi(settingsOverride);
  const me = useMe(settings);
  const canWrite = can(me.data, 'program:write');
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['catalog-editions'], queryFn: () => api.editions() });
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onError: (e) => setError(e instanceof Error ? e.message : 'Something went wrong'), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['catalog-editions'] }); } });
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const data = q.data;
  if (q.isError) return <p role="alert" className="text-sm text-red-700">Could not load the catalog editions.</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const working = data.editions.find((e) => e.id === data.workingId);
  const draft = data.draft;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Catalog</h3>
        <p className="text-sm text-muted-foreground">One edition per academic year, with numbered versions. What you edit (programs, requirements, study plans, courses and their approved content) is the draft of the working edition; publishing freezes it as the next version, which never changes. The catalog is printed from a published version, so a catalog year stays citable and can be amended by publishing another version.</p>
        {!canWrite && me.data && <p className="text-xs text-muted-foreground">You can read the catalog; Academic Affairs publishes it.</p>}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      {working && draft && (
        <Card>
          <section aria-label="Draft" className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold">Draft of {working.label}: version {draft.nextVersionNo}</h4>
              <span className="rounded bg-muted px-2 py-0.5 text-xs">Not published</span>
              <a href="/catalog/draft" className="ms-auto text-sm underline">Preview the catalog</a>
            </div>
            <h5 className="text-sm font-medium">{draft.nextVersionNo === 1 ? 'What version 1 would hold' : `Changes since version ${draft.nextVersionNo - 1}`}</h5>
            <ChangeList label="Changes in the draft" changes={draft.changes} />
            {draft.problems.length > 0 && (
              <div>
                <h5 className="text-sm font-medium">To look at before publishing</h5>
                <ul aria-label="Problems" className="list-disc ps-5 text-sm text-amber-900">{draft.problems.slice(0, 30).map((p, i) => <li key={i}>{p}</li>)}</ul>
                {draft.problems.length > 30 && <p className="text-xs text-muted-foreground">And {draft.problems.length - 30} more. They never stop a publish.</p>}
              </div>
            )}
            {canWrite && (
              <form aria-label="Publish" className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
                e.preventDefault();
                void confirm({ title: `Publish version ${draft.nextVersionNo} of ${working.label}?`, message: 'It is frozen as it is now and cannot be changed afterwards; later changes go into the next version.', confirmLabel: `Publish version ${draft.nextVersionNo}` })
                  .then((ok) => { if (ok) { run.mutate(() => api.publish(note.trim() || null)); setNote(''); } });
              }}>
                <label className="flex min-w-0 flex-col gap-1 text-xs"><span>Note for this version (optional)</span><Input aria-label="Version note" className="h-9 w-80 max-w-full" value={note} onChange={(e) => setNote(e.target.value)} /></label>
                <Button type="submit" disabled={draft.nextVersionNo > 1 && draft.changes.length === 0}>Publish version {draft.nextVersionNo}</Button>
                {draft.nextVersionNo > 1 && draft.changes.length === 0 && <span className="text-xs text-muted-foreground">Nothing has changed since version {draft.nextVersionNo - 1}.</span>}
              </form>
            )}
          </section>
        </Card>
      )}
      {!working && canWrite && <p className="text-sm text-muted-foreground">No edition is being worked on. Start one below.</p>}

      <ul aria-label="Editions" className="space-y-3">
        {data.editions.map((e) => (
          <li key={e.id} data-testid="edition">
            <Card>
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="font-semibold">{e.label}</h4>
                <span className={`rounded px-2 py-0.5 text-xs ${e.status === 'working' ? 'bg-emerald-50 text-emerald-900' : 'bg-muted'}`}>{e.status === 'working' ? 'Working' : 'Closed'}</span>
                <span className="text-xs text-muted-foreground">{e.versions.length} published version{e.versions.length === 1 ? '' : 's'}</span>
              </div>
              <ul aria-label={`Versions of ${e.label}`} className="mt-2 space-y-1 text-sm">
                {e.versions.map((v) => (
                  <li key={v.id} data-testid="version" className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">Version {v.versionNo}</span>
                      <span className="text-xs text-muted-foreground">{date(v.publishedAt)}{v.publishedByName ? ` by ${v.publishedByName}` : ''} · {v.changeCount} change{v.changeCount === 1 ? '' : 's'}</span>
                      {v.note && <span className="text-xs">“{v.note}”</span>}
                      <a href={`/catalog/${v.id}`} className="text-xs underline">Open the catalog</a>
                      <button type="button" className="text-xs underline" aria-expanded={open === v.id} aria-label={`Changes of version ${v.versionNo} of ${e.label}`} onClick={() => setOpen(open === v.id ? null : v.id)}>What changed</button>
                    </div>
                    {open === v.id && <VersionChanges api={api} id={v.id} />}
                  </li>
                ))}
                {e.versions.length === 0 && <li className="text-muted-foreground">No version published yet.</li>}
              </ul>
            </Card>
          </li>
        ))}
        {data.editions.length === 0 && <li className="text-sm text-muted-foreground">No editions yet.</li>}
      </ul>

      {canWrite && (!working || (working && working.versions.length > 0)) && (
        <form aria-label="Start an edition" className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (!label.trim()) return; run.mutate(() => api.startEdition(label.trim())); setLabel(''); }}>
          <label className="flex flex-col gap-1 text-xs"><span>{working ? `Start the next edition (closes ${working.label})` : 'Start an edition'}</span>
            <Input aria-label="Edition label" className="h-9 w-40" placeholder="2027-28" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <Button type="submit" variant="outline" disabled={!label.trim()}>Start edition</Button>
        </form>
      )}
    </div>
  );
}

function VersionChanges({ api, id }: { api: CatalogApi; id: string }) {
  const q = useQuery({ queryKey: ['catalog-version', id], queryFn: () => api.version(id) });
  if (q.isError) return <p role="alert" className="text-sm text-red-700">Could not load the version.</p>;
  if (!q.data) return <p className="text-xs text-muted-foreground">Loading…</p>;
  return <div className="ms-3 border-s border-border ps-3"><ChangeList label={`Changes of version ${q.data.versionNo}`} changes={q.data.changes} /></div>;
}
