import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GlossaryTerm } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { ReadOnlyNote } from '../../components/read-only-note';
import { useGlossaryApi, type GlossaryApi } from '../../lib/glossary-api';
import { can, useMe } from '../../lib/me';
import { useAction } from '../../lib/use-action';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';

/** The kinds of term shown here. Level names live with the framework tree, so they are not listed. */
const KINDS = [
  { kind: 'finding', label: 'Findings', hint: 'What accreditors find in a review, in your words.', add: 'Add a finding' },
  { kind: 'report', label: 'Reports', hint: 'The reports accreditors ask for, in your words.', add: 'Add a report' },
  { kind: 'general', label: 'General terms', hint: 'Any other word you want everyone to use the same way.', add: 'Add a term' },
] as const;

function TermRow({ term, canEdit, onSave }: { term: GlossaryTerm; canEdit: boolean; onSave: (patch: Partial<GlossaryTerm>) => void }) {
  const [editing, setEditing] = useState(false);
  const [labelEn, setLabelEn] = useState(term.labelEn);
  const [labelAr, setLabelAr] = useState(term.labelAr ?? '');
  const [defEn, setDefEn] = useState(term.definitionEn ?? '');
  const [defAr, setDefAr] = useState(term.definitionAr ?? '');
  return (
    <li className={`py-2 ${term.active ? '' : 'opacity-60'}`} data-testid="term">
      <div className="flex flex-wrap items-baseline gap-2">
        <ContentText className="font-medium">{term.labelEn}</ContentText>
        {term.labelAr && <ContentText className="text-sm text-muted-foreground">{term.labelAr}</ContentText>}
        {!term.active && <span className="rounded border border-border px-1.5 text-xs">Switched off</span>}
        {canEdit && <Button type="button" variant="ghost" className="ms-auto px-2 py-1" aria-label={`Edit ${term.labelEn}`} onClick={() => setEditing(!editing)}>Edit</Button>}
      </div>
      {term.definitionEn && <p className="text-sm text-muted-foreground"><ContentText>{term.definitionEn}</ContentText></p>}
      {term.definitionAr && <p className="text-sm text-muted-foreground"><ContentText>{term.definitionAr}</ContentText></p>}
      {editing && (
        <form className="mt-2 grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); onSave({ labelEn, labelAr: labelAr || null, definitionEn: defEn || null, definitionAr: defAr || null }); setEditing(false); }}>
          <label className="flex flex-col text-xs">Term (English)<Input aria-label="Term (English)" value={labelEn} onChange={(e) => setLabelEn(e.target.value)} required /></label>
          <label className="flex flex-col text-xs">Term (Arabic)<Input aria-label="Term (Arabic)" dir="auto" value={labelAr} onChange={(e) => setLabelAr(e.target.value)} /></label>
          <label className="flex flex-col text-xs">Definition (English)<textarea aria-label="Definition (English)" rows={2} className="rounded-md border border-border p-2 text-sm" value={defEn} onChange={(e) => setDefEn(e.target.value)} /></label>
          <label className="flex flex-col text-xs">Definition (Arabic)<textarea aria-label="Definition (Arabic)" dir="auto" rows={2} className="rounded-md border border-border p-2 text-sm" value={defAr} onChange={(e) => setDefAr(e.target.value)} /></label>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={!labelEn.trim()}>Save</Button>
            <Button type="button" variant="ghost" onClick={() => onSave({ active: !term.active })}>{term.active ? 'Switch off' : 'Switch on'}</Button>
          </div>
        </form>
      )}
    </li>
  );
}

/**
 * Terms (DEC-016): the institution's words for what accreditors find and ask for, and any other shared word. Each
 * external standard's Settings → Terminology maps that standard's own words onto these. Shown inside Settings → Internal Quality Framework.
 */
export function GlossaryPage({ api: override, settings, embedded = false }: { api?: GlossaryApi; settings?: SettingsApi; embedded?: boolean }) {
  const api = useGlossaryApi(override);
  const qc = useQueryClient();
  const me = useMe(useSettingsApi(settings));
  const canEdit = can(me.data, 'framework:write');
  const glossary = useQuery({ queryKey: ['glossary'], queryFn: () => api.glossary() });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const act = useAction(setError);
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['glossary'] }); await qc.invalidateQueries({ queryKey: ['external-terms'] }); };
  const run = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => { setError(null); setMessage(null); return act(fn); }, onSuccess: refresh });
  const terms = (glossary.data?.terms ?? []).filter((t) => t.kind !== 'level');

  return (
    <div className="space-y-4">
      {!embedded && <h2 className="text-lg font-semibold">Terms</h2>}
      <p className="text-sm text-muted-foreground">Your words for what accreditors find and ask for. Each external standard's Settings → Terminology maps its own words onto these, so everyone inside uses one language.</p>
      <ReadOnlyNote show={!embedded && !!me.data && !canEdit} />
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {message && <p role="status" className="text-sm text-emerald-800">{message}</p>}
      {terms.length === 0 && <p className="text-sm text-muted-foreground">No terms yet.</p>}
      {canEdit && terms.length === 0 && <Button type="button" onClick={() => run.mutate(async () => { const r = await api.seedDefaults(); setMessage(`${r.added} starter terms added.`); })}>Add starter terms</Button>}
      {terms.length > 0 && (
        <Card>
          <div className="divide-y divide-border">
            {KINDS.map(({ kind, label, hint, add }) => {
              const list = terms.filter((t) => t.kind === kind);
              return (
                <section key={kind} aria-label={label} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-baseline gap-2">
                    <h3 className="font-semibold">{label}</h3>
                    <span className="text-xs text-muted-foreground">{hint}</span>
                    {canEdit && <Button type="button" variant="ghost" className="ms-auto px-2 py-1" onClick={() => { setAdding(adding === kind ? null : kind); setNewLabel(''); }}>{adding === kind ? 'Close' : add}</Button>}
                  </div>
                  {adding === kind && canEdit && (
                    <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (newLabel.trim()) { run.mutate(() => api.createTerm({ kind, labelEn: newLabel })); setNewLabel(''); setAdding(null); } }}>
                      <Input aria-label="New term" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} dir="auto" className="w-64" />
                      <Button type="submit" disabled={!newLabel.trim()}>Add</Button>
                    </form>
                  )}
                  <ul className="divide-y divide-border">
                    {list.map((t) => (
                      <TermRow key={`${t.id}|${t.labelEn}`} term={t} canEdit={canEdit} onSave={(patch) => run.mutate(() => api.updateTerm(t.id, {
                        ...(patch.labelEn !== undefined ? { labelEn: patch.labelEn } : {}),
                        ...('labelAr' in patch ? { labelAr: patch.labelAr ?? null } : {}),
                        ...('definitionEn' in patch ? { definitionEn: patch.definitionEn ?? null } : {}),
                        ...('definitionAr' in patch ? { definitionAr: patch.definitionAr ?? null } : {}),
                        ...(patch.active !== undefined ? { active: patch.active } : {}),
                      }))} />
                    ))}
                    {list.length === 0 && <li className="py-2 text-sm text-muted-foreground">None yet.</li>}
                  </ul>
                </section>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
