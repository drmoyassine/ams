import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GLOSSARY_KINDS, type GlossaryTerm } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useGlossaryApi, type GlossaryApi } from '../../lib/glossary-api';
import { can, useMe } from '../../lib/me';
import { useAction } from '../../lib/use-action';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
const KIND_LABEL = { block: 'Building blocks', attribute: 'Attributes', level: 'Levels', finding: 'Findings', report: 'Reports', general: 'Other terms' } as const;
/** What each group is for, in one line. */
const KIND_HINT = {
  block: 'The parts of your quality system. They are fixed because the system gives each one behaviour; rename and define them, and switch off what you do not use.',
  attribute: 'What every item carries, whatever block it is.',
  level: 'Named by depth: an item\'s level is how far it is indented under Requirements.',
  finding: 'Your words for what accreditors find. Each standard\'s Terminology tab maps its own finding names onto these.',
  report: 'Your words for the reports accreditors ask for. Each standard\'s Terminology tab maps its report types onto these.',
  general: 'Any other word you want defined the same way for everyone.',
} as const;
/** Kinds a person can add to; the others are fixed or come from the framework. */
const ADDABLE = ['finding', 'report', 'general'] as const;

/** A level term is named in the internal quality framework, not here. */
const isLevelTerm = (key: string) => /^level_\d+$/.test(key);

function TermRow({ term, canEdit, onSave }: { term: GlossaryTerm; canEdit: boolean; onSave: (patch: Partial<GlossaryTerm>) => void }) {
  const [editing, setEditing] = useState(false);
  const [labelEn, setLabelEn] = useState(term.labelEn);
  const [labelAr, setLabelAr] = useState(term.labelAr ?? '');
  const [defEn, setDefEn] = useState(term.definitionEn ?? '');
  const [defAr, setDefAr] = useState(term.definitionAr ?? '');
  return (
    <li className={`py-3 ${term.active ? '' : 'opacity-60'}`} data-testid="term">
      <div className="flex flex-wrap items-baseline gap-2">
        <ContentText className="font-medium">{term.labelEn}</ContentText>
        {term.labelAr && <ContentText className="text-sm text-muted-foreground">{term.labelAr}</ContentText>}
        <code className="text-xs text-muted-foreground">{term.key}</code>
        {!term.active && <span className="rounded border border-border px-1.5 text-xs">Switched off</span>}
        {canEdit && <Button type="button" variant="ghost" className="ms-auto px-2 py-1" aria-label={`Edit ${term.labelEn}`} onClick={() => setEditing(!editing)}>Edit</Button>}
      </div>
      {term.definitionEn && <p className="mt-1 text-sm text-muted-foreground"><ContentText>{term.definitionEn}</ContentText></p>}
      {term.definitionAr && <p className="mt-1 text-sm text-muted-foreground"><ContentText>{term.definitionAr}</ContentText></p>}
      {editing && (
        <form className="mt-2 grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); onSave({ labelEn, labelAr: labelAr || null, definitionEn: defEn || null, definitionAr: defAr || null }); setEditing(false); }}>
          <label className="flex flex-col text-xs">Term (English)<Input aria-label="Term (English)" value={labelEn} onChange={(e) => setLabelEn(e.target.value)} required disabled={isLevelTerm(term.key)} title={isLevelTerm(term.key) ? 'Named in Settings → Internal Quality Framework' : undefined} /></label>
          <label className="flex flex-col text-xs">Term (Arabic)<Input aria-label="Term (Arabic)" dir="auto" value={labelAr} onChange={(e) => setLabelAr(e.target.value)} /></label>
          <label className="flex flex-col text-xs">Definition (English)<textarea aria-label="Definition (English)" rows={2} className="rounded-md border border-border p-2 text-sm" value={defEn} onChange={(e) => setDefEn(e.target.value)} /></label>
          <label className="flex flex-col text-xs">Definition (Arabic)<textarea aria-label="Definition (Arabic)" dir="auto" rows={2} className="rounded-md border border-border p-2 text-sm" value={defAr} onChange={(e) => setDefAr(e.target.value)} /></label>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={!labelEn.trim()}>Save</Button>
            {!isLevelTerm(term.key) && term.kind !== 'attribute' && <Button type="button" variant="ghost" onClick={() => onSave({ active: !term.active })}>{term.active ? 'Switch off' : 'Switch on'}</Button>}
          </div>
        </form>
      )}
    </li>
  );
}

/** The institution's own terms (DEC-016): shown inside Settings → Internal Quality Framework. Each standard's Terminology tab maps its words onto them. */
export function GlossaryPage({ api: override, settings, embedded = false, levelsEditor }: { api?: GlossaryApi; settings?: SettingsApi; embedded?: boolean; levelsEditor?: ReactNode }) {
  const api = useGlossaryApi(override);
  const qc = useQueryClient();
  const me = useMe(useSettingsApi(settings));
  const canEdit = can(me.data, 'framework:write');
  const glossary = useQuery({ queryKey: ['glossary'], queryFn: () => api.glossary() });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState<(typeof ADDABLE)[number]>('general');
  const [newLabel, setNewLabel] = useState('');
  const act = useAction(setError);
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['glossary'] }); await qc.invalidateQueries({ queryKey: ['external-terms'] }); };
  const run = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => { setError(null); setMessage(null); return act(fn); }, onSuccess: refresh });
  const terms = glossary.data?.terms ?? [];
  // Switched-off level terms (the first release's starter levels) are history, not choices.
  const byKind = (k: string) => terms.filter((t) => t.kind === k && (k !== 'level' || t.active));

  return (
    <div className="space-y-6">
      <div>
        {!embedded && <h2 className="text-lg font-semibold">Definitions</h2>}
        <p className="text-sm text-muted-foreground">Everything your quality system is made of, defined once in one shared language. Requirements and the cycle are built from these; accreditors' own words are mapped onto them on each standard's Terminology tab.</p>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {message && <p role="status" className="text-sm text-emerald-800">{message}</p>}

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">Definitions</h3>
          {canEdit && (
            <div className="flex gap-2">
              {terms.length === 0 && <Button type="button" onClick={() => run.mutate(async () => { const r = await api.seedDefaults(); setMessage(`${r.added} starter terms added.`); })}>Add starter terms</Button>}
              <Button type="button" variant="ghost" onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add term'}</Button>
            </div>
          )}
        </div>
        {adding && canEdit && (
          <form className="mb-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (newLabel.trim()) { run.mutate(() => api.createTerm({ kind: newKind, labelEn: newLabel })); setNewLabel(''); setAdding(false); } }}>
            <label className="flex flex-col text-xs">Term<Input aria-label="New term" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} /></label>
            <label className="flex flex-col text-xs">Kind
              <select aria-label="New term kind" className={select} value={newKind} onChange={(e) => setNewKind(e.target.value as typeof newKind)}>
                {ADDABLE.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <Button type="submit" disabled={!newLabel.trim()}>Add</Button>
          </form>
        )}
        {terms.length === 0 && <p className="text-sm text-muted-foreground">No terms yet.</p>}
        {terms.length > 0 && byKind('level').length === 0 && <p className="text-sm text-muted-foreground">No level names yet: {embedded ? 'set up the framework and its levels appear here.' : <><Link to="/settings/quality-framework" className="underline">set up your internal quality framework</Link> and its levels appear here.</>}</p>}
        {GLOSSARY_KINDS.filter((k) => byKind(k).length).map((k) => (
          <section key={k} aria-label={KIND_LABEL[k]} className="mb-3">
            <h4 className="text-sm font-medium">{KIND_LABEL[k]}</h4>
            <p className="text-xs text-muted-foreground">{KIND_HINT[k]}</p>
            {k === 'level' && levelsEditor}
            <ul className="divide-y divide-border">
              {byKind(k).map((t) => <TermRow key={t.id} term={t} canEdit={canEdit} onSave={(patch) => run.mutate(() => api.updateTerm(t.id, { ...(patch.labelEn !== undefined ? { labelEn: patch.labelEn } : {}), ...('labelAr' in patch ? { labelAr: patch.labelAr ?? null } : {}), ...('definitionEn' in patch ? { definitionEn: patch.definitionEn ?? null } : {}), ...('definitionAr' in patch ? { definitionAr: patch.definitionAr ?? null } : {}), ...(patch.active !== undefined ? { active: patch.active } : {}) }))} />)}
            </ul>
          </section>
        ))}
      </Card>
    </div>
  );
}
