// Settings -> Trash (DEC-026): everything that was deleted in the last 30 days, grouped by the action that deleted it, with
// Restore, Delete forever and Empty trash. Plain words; Arabic content keeps its direction (dir="auto").
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { plural, TRASH_KIND_LABELS, TRASH_KINDS, type RestoreOptions, type TrashGroup, type TrashKind } from '@ams/shared';
import { useConfirm } from '../../components/confirm-dialog';
import { Dialog } from '../../components/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { ApiError } from '../../lib/framework-api';
import { useTrashApi, type TrashApi } from '../../lib/trash-api';

/** "2 sub-items, 11 notes": what a Trash item holds besides itself. */
export function countWords(counts: Record<string, number>): string {
  const parts: string[] = [];
  const add = (key: string, one: string, many?: string) => { const n = counts[key] ?? 0; if (n > 0) parts.push(plural(n, one, many)); };
  add('versions', 'version');
  add('subItems', 'sub-item');
  add('requirements', 'standard');
  add('evidenceOwners', 'evidence item that loses its owner', 'evidence items that lose their owner');
  add('documents', 'source document');
  add('pages', 'page');
  add('notes', 'note');
  add('mappings', 'link to other standards', 'links to other standards');
  return parts.join(', ');
}

const daysLeftText = (n: number) => (n <= 0 ? 'Removed today' : `${plural(n, 'day')} left`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function GroupContents({ api, groupId }: { api: TrashApi; groupId: string }) {
  const q = useQuery({ queryKey: ['trash', 'group', groupId], queryFn: () => api.group(groupId) });
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.isError) return <p role="alert" className="text-sm text-red-700">{(q.error as Error).message}</p>;
  return (
    <div className="space-y-2 border-t border-border pt-2" data-testid="trash-contents">
      {(q.data?.contents ?? []).map((c) => (
        <ul key={c.itemId} className="space-y-0.5 text-sm" aria-label={`Inside ${c.label}`}>
          {c.rows.map((r) => (
            <li key={`${r.table}-${r.id}`} style={{ paddingInlineStart: `${Math.min(r.depth, 6) * 1.25}rem` }} className="break-words" dir="auto">{r.label}</li>
          ))}
        </ul>
      ))}
    </div>
  );
}

/** A restore that needs a choice: the parent it sat under is gone. */
function PlaceDialog({ message, nearest, onPick, onClose }: { message: string; nearest: { id: string; label: string } | null; onPick: (o: RestoreOptions) => void; onClose: () => void }) {
  return (
    <Dialog labelledBy="trash-place-title" size="sm" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="trash-place-title" className="min-w-0 pt-1 text-lg font-semibold">Where should it go?</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <p className="mb-4 text-sm" dir="auto">{message}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="button" variant="outline" onClick={() => onPick({ atTopLevel: true })}>Put it at the top level</Button>
        {nearest && <Button type="button" onClick={() => onPick({ placeParentId: nearest.id })}><span dir="auto">Put it under {nearest.label}</span></Button>}
      </div>
    </Dialog>
  );
}

export function TrashPage({ api: override }: { api?: TrashApi }) {
  const api = useTrashApi(override);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [kind, setKind] = useState<TrashKind | ''>('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [place, setPlace] = useState<{ group: TrashGroup; message: string; nearest: { id: string; label: string } | null } | null>(null);
  const list = useQuery({ queryKey: ['trash', 'list', kind, search], queryFn: () => api.list({ ...(kind ? { kind } : {}), ...(search.trim() ? { q: search.trim() } : {}) }) });
  const refresh = () => { void qc.invalidateQueries(); };
  const groups = list.data?.groups ?? [];
  const retention = list.data?.retentionDays ?? 30;

  const restore = useMutation({
    mutationFn: ({ group, options }: { group: TrashGroup; options?: RestoreOptions }) => api.restoreGroup(group.groupId, options ?? {}),
    onSuccess: (r) => { setError(''); setNotice(r.message); setPlace(null); refresh(); },
    onError: (e, vars) => {
      setNotice('');
      if (e instanceof ApiError && e.details?.code === 'parent_missing') {
        setError('');
        setPlace({ group: vars.group, message: e.message, nearest: (e.details.nearestAncestor as { id: string; label: string } | null) ?? null });
        return;
      }
      setPlace(null);
      setError(e instanceof Error ? e.message : 'It could not be restored.');
    },
  });

  const removeForever = async (g: TrashGroup) => {
    const ok = await confirm({
      title: 'Delete forever?', tone: 'danger', confirmLabel: 'Delete forever',
      message: `${g.label} will be removed for good${g.kinds.includes('source_document') ? ', with its stored file' : ''}. This cannot be undone.`,
    });
    if (!ok) return;
    try { await api.deleteGroup(g.groupId); setError(''); setNotice(`Deleted forever: ${g.label}`); refresh(); } catch (e) { setError((e as Error).message); }
  };
  const empty = async () => {
    const ok = await confirm({
      title: 'Empty the Trash?', tone: 'danger', confirmLabel: 'Empty trash',
      message: `Everything in the Trash (${plural(list.data?.total ?? 0, 'item')}) will be removed for good, with any stored files. This cannot be undone.`,
    });
    if (!ok) return;
    try { const r = await api.empty(); setError(''); setNotice(`Emptied the Trash: ${plural(r.removed, 'item')} removed.`); refresh(); } catch (e) { setError((e as Error).message); }
  };
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <section className="space-y-4" aria-labelledby="trash-title">
      <div>
        <h2 id="trash-title" className="text-xl font-semibold">Trash</h2>
        <p className="text-sm text-muted-foreground">Deleted items stay here for {plural(retention, 'day')}, then they are removed for good. Restore puts them back as they were.</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex w-full min-w-0 flex-col text-sm sm:w-auto sm:max-w-xs sm:flex-1">Search the Trash
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Code, title or where it was" dir="auto" />
        </label>
        <label className="flex flex-col text-sm">Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as TrashKind | '')} className="rounded-md border border-border bg-background px-3 py-2 text-sm">
            <option value="">All kinds</option>
            {TRASH_KINDS.map((k) => <option key={k} value={k}>{TRASH_KIND_LABELS[k].many}</option>)}
          </select>
        </label>
        <Button type="button" variant="outline" className="ms-auto" disabled={(list.data?.total ?? 0) === 0} onClick={() => void empty()}>Empty trash</Button>
      </div>
      {notice && <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">{notice}</p>}
      {error && <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>}
      {list.isError && <p role="alert" className="text-sm text-red-700">{(list.error as Error).message}</p>}
      {list.data && groups.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-testid="trash-empty">
          {search || kind ? 'Nothing in the Trash matches.' : `The Trash is empty. Things you delete wait here for ${plural(retention, 'day')}.`}
        </p>
      )}
      <ul className="space-y-2" aria-label="Deleted items">
        {groups.map((g) => {
          const inside = countWords(g.counts);
          const isOpen = open.has(g.groupId);
          return (
            <li key={g.groupId} data-testid="trash-group" className="rounded-lg border border-border bg-background p-3 sm:p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="break-words font-medium [overflow-wrap:anywhere]" dir="auto">{g.label}</p>
                  {g.items.length === 1 && g.items[0]!.context && <p className="break-words text-xs text-muted-foreground" dir="auto">{g.items[0]!.context}</p>}
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {g.kinds.map((k) => <span key={k} className="rounded bg-muted px-1.5 py-0.5">{TRASH_KIND_LABELS[k].one}</span>)}
                    {inside && <span>Inside: {inside}</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Deleted {g.deletedByName ? <>by <span dir="auto">{g.deletedByName}</span> </> : null}on {when(g.deletedAt)} · <span className={g.daysLeft <= 3 ? 'font-medium text-red-700' : ''}>{daysLeftText(g.daysLeft)}</span>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  <Button type="button" onClick={() => restore.mutate({ group: g })} disabled={restore.isPending} aria-label={`Restore ${g.label}`}>Restore</Button>
                  <Button type="button" variant="outline" onClick={() => void removeForever(g)} aria-label={`Delete ${g.label} forever`}>Delete forever</Button>
                  <Button type="button" variant="ghost" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} what is inside ${g.label}`} onClick={() => toggle(g.groupId)}>{isOpen ? 'Hide contents' : 'Contents'}</Button>
                </div>
              </div>
              {isOpen && <GroupContents api={api} groupId={g.groupId} />}
            </li>
          );
        })}
      </ul>
      {place && (
        <PlaceDialog message={place.message} nearest={place.nearest} onClose={() => setPlace(null)} onPick={(options) => restore.mutate({ group: place.group, options })} />
      )}
    </section>
  );
}
