import { useMemo, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ContentText } from '../../components/content-text';
import { Dialog } from '../../components/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { requirementLabel } from '../../lib/format';
import type { FrameworkApi, Mapping, Mappings, Requirement, Version } from '../../lib/framework-api';

export const RELATIONS = { covers: 'Covers', partly_covers: 'Partly covers', related: 'Related' } as const;
type Option = Mappings['internalOptions'][number];

/** Case, composition and Arabic marks do not matter when searching ("NFC", no tashkeel). */
const fold = (s: string) => s.normalize('NFC').replace(/[ً-ٰٟـ]/g, '').toLowerCase();

/**
 * Maps one requirement of an external standard (at any level) onto items of the institution's quality framework: search the
 * published IQF, tick the items that answer it, say for each how much it does (covers, partly covers, related) and, if you
 * like, why (the mapping's commentary). The links are proposed; a reviewer approves them, and only approved links pass the
 * IQF item's evidence on to the requirement. They belong to the institution (keyed by code), so they stay when the standard
 * gets a new version.
 */
export function MapToIqfDialog({ api, version, requirement, onSaved, onClose }: {
  api: FrameworkApi; version: Version; requirement: Requirement; onSaved: () => void | Promise<unknown>; onClose: () => void;
}) {
  const maps = useQuery({ queryKey: ['mappings', version.id], queryFn: () => api.mappings(version.id) });
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<Option[]>([]);
  const [relations, setRelations] = useState<Record<string, Mapping['relation']>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options = maps.data?.internalOptions ?? [];
  const mapped = useMemo(() => new Set((maps.data?.mappings ?? []).filter((m) => m.externalCode === requirement.code).map((m) => m.internalCode)), [maps.data, requirement.code]);
  const needle = fold(q.trim());
  const shown = useMemo(() => (needle ? options.filter((o) => fold(`${o.code} ${o.title}`).includes(needle)) : options), [options, needle]);
  const picked = new Set(chosen.map((c) => c.id));
  const toggle = (o: Option) => setChosen((c) => (c.some((x) => x.id === o.id) ? c.filter((x) => x.id !== o.id) : [...c, o]));

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!chosen.length) return;
    setBusy(true); setError('');
    const done: string[] = [];
    try {
      for (const o of chosen) {
        const why = (notes[o.id] ?? '').trim();
        await api.createMapping(version.id, { externalRequirementId: requirement.id, internalRequirementId: o.id, relation: relations[o.id] ?? 'covers', ...(why ? { rationale: why } : {}) });
        done.push(o.id);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setChosen((cs) => cs.filter((c) => !done.includes(c.id)));
      if (done.length) await onSaved();
      setError(done.length ? `${done.length} proposed; the rest were not: ${(err as Error).message}` : (err as Error).message);
    } finally { setBusy(false); }
  };

  const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
  return (
    <Dialog labelledBy="map-iqf-title" onClose={onClose}>
      <div className="mb-4 flex items-start justify-between gap-2">
        <h2 id="map-iqf-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">
          Map to IQF <span className="ms-1 text-base font-normal text-muted-foreground"><ContentText>{`: ${requirementLabel(requirement.code, requirement.title)}`}</ContentText></span>
        </h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      {maps.isError && <p role="alert" className="text-sm text-red-700">The quality framework could not be loaded.</p>}
      {!maps.data && !maps.isError && <p className="text-sm text-muted-foreground">Loading…</p>}
      {maps.data && options.length === 0 && (
        <p className="text-sm text-muted-foreground">
          There is no quality framework to map onto yet. <Link to="/settings/quality-framework" className="underline">Set up your internal quality framework</Link> in Settings and add its standards first.
        </p>
      )}
      {maps.data && options.length > 0 && (
        <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label="Map to IQF">
          <label className="flex flex-col text-sm">Search the quality framework
            <Input aria-label="Search IQF items" type="search" placeholder="Code or title" value={q} onChange={(e) => setQ(e.target.value)} dir="auto" autoFocus />
          </label>
          <ul role="group" aria-label="IQF items" className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-border p-1">
            {shown.map((o) => {
              const already = mapped.has(o.code);
              return (
                <li key={o.id} style={{ paddingInlineStart: `${o.depth * 1.25}rem` }}>
                  <label className={`flex items-start gap-2 rounded px-2 py-1 text-sm ${already ? 'text-muted-foreground' : 'cursor-pointer hover:bg-muted'}`}>
                    <input type="checkbox" className="mt-1" disabled={already} checked={picked.has(o.id)} onChange={() => toggle(o)} aria-label={requirementLabel(o.code, o.title)} />
                    <span className="min-w-0 break-words"><ContentText>{requirementLabel(o.code, o.title)}</ContentText>{already && <span className="ms-2 text-xs">(already mapped)</span>}</span>
                  </label>
                </li>
              );
            })}
            {shown.length === 0 && <li className="px-2 py-1 text-sm text-muted-foreground">{`No IQF item matches "${q}".`}</li>}
          </ul>
          {chosen.length > 0 && (
            <ul className="space-y-3" aria-label="Chosen IQF items">
              {chosen.map((o) => (
                <li key={o.id} className="space-y-1 rounded-md border border-border p-2" data-testid="chosen-iqf">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="min-w-0 break-words font-medium"><ContentText>{requirementLabel(o.code, o.title)}</ContentText></span>
                    <select aria-label={`Relation to ${o.code}`} className={`${select} ms-auto`} value={relations[o.id] ?? 'covers'}
                      onChange={(e) => setRelations((r) => ({ ...r, [o.id]: e.target.value as Mapping['relation'] }))}>
                      {Object.entries(RELATIONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                    <Button type="button" variant="ghost" className="px-2 py-1" aria-label={`Remove ${o.code}`} onClick={() => toggle(o)}>Remove</Button>
                  </div>
                  <label className="flex flex-col text-sm">Commentary (optional)
                    <textarea aria-label={`Commentary for ${o.code}`} rows={2} dir="auto" className="rounded-md border border-border p-2 text-sm"
                      value={notes[o.id] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [o.id]: e.target.value }))} />
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">The links are proposed and reviewed before they count; once approved, the evidence on an IQF item also counts for this requirement. They stay when the standard gets a new version.</p>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || chosen.length === 0}>{busy ? 'Proposing…' : chosen.length > 1 ? `Propose ${chosen.length} mappings` : 'Propose mapping'}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
