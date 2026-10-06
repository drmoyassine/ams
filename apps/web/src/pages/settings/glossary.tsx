import { useState } from 'react';
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

const KIND_LABEL = { block: 'Building blocks', attribute: 'Attributes', level: 'Levels', finding: 'Findings', report: 'Reports', general: 'General terms' } as const;
/** What each group is for, in one line. */
const KIND_HINT = {
  block: 'The parts of your quality system. They are fixed because the system gives each one behaviour; rename and define them, and switch off what you do not use.',
  attribute: 'What every item carries, whatever block it is.',
  level: 'Named by depth: an item\'s level is how far it is indented under Requirements.',
  finding: 'What accreditors find in a review, in your words.',
  report: 'The reports accreditors ask for, in your words.',
  general: 'Defined once, used the same way by everyone.',
} as const;
/** Kinds a person can add to; the others are fixed or come from the framework. */
const ADDABLE = ['finding', 'report', 'general'] as const;

/** A level term is named in the internal quality framework, not here. */
const isLevelTerm = (key: string) => /^level_\d+$/.test(key);

function TermRow({ term, canEdit, canRename = true, onSave }: { term: GlossaryTerm; canEdit: boolean; canRename?: boolean; onSave: (patch: Partial<GlossaryTerm>) => void }) {
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
        {!term.active && <span className="rounded border border-border px-1.5 text-xs">Switched off</span>}
        {canEdit && <Button type="button" variant="ghost" className="ms-auto px-2 py-1" aria-label={`Edit ${term.labelEn}`} onClick={() => setEditing(!editing)}>Edit</Button>}
      </div>
      {term.definitionEn && <p className="mt-1 text-sm text-muted-foreground"><ContentText>{term.definitionEn}</ContentText></p>}
      {term.definitionAr && <p className="mt-1 text-sm text-muted-foreground"><ContentText>{term.definitionAr}</ContentText></p>}
      {editing && (
        <form className="mt-2 grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); onSave({ labelEn, labelAr: labelAr || null, definitionEn: defEn || null, definitionAr: defAr || null }); setEditing(false); }}>
          <label className="flex flex-col text-xs">Term (English)<Input aria-label="Term (English)" value={labelEn} onChange={(e) => setLabelEn(e.target.value)} required disabled={!canRename} title={!canRename ? 'The newest version is not a draft: create a new version to rename levels' : undefined} /></label>
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

/** The level names, top first, and how to change them (the internal framework's newest version must be a draft). */
export type LevelControls = { labels: string[]; editable: boolean; lockedNote?: string; set: (labels: string[]) => Promise<unknown> };

/** How Definitions is laid out: three groups, each a set of cards, one card per kind of term. */
const GROUPS = [
  { title: 'Your quality system', hint: 'What your requirements and your cycle are built from.', kinds: ['block', 'attribute', 'level'] },
  { title: 'Accreditors\' words', hint: 'Your words for what accreditors find and ask for. Each standard\'s Terminology tab maps its own words onto these.', kinds: ['finding', 'report'] },
  { title: 'Other terms', hint: 'Any other word you want everyone to use the same way.', kinds: ['general'] },
] as const;
const ADD_LABEL = { finding: 'Add a finding', report: 'Add a report', general: 'Add a term' } as const;

/** Definitions (DEC-016): everything the institution's quality system is made of, defined once. Shown inside Settings → Internal Quality Framework. */
export function GlossaryPage({ api: override, settings, embedded = false, levels }: { api?: GlossaryApi; settings?: SettingsApi; embedded?: boolean; levels?: LevelControls }) {
  const api = useGlossaryApi(override);
  const qc = useQueryClient();
  const me = useMe(useSettingsApi(settings));
  const canEdit = can(me.data, 'framework:write');
  const glossary = useQuery({ queryKey: ['glossary'], queryFn: () => api.glossary() });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState<(typeof ADDABLE)[number] | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const act = useAction(setError);
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['glossary'] }); await qc.invalidateQueries({ queryKey: ['external-terms'] }); };
  const run = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => { setError(null); setMessage(null); return act(fn); }, onSuccess: refresh });
  const terms = glossary.data?.terms ?? [];
  // Switched-off level terms (the first release's starter levels) are history, not choices.
  const byKind = (k: string) => terms.filter((t) => t.kind === k && (k !== 'level' || t.active));
  const save = (t: GlossaryTerm, patch: Partial<GlossaryTerm>) => run.mutate(async () => {
    const rest = {
      ...('labelAr' in patch ? { labelAr: patch.labelAr ?? null } : {}),
      ...('definitionEn' in patch ? { definitionEn: patch.definitionEn ?? null } : {}),
      ...('definitionAr' in patch ? { definitionAr: patch.definitionAr ?? null } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    };
    if (isLevelTerm(t.key)) {
      // A level's name is the framework's level name: renamed there, and the term follows.
      const i = Number(t.key.slice('level_'.length)) - 1;
      if (levels && patch.labelEn !== undefined && patch.labelEn !== t.labelEn) await levels.set(levels.labels.map((l, j) => (j === i ? patch.labelEn! : l)));
      if (Object.keys(rest).length) await api.updateTerm(t.id, rest);
      return;
    }
    await api.updateTerm(t.id, { ...(patch.labelEn !== undefined ? { labelEn: patch.labelEn } : {}), ...rest });
  });

  const card = (k: (typeof GLOSSARY_KINDS)[number]) => {
    const list = byKind(k);
    const addable = (ADDABLE as readonly string[]).includes(k) ? k as (typeof ADDABLE)[number] : null;
    return (
      <Card key={k}>
        <section aria-label={KIND_LABEL[k]} className="space-y-2">
          <div className="flex items-center gap-2">
            <h4 className="font-semibold">{KIND_LABEL[k]}</h4>
            <span className="rounded-full bg-muted px-2 text-xs text-muted-foreground">{list.length}</span>
            {canEdit && addable && <Button type="button" variant="ghost" className="ms-auto px-2 py-1" onClick={() => { setAdding(adding === addable ? null : addable); setNewLabel(''); }}>{adding === addable ? 'Close' : ADD_LABEL[addable]}</Button>}
          </div>
          <p className="text-xs text-muted-foreground">{KIND_HINT[k]}</p>
          {adding === k && canEdit && (
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (newLabel.trim()) { run.mutate(() => api.createTerm({ kind: addable!, labelEn: newLabel })); setNewLabel(''); setAdding(null); } }}>
              <Input aria-label="New term" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} dir="auto" className="w-64" />
              <Button type="submit" disabled={!newLabel.trim()}>Add</Button>
            </form>
          )}
          {list.length === 0 && <p className="text-sm text-muted-foreground">{k === 'level' ? (embedded ? 'No level names yet.' : <>No level names yet: <Link to="/settings/quality-framework" className="underline">set up your internal quality framework</Link>.</>) : 'None yet.'}</p>}
          <ul className="divide-y divide-border">
            {list.map((t) => <TermRow key={`${t.id}|${t.labelEn}`} term={t} canEdit={canEdit} canRename={!isLevelTerm(t.key) || !!levels?.editable} onSave={(patch) => save(t, patch)} />)}
          </ul>
          {k === 'level' && levels && canEdit && (levels.editable ? (
            <div className="flex flex-wrap gap-2 border-t border-border pt-2">
              <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => run.mutate(() => levels.set([...levels.labels, `Level ${levels.labels.length + 1}`]))}>Add a level</Button>
              {levels.labels.length > 1 && <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => run.mutate(() => levels.set(levels.labels.slice(0, -1)))}>Remove the lowest level</Button>}
            </div>
          ) : levels.lockedNote ? <p className="text-xs text-muted-foreground">{levels.lockedNote}</p> : null)}
        </section>
      </Card>
    );
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        {!embedded && <h2 className="text-lg font-semibold">Definitions</h2>}
        <p className="text-sm text-muted-foreground">Everything your quality system is made of, defined once in one shared language, in English and Arabic.</p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {message && <p role="status" className="text-sm text-emerald-800">{message}</p>}
        {terms.length === 0 && <p className="text-sm text-muted-foreground">No terms yet.</p>}
        {canEdit && terms.length === 0 && <Button type="button" onClick={() => run.mutate(async () => { const r = await api.seedDefaults(); setMessage(`${r.added} starter terms added.`); })}>Add starter terms</Button>}
      </div>
      {terms.length > 0 && GROUPS.map((g) => (
        <div key={g.title} className="space-y-3">
          <div>
            <h3 className="text-base font-semibold">{g.title}</h3>
            <p className="text-sm text-muted-foreground">{g.hint}</p>
          </div>
          <div className="grid gap-4">{g.kinds.map((k) => card(k))}</div>
        </div>
      ))}
    </div>
  );
}
