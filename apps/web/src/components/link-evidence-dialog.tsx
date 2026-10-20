import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EvidenceItem } from '@ams/shared';
import type { EvidenceApi } from '../lib/evidence-api';
import { useTranslation } from '../i18n';
import { Dialog } from './dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** The evidence dialogs' shell: the shared `Dialog` at the default width (full screen on phones). */
export function Modal({ labelledBy, onClose, children, z = 'z-50' }: { labelledBy: string; onClose: () => void; children: React.ReactNode; z?: string }) {
  return <Dialog labelledBy={labelledBy} onClose={onClose} z={z}>{children}</Dialog>;
}

/** Adds a piece of evidence to the repository: a title, document or data, an optional description, and the file. */
export function NewEvidenceDialog({ api, initialTitle = '', onCreated, onClose, dataWithoutFile = false }: {
  api: EvidenceApi; initialTitle?: string; onCreated: (item: EvidenceItem) => void; onClose: () => void;
  /** Data may be created without a file, to be entered in the online sheet afterwards. */
  dataWithoutFile?: boolean;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<EvidenceItem['type']>('document');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fileOptional = dataWithoutFile && type === 'data';
    if (!file && !fileOptional) { setError('Choose the file.'); return; }
    const f = new FormData(e.currentTarget);
    setBusy(true); setError('');
    try {
      const description = String(f.get('description') ?? '').trim();
      const item = await api.create({ title: String(f.get('title')).trim(), type, ...(description ? { description } : {}) });
      if (file) await api.upload(item.id, file);
      onCreated((await api.get(item.id)).item);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal labelledBy="new-evidence-title" onClose={onClose} z="z-[60]">
      <div className="mb-4 flex items-start justify-between gap-2">
        <h2 id="new-evidence-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">New evidence</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label="New evidence">
        <label className="flex flex-col text-sm">Title<Input name="title" aria-label="Title" required defaultValue={initialTitle} dir="auto" /></label>
        <div role="radiogroup" aria-label="Type" className="flex gap-4 text-sm">
          <label className="flex items-center gap-1"><input type="radio" name="type" checked={type === 'document'} onChange={() => setType('document')} /> Document</label>
          <label className="flex items-center gap-1"><input type="radio" name="type" checked={type === 'data'} onChange={() => setType('data')} /> Data</label>
        </div>
        <label className="flex flex-col text-sm">Description (optional)
          <textarea name="description" aria-label="Description" rows={3} dir="auto" className="rounded-md border border-border p-2 text-sm" />
        </label>
        <label className="flex flex-col text-sm">{dataWithoutFile && type === 'data' ? 'File (optional)' : 'File'}<input aria-label="File" type="file" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        {dataWithoutFile && type === 'data' && <p className="-mt-2 text-xs text-muted-foreground">Or leave it empty: define the columns and enter or import the data in the online sheet.</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Create evidence'}</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Link evidence to something: search the repository and pick one or more pieces (a standard is usually supported by
 * several); when one is not there, create it from the search. Each chosen piece needs its justification (required);
 * "Same for all" copies the first one to the rest. The links are made one after another; a failure stops there and says
 * which were linked.
 */
export function LinkEvidenceDialog({ api, title, onLink, onClose, mayReview }: {
  api: EvidenceApi; title: string; onLink: (evidenceVersionId: string, justification: string) => Promise<unknown>; onClose: () => void;
  /** Whether the person may review this link: then it is approved at once, else proposed for a reviewer (TASK-088). Said under the form when known. */
  mayReview?: boolean;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const [chosen, setChosen] = useState<EvidenceItem[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = useQuery({ queryKey: ['evidence', q], queryFn: () => api.list(q || undefined) });
  const picked = new Set(chosen.map((c) => c.id));
  const matches = (list.data ?? []).filter((e) => e.latest && e.status === 'active' && !picked.has(e.id));
  const showResults = focused;
  const choose = (ev: EvidenceItem) => { setChosen((c) => (c.some((x) => x.id === ev.id) ? c : [...c, ev])); setQ(''); setFocused(false); };
  const remove = (id: string) => { setChosen((c) => c.filter((x) => x.id !== id)); setReasons((r) => { const rest = { ...r }; delete rest[id]; return rest; }); };
  const ready = chosen.length > 0 && chosen.every((c) => c.latest && (reasons[c.id] ?? '').trim());
  const several = chosen.length > 1;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setError('');
    const done: string[] = [];
    try {
      for (const c of chosen) { await onLink(c.latest!.id, reasons[c.id]!.trim()); done.push(c.id); }
      onClose();
    } catch (err) {
      setChosen((cs) => cs.filter((c) => !done.includes(c.id)));
      setError(done.length ? `${done.length} linked; the rest were not: ${(err as Error).message}` : (err as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <>
      <Modal labelledBy="link-evidence-title" onClose={() => { if (!creating) onClose(); }}>
        <div className="mb-4 flex items-start justify-between gap-2">
          <h2 id="link-evidence-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">Link evidence <span className="ms-1 text-base font-normal text-muted-foreground">to {title}</span></h2>
          <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
        </div>
        <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label="Link evidence">
          <div className="relative" onFocus={() => setFocused(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false); }}>
            <Input role="combobox" aria-expanded={showResults} aria-controls="evidence-results" aria-label={chosen.length ? 'Add more evidence' : 'Search evidence'}
              placeholder={chosen.length ? 'Add more: search by title or tag' : 'Search evidence by title or tag'} value={q} onChange={(e) => setQ(e.target.value)} autoFocus={!chosen.length} />
            {showResults && (
              <ul id="evidence-results" role="listbox" aria-label="Matching evidence" className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-background py-1 shadow-lg">
                {matches.map((ev) => (
                  <li key={ev.id} role="option" aria-selected={false} tabIndex={-1} className="cursor-pointer px-3 py-1.5 text-sm hover:bg-muted"
                    onMouseDown={(e) => e.preventDefault()} onClick={() => choose(ev)}>
                    <span className="font-medium" dir="auto">{ev.title}</span> <span className="text-xs text-muted-foreground">v{ev.latest!.versionNo}{ev.periodLabel ? ` · ${ev.periodLabel}` : ''}</span>
                  </li>
                ))}
                {list.data && matches.length === 0 && <li className="px-3 py-1.5 text-sm text-muted-foreground">{q ? `No evidence matches "${q}".` : 'The evidence repository is empty.'}</li>}
                <li role="option" aria-selected={false} tabIndex={-1} className="cursor-pointer border-t border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
                  onMouseDown={(e) => e.preventDefault()} onClick={() => setCreating(true)}>
                  + Create new evidence{q ? ` "${q}"` : ''}
                </li>
              </ul>
            )}
          </div>
          {chosen.length > 0 && (
            <ul className="space-y-3" aria-label="Chosen evidence">
              {chosen.map((c, i) => (
                <li key={c.id} className="space-y-1 rounded-md border border-border p-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="chosen-evidence">
                    <span className="min-w-0 break-words font-medium" dir="auto">{c.title}</span>
                    <span className="text-xs text-muted-foreground">v{c.latest?.versionNo}{c.periodLabel ? ` · ${c.periodLabel}` : ''}</span>
                    <Button type="button" variant="ghost" className="ms-auto px-2 py-1" aria-label={several ? `Remove ${c.title}` : undefined} onClick={() => remove(c.id)}>{several ? 'Remove' : 'Change'}</Button>
                  </div>
                  <label className="flex flex-col text-sm">{several ? <span className="sr-only">Justification for {c.title}</span> : 'Justification'}
                    <textarea aria-label={several ? `Justification for ${c.title}` : 'Justification'} required rows={several ? 2 : 3} dir="auto" autoFocus={i === chosen.length - 1}
                      className="rounded-md border border-border p-2 text-sm" placeholder="Why this evidence supports it"
                      value={reasons[c.id] ?? ''} onChange={(e) => setReasons((r) => ({ ...r, [c.id]: e.target.value }))} />
                  </label>
                  {several && i === 0 && (reasons[c.id] ?? '').trim() && (
                    <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => setReasons((r) => Object.fromEntries(chosen.map((x) => [x.id, (r[x.id] ?? '').trim() ? r[x.id]! : r[c.id]!])))}>Same for all</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {mayReview !== undefined && chosen.length > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="link-outcome">{mayReview ? t('evidence.linkNote.approved') : t('evidence.linkNote.proposed')}</p>
          )}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !ready}>{busy ? 'Linking…' : several ? `Link ${chosen.length} pieces of evidence` : 'Link evidence'}</Button>
          </div>
        </form>
      </Modal>
      {creating && <NewEvidenceDialog api={api} initialTitle={q} onClose={() => setCreating(false)} onCreated={(item) => { setCreating(false); choose(item); }} />}
    </>
  );
}
