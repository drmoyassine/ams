import { useState } from 'react';
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
const KIND_LABEL = { level: 'Requirement levels', finding: 'Findings', report: 'Reports', general: 'General terms' } as const;
const KIND_OF_SOURCE = { level_label: 'level', finding_code: 'finding', report_template: 'report' } as const;
const SOURCE_LABEL = { level_label: 'Level', finding_code: 'Finding', report_template: 'Report' } as const;

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
        {!term.active && <span className="rounded border border-border px-1.5 text-xs">Inactive</span>}
        {canEdit && <Button type="button" variant="ghost" className="ms-auto px-2 py-1" aria-label={`Edit ${term.labelEn}`} onClick={() => setEditing(!editing)}>Edit</Button>}
      </div>
      {term.definitionEn && <p className="mt-1 text-sm text-muted-foreground"><ContentText>{term.definitionEn}</ContentText></p>}
      {term.definitionAr && <p className="mt-1 text-sm text-muted-foreground"><ContentText>{term.definitionAr}</ContentText></p>}
      {editing && (
        <form className="mt-2 grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); onSave({ labelEn, labelAr: labelAr || null, definitionEn: defEn || null, definitionAr: defAr || null }); setEditing(false); }}>
          <label className="flex flex-col text-xs">Term (English)<Input aria-label="Term (English)" value={labelEn} onChange={(e) => setLabelEn(e.target.value)} required /></label>
          <label className="flex flex-col text-xs">Term (Arabic)<Input aria-label="Term (Arabic)" dir="auto" value={labelAr} onChange={(e) => setLabelAr(e.target.value)} /></label>
          <label className="flex flex-col text-xs">Definition (English)<textarea aria-label="Definition (English)" rows={2} className="rounded-md border border-border p-2 text-sm" value={defEn} onChange={(e) => setDefEn(e.target.value)} /></label>
          <label className="flex flex-col text-xs">Definition (Arabic)<textarea aria-label="Definition (Arabic)" dir="auto" rows={2} className="rounded-md border border-border p-2 text-sm" value={defAr} onChange={(e) => setDefAr(e.target.value)} /></label>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={!labelEn.trim()}>Save</Button>
            <Button type="button" variant="ghost" onClick={() => onSave({ active: !term.active })}>{term.active ? 'Deactivate' : 'Reactivate'}</Button>
          </div>
        </form>
      )}
    </li>
  );
}

/** Settings → Glossary: the institution's own terms, and how each standard's words map onto them (DEC-016). */
export function GlossaryPage({ api: override, settings }: { api?: GlossaryApi; settings?: SettingsApi }) {
  const api = useGlossaryApi(override);
  const qc = useQueryClient();
  const me = useMe(useSettingsApi(settings));
  const canEdit = can(me.data, 'framework:write');
  const glossary = useQuery({ queryKey: ['glossary'], queryFn: () => api.glossary() });
  const external = useQuery({ queryKey: ['external-terms'], queryFn: () => api.externalTerms() });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState<(typeof GLOSSARY_KINDS)[number]>('general');
  const [newLabel, setNewLabel] = useState('');
  const act = useAction(setError);
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['glossary'] }); await qc.invalidateQueries({ queryKey: ['external-terms'] }); };
  const run = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => { setError(null); setMessage(null); return act(fn); }, onSuccess: refresh });
  const terms = glossary.data?.terms ?? [];
  const byKind = (k: string) => terms.filter((t) => t.kind === k);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Glossary</h2>
        <p className="text-sm text-muted-foreground">One shared language inside the institution. Each accreditor's own words stay on its standard and on everything sent to it; here they are mapped onto the institution's terms.</p>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {message && <p role="status" className="text-sm text-emerald-800">{message}</p>}

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">Internal terms</h3>
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
                {GLOSSARY_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <Button type="submit" disabled={!newLabel.trim()}>Add</Button>
          </form>
        )}
        {terms.length === 0 && <p className="text-sm text-muted-foreground">No terms yet.</p>}
        {GLOSSARY_KINDS.filter((k) => byKind(k).length).map((k) => (
          <section key={k} aria-label={KIND_LABEL[k]} className="mb-3">
            <h4 className="text-sm font-medium text-muted-foreground">{KIND_LABEL[k]}</h4>
            <ul className="divide-y divide-border">
              {byKind(k).map((t) => <TermRow key={t.id} term={t} canEdit={canEdit} onSave={(patch) => run.mutate(() => api.updateTerm(t.id, { ...(patch.labelEn !== undefined ? { labelEn: patch.labelEn } : {}), ...('labelAr' in patch ? { labelAr: patch.labelAr ?? null } : {}), ...('definitionEn' in patch ? { definitionEn: patch.definitionEn ?? null } : {}), ...('definitionAr' in patch ? { definitionAr: patch.definitionAr ?? null } : {}), ...(patch.active !== undefined ? { active: patch.active } : {}) }))} />)}
            </ul>
          </section>
        ))}
      </Card>

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">How each standard's words map</h3>
          {canEdit && <Button type="button" variant="ghost" onClick={() => run.mutate(async () => { const r = await api.autoMap(); setMessage(`${r.mapped} term(s) mapped from their structure.`); })}>Map unmapped terms automatically</Button>}
        </div>
        <p className="mb-3 text-sm text-muted-foreground">Suggestions come from where a term sits in the standard (a level that holds other requirements is a group; a finding that needs action is a required action). Nothing you set is overwritten.</p>
        {(external.data ?? []).map((s) => (
          <section key={s.frameworkId} aria-label={`${s.accreditorShortName} ${s.name}`} className="mb-4">
            <h4 className="text-sm font-medium"><ContentText>{s.accreditorShortName} · {s.name}</ContentText> <span className="text-muted-foreground">edition {s.edition}</span></h4>
            <table className="mt-1 w-full text-sm">
              <thead className="text-start text-xs text-muted-foreground"><tr><th className="py-1 text-start">Standard's word</th><th className="text-start">Kind</th><th className="text-start">Internal term</th></tr></thead>
              <tbody>
                {s.terms.map((t) => {
                  const options = terms.filter((x) => x.kind === KIND_OF_SOURCE[t.source] && (x.active || x.id === t.termId));
                  return (
                    <tr key={`${t.source}|${t.externalTerm}`} className="border-t border-border" data-testid="external-term">
                      <td className="py-1"><ContentText>{t.externalTerm}</ContentText> <span className="text-xs text-muted-foreground">{t.detail}</span></td>
                      <td>{SOURCE_LABEL[t.source]}</td>
                      <td>
                        <select aria-label={`${s.accreditorShortName} ${t.externalTerm} maps to`} className={select} disabled={!canEdit} value={t.termId ?? ''}
                          onChange={(e) => { const termId = e.target.value || null; run.mutate(() => api.setAlias({ frameworkId: s.frameworkId, source: t.source, externalTerm: t.externalTerm, termId })); }}>
                          <option value="">Not mapped</option>
                          {options.map((x) => <option key={x.id} value={x.id}>{x.labelEn}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ))}
        {external.data?.length === 0 && <p className="text-sm text-muted-foreground">No standards yet.</p>}
      </Card>
    </div>
  );
}
