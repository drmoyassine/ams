// Settings -> Assistant memory (DEC-027): what the assistant remembers. "Mine" is what the person wrote (personal notes, and
// notes they shared); "Shared" is what the team wrote about standards, versions and engagements this person can open. Edit,
// pin, set an expiry, delete; add a note by hand. Removing a note archives it first (it stops being used) and can be restored.
import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MEMORY_KINDS, MEMORY_MAX_CHARS, type MemoryItem, type MemoryKind, type MemoryScopeType, type MemoryVisibility } from '@ams/shared';
import { useConfirm } from '../../components/confirm-dialog';
import { ContentText } from '../../components/content-text';
import { Dialog } from '../../components/dialog';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useAssistantApi, type AssistantApi } from '../../lib/assistant-api';
import { defaultEngagementApi, type EngagementApi } from '../../lib/engagement-api';
import { ApiError, type FrameworkApi } from '../../lib/framework-api';
import { can, useApi, useMe } from '../../lib/me';

const KIND_LABEL: Record<MemoryKind, string> = { preference: 'Preference', convention: 'Convention', fact: 'Fact', decision: 'Decision' };
const select = 'h-10 w-full rounded-md border border-border bg-background px-2 text-sm';
const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const endOfDay = (d: string) => new Date(`${d}T23:59:59`).toISOString();

interface ScopeChoice { key: string; type: MemoryScopeType; id: string | null; label: string }
const keyOf = (type: MemoryScopeType, id: string | null) => `${type}:${id ?? ''}`;

/** The scopes a note can be about: the whole institution, each standard and version, each engagement. */
function useScopeChoices(frameworks: Pick<FrameworkApi, 'frameworks'>, engagements: Pick<EngagementApi, 'list'>): ScopeChoice[] {
  const fw = useQuery({ queryKey: ['frameworks'], queryFn: () => frameworks.frameworks(), staleTime: 60_000 });
  const en = useQuery({ queryKey: ['engagements'], queryFn: () => engagements.list(), staleTime: 60_000 });
  return useMemo(() => {
    const out: ScopeChoice[] = [{ key: keyOf('institution', null), type: 'institution', id: null, label: 'The whole institution' }];
    for (const f of fw.data ?? []) {
      out.push({ key: keyOf('framework', f.id), type: 'framework', id: f.id, label: `Standard: ${f.accreditorShortName} ${f.name}` });
      for (const v of f.versions) out.push({ key: keyOf('version', v.id), type: 'version', id: v.id, label: `Version: ${f.accreditorShortName} ${v.edition}` });
    }
    for (const e of en.data ?? []) out.push({ key: keyOf('engagement', e.id), type: 'engagement', id: e.id, label: `Engagement: ${e.title}` });
    return out;
  }, [fw.data, en.data]);
}

/** Add a note by hand, or edit one: its words, what it is about, who sees it, its kind, an expiry and a pin. */
function MemoryDialog({ api, item, choices, onClose, onSaved }: { api: AssistantApi; item: MemoryItem | null; choices: ScopeChoice[]; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(item?.text ?? '');
  const [scope, setScope] = useState(item ? keyOf(item.scope.type, item.scope.id) : keyOf('institution', null));
  const [visibility, setVisibility] = useState<MemoryVisibility>(item?.visibility ?? 'private');
  const [kind, setKind] = useState<MemoryKind>(item?.kind ?? 'preference');
  const [expires, setExpires] = useState(dateInput(item?.expiresAt ?? null));
  const [pinned, setPinned] = useState(item?.pinned ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The item's own scope stays choosable even when its name is not in the lists (for example a version that was archived).
  const options = item && !choices.some((c) => c.key === keyOf(item.scope.type, item.scope.id))
    ? [{ key: keyOf(item.scope.type, item.scope.id), type: item.scope.type, id: item.scope.id, label: item.scope.label }, ...choices] : choices;
  const chosen = options.find((c) => c.key === scope) ?? options[0]!;
  const everyone = chosen.type === 'institution' ? 'Everyone in the institution' : `Everyone who can see ${chosen.label.replace(/^[A-Za-z]+: /, '')}`;
  const readonlyShared = !!item && !item.mine;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const expiresAt = expires ? endOfDay(expires) : null;
      if (item) {
        await api.updateMemory(item.id, {
          text: text.trim(), kind, pinned, expiresAt,
          ...(readonlyShared ? {} : { scopeType: chosen.type, scopeId: chosen.id, visibility }),
        });
      } else {
        await api.createMemory({ text: text.trim(), scopeType: chosen.type, scopeId: chosen.id, visibility, kind, pinned, ...(expiresAt ? { expiresAt } : {}) });
      }
      onSaved();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not save this'); } finally { setBusy(false); }
  };
  return (
    <Dialog labelledBy="memory-dialog-title" size="md" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="memory-dialog-title" className="min-w-0 pt-1 text-lg font-semibold">{item ? 'Edit this memory' : 'Add memory'}</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label={item ? 'Edit memory' : 'Add memory'}>
        <label className="block text-sm">What to remember
          <textarea aria-label="What to remember" dir="auto" rows={3} required maxLength={MEMORY_MAX_CHARS} value={text} onChange={(e) => setText(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
          <span className="text-xs text-muted-foreground">{text.length} of {MEMORY_MAX_CHARS} characters. Write it in your own words.</span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">About
            <select aria-label="About" className={select} value={chosen.key} onChange={(e) => setScope(e.target.value)} disabled={readonlyShared}>
              {options.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <label className="block text-sm">Who sees it
            <select aria-label="Who sees it" className={select} value={visibility} onChange={(e) => setVisibility(e.target.value as MemoryVisibility)} disabled={readonlyShared}>
              <option value="private">Only me</option>
              <option value="workspace">{everyone}</option>
            </select>
          </label>
          <label className="block text-sm">Kind
            <select aria-label="Kind" className={select} value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
              {MEMORY_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </label>
          <label className="block text-sm">Forget on (optional)
            <Input aria-label="Forget on" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="size-5" /> Pin it (the assistant always sees pinned notes first)</label>
        {visibility === 'workspace' && <p className="text-xs text-muted-foreground">Shared notes need permission to edit what they are about. Only people who can open it will see the note.</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function Row({ item, onEdit, onPin, onDelete, onRestore }: { item: MemoryItem; onEdit: () => void; onPin: () => void; onDelete: () => void; onRestore: () => void }) {
  const archived = !!item.archivedAt;
  return (
    <li className={`space-y-1 rounded-md border border-border p-3 text-sm ${archived ? 'opacity-70' : ''}`} data-testid="memory-row">
      <p dir="auto" className="whitespace-pre-wrap break-words">{item.pinned && <span aria-label="Pinned" title="Pinned">📌 </span>}{item.text}</p>
      <p className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5">{item.visibility === 'private' ? 'Only me' : 'Shared'}</span>
        <span className="rounded bg-muted px-1.5 py-0.5">{KIND_LABEL[item.kind]}</span>
        <span>About: <ContentText>{item.scope.label}</ContentText></span>
        <span>By {item.mine ? 'you' : item.createdByName ?? 'someone'}, {when(item.updatedAt)}</span>
        {item.expiresAt && <span>Forgotten on {when(item.expiresAt)}</span>}
        {archived && <span>Removed</span>}
      </p>
      <div className="flex flex-wrap gap-1">
        {archived ? (
          <>
            <Button type="button" variant="outline" className="px-3 py-1" onClick={onRestore}>Restore</Button>
            <Button type="button" variant="outline" className="px-3 py-1 text-red-800" onClick={onDelete} aria-label={`Delete for good: ${item.text.slice(0, 40)}`}>Delete for good</Button>
          </>
        ) : item.canEdit ? (
          <>
            <Button type="button" variant="outline" className="px-3 py-1" onClick={onEdit} aria-label={`Edit: ${item.text.slice(0, 40)}`}>Edit</Button>
            <Button type="button" variant="outline" className="px-3 py-1" onClick={onPin} aria-pressed={item.pinned} aria-label={`${item.pinned ? 'Unpin' : 'Pin'}: ${item.text.slice(0, 40)}`}>{item.pinned ? 'Unpin' : 'Pin'}</Button>
            <Button type="button" variant="outline" className="px-3 py-1" onClick={onDelete} aria-label={`Delete: ${item.text.slice(0, 40)}`}>Delete</Button>
          </>
        ) : <span className="text-xs text-muted-foreground">Only its author, or someone who can edit what it is about, can change it.</span>}
      </div>
    </li>
  );
}

/** Settings -> Assistant memory: Mine and Shared, filtered by what a note is about. */
export function AssistantMemoryPage({ api: override, frameworks: fwOverride, engagements = defaultEngagementApi }: {
  api?: AssistantApi; frameworks?: FrameworkApi; engagements?: Pick<EngagementApi, 'list'>;
}) {
  const api = useAssistantApi(override);
  const frameworks = useApi(fwOverride);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const me = useMe(frameworks);
  const [tab, setTab] = useState<'mine' | 'shared'>('mine');
  const [scope, setScope] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);
  const [dialog, setDialog] = useState<{ item: MemoryItem | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choices = useScopeChoices(frameworks, engagements);
  const picked = choices.find((c) => c.key === scope);
  const list = useQuery({
    queryKey: ['assistant', 'memory', tab, scope, showRemoved],
    queryFn: () => api.memory({ tab, includeArchived: showRemoved, ...(picked ? { scopeType: picked.type, ...(picked.id ? { scopeId: picked.id } : {}) } : {}) }),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['assistant', 'memory'] });
  const run = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); await refresh(); } catch (e) { setError(e instanceof ApiError ? e.message : 'That did not work'); } },
  });
  const items = list.data ?? [];
  const remove = async (m: MemoryItem) => {
    const purge = !!m.archivedAt;
    const ok = await confirm({
      title: purge ? 'Delete this memory for good?' : 'Delete this memory?',
      message: purge ? 'It cannot be brought back.' : 'The assistant stops using it. You can still restore it from “Show removed”.',
      confirmLabel: 'Delete', tone: 'danger', details: [m.text.length > 120 ? `${m.text.slice(0, 120)}…` : m.text],
    });
    if (ok) run.mutate(() => api.deleteMemory(m.id));
  };
  const canAddShared = can(me.data, 'framework:write') || can(me.data, 'engagement:manage') || can(me.data, 'ai:manage');
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">Assistant memory</h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            What the assistant remembers between chats. Notes are saved only when you say so; it never saves words it finds in a document.
            A shared note is seen only by people who can open what it is about.
          </p>
        </div>
        <Button type="button" onClick={() => setDialog({ item: null })}>Add memory</Button>
      </div>

      <div role="tablist" aria-label="Memory" className="flex gap-1 border-b border-border">
        {([['mine', 'Mine'], ['shared', 'Shared']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`px-3 py-2 text-sm ${tab === id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`}>{label}</button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-0 flex-1 text-sm sm:max-w-sm">About
          <select aria-label="Filter by what it is about" className={select} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">Everything</option>
            {choices.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" className="size-5" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> Show removed</label>
      </div>

      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {list.isError && <p role="alert" className="text-sm text-red-700">Could not load the memory.</p>}
      {list.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {list.data && items.length === 0 && (
        <Card><p className="text-sm text-muted-foreground" data-testid="memory-empty">
          {tab === 'mine' ? 'You have not saved anything yet. Tell the assistant a preference, or add a note here.' : 'Nothing is shared with you yet.'}
          {tab === 'shared' && !canAddShared ? ' People who can edit standards can share notes for the whole team.' : ''}
        </p></Card>
      )}
      <ul className="space-y-2" aria-label={tab === 'mine' ? 'My memory' : 'Shared memory'}>
        {items.map((m) => (
          <Row key={m.id} item={m} onEdit={() => setDialog({ item: m })} onPin={() => run.mutate(() => api.updateMemory(m.id, { pinned: !m.pinned }))}
            onDelete={() => void remove(m)} onRestore={() => run.mutate(() => api.updateMemory(m.id, { archived: false }))} />
        ))}
      </ul>
      {dialog && <MemoryDialog api={api} item={dialog.item} choices={choices} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void refresh(); }} />}
    </section>
  );
}
