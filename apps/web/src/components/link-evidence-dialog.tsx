import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CONFIDENTIALITY_LEVELS, EVIDENCE_TYPES, type EvidenceItem } from '@ams/shared';
import type { EvidenceApi } from '../lib/evidence-api';
import { Button } from './ui/button';
import { Input } from './ui/input';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
const TYPE_LABEL = { document: 'Document', dataset: 'Dataset', url: 'Link', minutes: 'Minutes', policy: 'Policy', report: 'Report', other: 'Other' } as const;

/**
 * Link evidence to something, with the reason it supports it. The evidence is chosen from the repository or, when it is
 * not there yet, created on the spot (a file or a link) and then linked.
 */
export function LinkEvidenceDialog({ api, title, onLink, onClose }: {
  api: EvidenceApi; title: string; onLink: (evidenceVersionId: string, rationale: string) => Promise<unknown>; onClose: () => void;
}) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = useQuery({ queryKey: ['evidence', q], queryFn: () => api.list(q || undefined) });
  const usable = (list.data ?? []).filter((e) => e.latest && e.status === 'active');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!rationale.trim()) return;
    setBusy(true); setError('');
    try {
      let versionId = chosen;
      if (mode === 'new') {
        const f = new FormData(e.currentTarget);
        const url = String(f.get('url') ?? '').trim();
        if (!file && !url) throw new Error('Choose a file or give a link.');
        const period = String(f.get('period') ?? '').trim();
        const item = await api.create({
          title: String(f.get('newTitle')), type: String(f.get('type')) as EvidenceItem['type'],
          confidentiality: String(f.get('confidentiality')) as EvidenceItem['confidentiality'],
          ...(period ? { periodLabel: period } : {}), ...(!file && url ? { url } : {}),
        });
        versionId = file ? (await api.upload(item.id, file)).id : (await api.get(item.id)).versions[0]!.id;
      }
      if (!versionId) throw new Error('Choose the evidence to link.');
      await onLink(versionId, rationale.trim());
      onClose();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="link-evidence-title" className="w-full max-w-xl rounded-lg bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="link-evidence-title" className="text-xl font-semibold">Link evidence <span className="ms-1 text-base font-normal text-muted-foreground">to {title}</span></h2>
          <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
        </div>
        <div role="radiogroup" aria-label="Evidence" className="mb-3 flex gap-4 text-sm">
          <label className="flex items-center gap-1"><input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} /> From the evidence repository</label>
          <label className="flex items-center gap-1"><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> New evidence</label>
        </div>
        <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label="Link evidence">
          {mode === 'existing' ? (
            <div className="space-y-2">
              <Input aria-label="Search evidence" placeholder="Search by title or tag" value={q} onChange={(e) => setQ(e.target.value)} />
              <select aria-label="Evidence" size={Math.min(6, Math.max(2, usable.length))} className={`${select} w-full`} value={chosen} onChange={(e) => setChosen(e.target.value)}>
                {usable.map((ev) => <option key={ev.id} value={ev.latest!.id}>{ev.title} (v{ev.latest!.versionNo}{ev.periodLabel ? `, ${ev.periodLabel}` : ''})</option>)}
              </select>
              {list.data && usable.length === 0 && <p className="text-xs text-muted-foreground">Nothing found. Choose "New evidence" to add it.</p>}
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col text-sm sm:col-span-2">Title<Input name="newTitle" aria-label="New evidence title" required dir="auto" /></label>
              <label className="flex flex-col text-sm">Type<select name="type" aria-label="Type" className={select} defaultValue="document">{EVIDENCE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></label>
              <label className="flex flex-col text-sm">Period<Input name="period" aria-label="Period" placeholder="e.g. AY2025-26" /></label>
              <label className="flex flex-col text-sm">Confidentiality<select name="confidentiality" aria-label="Confidentiality" className={select} defaultValue="internal">{CONFIDENTIALITY_LEVELS.map((c) => <option key={c} value={c}>{c[0]!.toUpperCase() + c.slice(1)}</option>)}</select></label>
              <label className="flex flex-col text-sm">File<input aria-label="File" type="file" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
              <label className="flex flex-col text-sm sm:col-span-2">or a link to it<Input name="url" aria-label="Link" type="url" placeholder="https://…" /></label>
            </div>
          )}
          <label className="flex flex-col text-sm">Why it supports this
            <textarea aria-label="Why it supports this" required rows={2} dir="auto" className="rounded-md border border-border p-2 text-sm" value={rationale} onChange={(e) => setRationale(e.target.value)} />
          </label>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !rationale.trim() || (mode === 'existing' && !chosen)}>{busy ? 'Linking…' : 'Link evidence'}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
