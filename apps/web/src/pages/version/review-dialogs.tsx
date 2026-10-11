import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ContentText } from '../../components/content-text';
import { Dialog } from '../../components/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { distinctTitle } from '../../lib/format';
import type { FrameworkApi, Requirement } from '../../lib/framework-api';
import { descendantIds } from './needs-look';

/** The tag a requirement is known by: its code, with the level in front when the code alone is only a number. */
export const tagOf = (r: Requirement) => (/[\p{L}]/u.test(r.code) ? r.code : `${r.levelLabel} ${r.code}`);
export const nameOf = (r: Requirement) => [tagOf(r), distinctTitle(r.code, r.title)].filter(Boolean).join(' · ');

const MAX_SHOWN = 40;

/** Searchable list of requirements to pick one from, by code or title (Arabic and English; case and diacritics do not matter). */
function RequirementPicker({ rows, value, onChange, topLevel = false, label }: {
  rows: Requirement[]; value: string | null; onChange: (id: string | null) => void; topLevel?: boolean; label: string;
}) {
  const [q, setQ] = useState('');
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const found = useMemo(() => {
    const needle = fold(q.trim());
    return rows.filter((r) => !needle || fold(`${r.code} ${r.title}`).includes(needle));
  }, [rows, q]);
  return (
    <div className="space-y-2">
      <Input aria-label={label} type="search" placeholder="Search by code or title" value={q} onChange={(e) => setQ(e.target.value)} dir="auto" autoFocus />
      <ul role="listbox" aria-label="Requirements" className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
        {topLevel && (
          <li role="option" aria-selected={value === null}>
            <button type="button" onClick={() => onChange(null)} className={`block w-full px-3 py-2 text-start text-sm hover:bg-muted ${value === null ? 'bg-muted font-medium' : ''}`}>Top level</button>
          </li>
        )}
        {found.slice(0, MAX_SHOWN).map((r) => (
          <li key={r.id} role="option" aria-selected={value === r.id}>
            <button type="button" onClick={() => onChange(r.id)} style={{ paddingInlineStart: `${0.75 + Math.min(r.depth ?? 0, 4) * 0.75}rem` }}
              className={`block w-full py-2 pe-3 text-start text-sm hover:bg-muted ${value === r.id ? 'bg-muted font-medium' : ''}`}>
              <ContentText>{nameOf(r)}</ContentText>
            </button>
          </li>
        ))}
        {found.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No requirement matches.</li>}
      </ul>
      {found.length > MAX_SHOWN && <p className="text-xs text-muted-foreground">{found.length - MAX_SHOWN} more: type more of the code or title to narrow the list.</p>}
    </div>
  );
}

function Shell({ id, title, onClose, children }: { id: string; title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Dialog labelledBy={id} onClose={onClose}>
      <div className="mb-4 flex items-start justify-between gap-2">
        <h2 id={id} className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">{title}</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      {children}
    </Dialog>
  );
}

/** Merge a requirement into another: its notes and items move there; the target keeps its wording unless asked. */
export function MergeDialog({ api, item, rows, error, onMerge, onClose }: {
  api: FrameworkApi; item: Requirement; rows: Requirement[]; error: string;
  onMerge: (intoId: string, useMergedWording: boolean) => Promise<unknown>; onClose: () => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [useMine, setUseMine] = useState(false);
  const [busy, setBusy] = useState(false);
  const inside = useMemo(() => descendantIds(rows, item.id), [rows, item.id]);
  const candidates = rows.filter((r) => r.id !== item.id && !inside.has(r.id));
  const detail = useQuery({ queryKey: ['requirement', item.id], queryFn: () => api.requirement(item.id) });
  const kids = rows.filter((r) => r.parentId === item.id).length;
  const notes = detail.data?.notes.length;
  const into = candidates.find((r) => r.id === target);
  return (
    <Shell id="merge-title" title={`Merge ${tagOf(item)} into another requirement`} onClose={onClose}>
      <form className="space-y-3" aria-label="Merge requirement" onSubmit={(e: FormEvent) => { e.preventDefault(); if (!target) return; setBusy(true); void onMerge(target, useMine).finally(() => setBusy(false)); }}>
        <p className="text-sm text-muted-foreground">
          <ContentText>{nameOf(item)}</ContentText> is removed. Its {notes === undefined ? 'notes' : `${notes} note${notes === 1 ? '' : 's'}`} and {kids} item{kids === 1 ? '' : 's'} move to the requirement you choose, which keeps its own wording.
        </p>
        <RequirementPicker rows={candidates} value={target} onChange={setTarget} label="Search the requirement to merge into" />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={useMine} onChange={(e) => setUseMine(e.target.checked)} className="mt-1" />
          <span>Use this requirement's title, wording and source instead of the target's</span>
        </label>
        {into && <p className="text-sm" data-testid="merge-summary">Merge <b><ContentText>{tagOf(item)}</ContentText></b> into <b><ContentText>{tagOf(into)}</ContentText></b>.</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <p className="text-xs text-muted-foreground">The change is part of this draft and is kept in the audit trail. A new analysis leaves the merged requirement alone.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!target || busy}>Merge</Button>
        </div>
      </form>
    </Shell>
  );
}

/** Move a requirement under another one (or to the top level). */
export function MoveDialog({ item, rows, error, onMove, onClose }: {
  item: Requirement; rows: Requirement[]; error: string; onMove: (parentId: string | null) => Promise<unknown>; onClose: () => void;
}) {
  const [parent, setParent] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const inside = useMemo(() => descendantIds(rows, item.id), [rows, item.id]);
  const candidates = rows.filter((r) => r.id !== item.id && !inside.has(r.id));
  return (
    <Shell id="move-title" title={`Move ${tagOf(item)}`} onClose={onClose}>
      <form className="space-y-3" aria-label="Move requirement" onSubmit={(e: FormEvent) => { e.preventDefault(); if (parent === undefined) return; setBusy(true); void onMove(parent).finally(() => setBusy(false)); }}>
        <p className="text-sm text-muted-foreground">Choose where <ContentText>{nameOf(item)}</ContentText> goes. Its notes and items go with it.</p>
        <RequirementPicker rows={candidates} value={parent ?? null} onChange={setParent} topLevel label="Search the new parent" />
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={parent === undefined || busy}>Move</Button>
        </div>
      </form>
    </Shell>
  );
}

/**
 * Split a requirement: select the part of its text that becomes a requirement of its own (or paste/type it), and give that
 * one a code. The text is shown in a read-only text box, so the selection works with a mouse, the keyboard and touch alike.
 */
export function SplitDialog({ item, error, onSplit, onClose }: {
  item: Requirement; error: string; onSplit: (v: { part: string; code: string; title: string }) => Promise<unknown>; onClose: () => void;
}) {
  const text = item.officialText ?? '';
  const [part, setPart] = useState('');
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const take = () => {
    const el = box.current;
    if (!el) return;
    const picked = el.value.slice(el.selectionStart, el.selectionEnd);
    if (picked.trim()) setPart(picked.trim());
  };
  const trimmed = part.trim();
  const found = trimmed.length > 0 && text.includes(trimmed);
  const whole = found && trimmed === text.trim();
  const rest = found && !whole ? `${text.slice(0, text.indexOf(trimmed))} ${text.slice(text.indexOf(trimmed) + trimmed.length)}`.replace(/\s{2,}/g, ' ').trim() : '';
  const ok = found && !whole && code.trim().length > 0;
  return (
    <Shell id="split-title" title={`Split ${tagOf(item)}`} onClose={onClose}>
      {!text.trim() ? (
        <div className="space-y-3">
          <p className="text-sm">This requirement has no description to split. Add its wording first.</p>
          <div className="flex justify-end"><Button type="button" onClick={onClose}>Close</Button></div>
        </div>
      ) : (
        <form className="space-y-3" aria-label="Split requirement" onSubmit={(e: FormEvent) => { e.preventDefault(); if (!ok) return; setBusy(true); void onSplit({ part: trimmed, code: code.trim(), title: title.trim() }).finally(() => setBusy(false)); }}>
          <label className="flex flex-col text-sm">Description of <ContentText>{tagOf(item)}</ContentText>: select the part to move out
            <textarea ref={box} aria-label="Description" readOnly rows={6} dir="auto" value={text} onSelect={take} onMouseUp={take} onKeyUp={take} onTouchEnd={take}
              className="mt-1 rounded-md border border-border bg-muted/30 p-2 text-sm" />
          </label>
          <label className="flex flex-col text-sm">Part to move out (select it above, or paste it here)
            <textarea aria-label="Part to move out" rows={3} dir="auto" value={part} onChange={(e) => setPart(e.target.value)} className="mt-1 rounded-md border border-border p-2 text-sm" />
          </label>
          {trimmed && !found && <p role="alert" className="text-sm text-red-700">That text is not in the description above. It has to be copied from it.</p>}
          {whole && <p role="alert" className="text-sm text-red-700">That is the whole description. Select only part of it, so some stays here.</p>}
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <label className="flex flex-col text-sm">New code<Input aria-label="New code" value={code} onChange={(e) => setCode(e.target.value)} dir="auto" required /></label>
            <label className="flex flex-col text-sm">New title (optional)<Input aria-label="New title" value={title} onChange={(e) => setTitle(e.target.value)} dir="auto" placeholder="Defaults to the code" /></label>
          </div>
          {found && !whole && (
            <div className="grid gap-2 text-sm sm:grid-cols-2" data-testid="split-preview">
              <div className="rounded-md border border-border p-2"><p className="mb-1 text-xs font-medium text-muted-foreground">Stays in {tagOf(item)}</p><p className="whitespace-pre-line" dir="auto">{rest}</p></div>
              <div className="rounded-md border border-border p-2"><p className="mb-1 text-xs font-medium text-muted-foreground">Becomes {code.trim() || 'the new requirement'}</p><p className="whitespace-pre-line" dir="auto">{trimmed}</p></div>
            </div>
          )}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <p className="text-xs text-muted-foreground">Both keep the same source. The new requirement is checked against the source page on its own text; if it is not found there, it says so.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!ok || busy}>Split</Button>
          </div>
        </form>
      )}
    </Shell>
  );
}
