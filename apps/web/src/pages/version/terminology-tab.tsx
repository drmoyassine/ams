import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import type { Version } from '../../lib/framework-api';
import { useGlossaryApi, type GlossaryApi } from '../../lib/glossary-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
const KIND_OF_SOURCE = { level_label: 'level', finding_code: 'finding', report_template: 'report' } as const;
const SOURCE_LABEL = { level_label: 'Level', finding_code: 'Finding', report_template: 'Report' } as const;

/**
 * How this standard's own words (level names, finding names, report types) map onto the institution's glossary terms
 * (DEC-016). It belongs to the standard, not to global Settings; the terms themselves are edited in Settings → Internal Quality Framework.
 */
export function TerminologyTab({ version, me, glossary: override }: { version: Version; me: Me | undefined; glossary?: GlossaryApi }) {
  const api = useGlossaryApi(override);
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const glossary = useQuery({ queryKey: ['glossary'], queryFn: () => api.glossary() });
  const external = useQuery({ queryKey: ['external-terms'], queryFn: () => api.externalTerms() });
  const act = useAction(setError);
  const run = async (fn: () => Promise<unknown>) => {
    setError(''); setMessage('');
    await act(fn);
    await qc.invalidateQueries({ queryKey: ['glossary'] });
    await qc.invalidateQueries({ queryKey: ['external-terms'] });
  };
  const canEdit = can(me, 'framework:write');
  const terms = glossary.data?.terms ?? [];
  const standard = (external.data ?? []).find((s) => s.frameworkId === version.frameworkId);
  if (!glossary.data || !external.data) return <p>Loading…</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <p className="text-sm text-muted-foreground">What this standard calls things, and the institution's term for each. Suggestions come from where a word sits in the standard; nothing you set is overwritten. Edit the terms themselves in <Link to="/settings/quality-framework" className="underline">Settings → Internal Quality Framework</Link>.</p>
        {canEdit && terms.length > 0 && (
          <Button type="button" variant="ghost" className="shrink-0 self-start sm:self-auto" onClick={() => void run(async () => { const r = await api.autoMap(version.frameworkId); setMessage(`${r.mapped} term(s) mapped from their structure.`); })}>Map unmapped terms automatically</Button>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {message && <p role="status" className="text-sm text-emerald-800">{message}</p>}
      {terms.length === 0 && <p className="text-sm text-muted-foreground">The institution has no glossary terms yet. Add the starter terms in <Link to="/settings/quality-framework" className="underline">Settings → Internal Quality Framework</Link> first.</p>}
      {terms.length > 0 && !terms.some((t) => t.kind === 'level' && t.active) && (
        <p className="text-sm text-amber-800">Your levels come from your internal quality framework. <Link to="/settings/quality-framework" className="underline">Set it up</Link> to map this standard's level names.</p>
      )}
      {standard && terms.length > 0 && (
        <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] text-sm" aria-label={`Terminology of ${standard.accreditorShortName}`}>
          <thead className="text-xs text-muted-foreground"><tr><th className="py-1 pe-2 text-start">Standard's word</th><th className="pe-2 text-start">Kind</th><th className="text-start">Internal term</th></tr></thead>
          <tbody>
            {standard.terms.map((t) => {
              const options = terms.filter((x) => x.kind === KIND_OF_SOURCE[t.source] && (x.active || x.id === t.termId));
              return (
                <tr key={`${t.source}|${t.externalTerm}`} className="border-t border-border" data-testid="external-term">
                  <td className="py-1 pe-2"><ContentText>{t.externalTerm}</ContentText> <span className="text-xs text-muted-foreground">{t.detail}</span></td>
                  <td className="pe-2">{SOURCE_LABEL[t.source]}</td>
                  <td>
                    <select aria-label={`${standard.accreditorShortName} ${t.externalTerm} maps to`} className={select} disabled={!canEdit} value={t.termId ?? ''}
                      onChange={(e) => { const termId = e.target.value || null; void run(() => api.setAlias({ frameworkId: standard.frameworkId, source: t.source, externalTerm: t.externalTerm, termId })); }}>
                      <option value="">Not mapped</option>
                      {options.map((x) => <option key={x.id} value={x.id}>{x.labelEn}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
