import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReviewBadge } from '../../components/badges';
import { ContentText } from '../../components/content-text';
import { JsonEditor } from '../../components/json-editor';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { ApiError, type FrameworkApi, type Template, type Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import { FoundBy, foundOf, type FoundRef } from './found-by';
import type { Me } from '@ams/shared';

const BLANK = { name: 'New template', kind: 'self_study', language: 'en', requires_attestation: false, structure: { sections: [{ key: 'A', title: 'Introduction', block_type: 'narrative' }] } };

/** Where the analysis found a template and each of its sections (framework_version.config_found), with page and quote. */
function foundFor(version: Version, t: Template): Record<string, FoundRef> {
  const rec = foundOf(version.configFound, 'report_templates')?.items?.[t.key];
  const items: Record<string, FoundRef> = {
    [t.name]: { ...(rec?.document ? { document: rec.document } : {}), page: t.sourcePage ?? rec?.page ?? 1, quote: t.sourceQuote ?? rec?.quote ?? '', verified: t.quoteVerified },
  };
  for (const [key, ref] of Object.entries(rec?.sections ?? {})) items[`section ${key}`] = ref;
  return items;
}

export function TemplatesTab({ api, version, me }: { api: FrameworkApi; version: Version; me: Me | undefined }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [error, setError] = useState('');
  const { data } = useQuery({ queryKey: ['templates', version.id], queryFn: () => api.templates(version.id) });
  const editable = version.status === 'draft';
  const canWrite = editable && can(me, 'framework:write');
  const canReview = editable && can(me, 'framework:review');
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['templates', version.id] }); await qc.invalidateQueries({ queryKey: ['validation', version.id] }); };
  const act = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); await refresh(); } catch (e) { if (e instanceof ApiError) setError(e.message); else throw e; } } });
  const current: Template | undefined = data?.find((t) => t.key === selected);

  return (
    <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
      <div className="space-y-2">
        <ul className="space-y-1" aria-label="Report templates">
          {(data ?? []).map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => setSelected(t.key)} className={`w-full rounded px-2 py-1 text-start text-sm hover:bg-muted ${selected === t.key ? 'bg-muted font-medium' : ''}`}>
                <ContentText>{t.name}</ContentText> <span className="text-xs text-muted-foreground">({t.key} · {t.kind})</span>
              </button>
            </li>
          ))}
          {data?.length === 0 && <li className="text-sm text-muted-foreground">No templates.</li>}
        </ul>
        {canWrite && (
          <div className="flex gap-2">
            <Input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="new_template_key" aria-label="New template key" />
            <Button type="button" disabled={!newKey} onClick={() => act.mutate(async () => { await api.putTemplate(version.id, newKey, BLANK as never); setSelected(newKey); setNewKey(''); })}>Add</Button>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      </div>
      <div>
        {current ? (
          <div className="space-y-3" data-testid="template-detail">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold"><ContentText>{current.name}</ContentText></h3>
              <ReviewBadge status={current.reviewStatus} />
            </div>
            {current.origin === 'ai' && (() => {
              const items = foundFor(version, current);
              const sections = Object.keys(items).length - 1;
              return <FoundBy label="Template" edited={!!current.editedByPerson} found={{ items }} summary={`page ${current.sourcePage ?? '?'}${sections > 0 ? `, and ${sections} ${sections === 1 ? 'section' : 'sections'} with their pages` : ''}`} />;
            })()}
            <JsonEditor
              key={`${current.key}-${current.name}`} label="Template" readOnly={!canWrite} rows={22}
              value={{ name: current.name, kind: current.kind, language: current.language, requires_attestation: current.requiresAttestation, word_limit: current.wordLimit, structure: current.structure }}
              onSave={async (parsed) => { await api.putTemplate(version.id, current.key, parsed as never); await refresh(); }}
            />
            <div className="flex gap-2">
              {canReview && <>
                <Button type="button" variant="ghost" onClick={() => act.mutate(() => api.reviewTemplate(version.id, current.key, 'approved'))}>Approve template</Button>
                <Button type="button" variant="ghost" onClick={() => act.mutate(() => api.reviewTemplate(version.id, current.key, 'rejected'))}>Reject template</Button>
              </>}
              {canWrite && <Button type="button" variant="ghost" onClick={() => act.mutate(async () => { await api.deleteTemplate(version.id, current.key); setSelected(null); })}>Delete template</Button>}
            </div>
          </div>
        ) : <p className="text-sm text-muted-foreground">Select a template.</p>}
      </div>
    </div>
  );
}
