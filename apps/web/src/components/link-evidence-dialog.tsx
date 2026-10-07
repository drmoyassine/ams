import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EvidenceItem } from '@ams/shared';
import type { EvidenceApi } from '../lib/evidence-api';
import { Button } from './ui/button';
import { Input } from './ui/input';


function Modal({ labelledBy, onClose, children, z = 'z-50' }: { labelledBy: string; onClose: () => void; children: React.ReactNode; z?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className={`fixed inset-0 ${z} flex items-start justify-center overflow-y-auto bg-black/40 p-6`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby={labelledBy} className="w-full max-w-xl rounded-lg bg-background p-6 shadow-lg">{children}</div>
    </div>
  );
}

/** Adds a piece of evidence to the repository: a title, document or data, an optional description, and the file. */
export function NewEvidenceDialog({ api, initialTitle = '', onCreated, onClose }: {
  api: EvidenceApi; initialTitle?: string; onCreated: (item: EvidenceItem) => void; onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<EvidenceItem['type']>('document');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!file) { setError('Choose the file.'); return; }
    const f = new FormData(e.currentTarget);
    setBusy(true); setError('');
    try {
      const description = String(f.get('description') ?? '').trim();
      const item = await api.create({ title: String(f.get('title')).trim(), type, ...(description ? { description } : {}) });
      await api.upload(item.id, file);
      onCreated((await api.get(item.id)).item);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal labelledBy="new-evidence-title" onClose={onClose} z="z-[60]">
      <div className="mb-4 flex items-center justify-between">
        <h2 id="new-evidence-title" className="text-xl font-semibold">New evidence</h2>
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
        <label className="flex flex-col text-sm">File<input aria-label="File" type="file" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
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
 * Link evidence to something: search the repository; when it is not there, create it from the search. Once a piece of
 * evidence is chosen, say why it supports this (the justification, required).
 */
export function LinkEvidenceDialog({ api, title, onLink, onClose }: {
  api: EvidenceApi; title: string; onLink: (evidenceVersionId: string, justification: string) => Promise<unknown>; onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const [chosen, setChosen] = useState<EvidenceItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [justification, setJustification] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = useQuery({ queryKey: ['evidence', q], queryFn: () => api.list(q || undefined) });
  const matches = (list.data ?? []).filter((e) => e.latest && e.status === 'active');
  const showResults = focused && !chosen;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!chosen?.latest || !justification.trim()) return;
    setBusy(true); setError('');
    try { await onLink(chosen.latest.id, justification.trim()); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <Modal labelledBy="link-evidence-title" onClose={() => { if (!creating) onClose(); }}>
        <div className="mb-4 flex items-center justify-between">
          <h2 id="link-evidence-title" className="text-xl font-semibold">Link evidence <span className="ms-1 text-base font-normal text-muted-foreground">to {title}</span></h2>
          <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
        </div>
        <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label="Link evidence">
          {chosen ? (
            <div className="flex items-center gap-2 rounded-md border border-border p-2 text-sm" data-testid="chosen-evidence">
              <span className="font-medium">{chosen.title}</span>
              <span className="text-xs text-muted-foreground">v{chosen.latest?.versionNo}{chosen.periodLabel ? ` · ${chosen.periodLabel}` : ''}</span>
              <Button type="button" variant="ghost" className="ms-auto px-2 py-1" onClick={() => { setChosen(null); setJustification(''); }}>Change</Button>
            </div>
          ) : (
            <div className="relative" onFocus={() => setFocused(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false); }}>
              <Input role="combobox" aria-expanded={showResults} aria-controls="evidence-results" aria-label="Search evidence"
                placeholder="Search evidence by title or tag" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
              {showResults && (
                <ul id="evidence-results" role="listbox" aria-label="Matching evidence" className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-background py-1 shadow-lg">
                  {matches.map((ev) => (
                    <li key={ev.id} role="option" aria-selected={false} tabIndex={-1} className="cursor-pointer px-3 py-1.5 text-sm hover:bg-muted"
                      onMouseDown={(e) => e.preventDefault()} onClick={() => setChosen(ev)}>
                      <span className="font-medium">{ev.title}</span> <span className="text-xs text-muted-foreground">v{ev.latest!.versionNo}{ev.periodLabel ? ` · ${ev.periodLabel}` : ''}</span>
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
          )}
          {chosen && (
            <label className="flex flex-col text-sm">Justification
              <textarea aria-label="Justification" required rows={3} dir="auto" autoFocus className="rounded-md border border-border p-2 text-sm"
                placeholder="Why this evidence supports it" value={justification} onChange={(e) => setJustification(e.target.value)} />
            </label>
          )}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !chosen || !justification.trim()}>{busy ? 'Linking…' : 'Link evidence'}</Button>
          </div>
        </form>
      </Modal>
      {creating && <NewEvidenceDialog api={api} initialTitle={q} onClose={() => setCreating(false)} onCreated={(item) => { setCreating(false); setChosen(item); }} />}
    </>
  );
}
