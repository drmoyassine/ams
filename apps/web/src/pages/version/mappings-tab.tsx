import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { ReviewBadge } from '../../components/badges';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { requirementLabel } from '../../lib/format';
import type { FrameworkApi, Mapping, Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';
import { Suggestions } from './suggestions';

const RELATION = { covers: 'Covers', partly_covers: 'Partly covers', related: 'Related' } as const;
const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';

/**
 * How this standard's requirements are answered by the institution's own quality framework. A mapping is owned by the
 * institution and carries over to new versions of the standard; it says how much an item answers, never "equivalent".
 */
export function MappingsTab({ api, version, me }: { api: FrameworkApi; version: Version; me: Me | undefined }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const reqs = useQuery({ queryKey: ['requirements', version.id], queryFn: () => api.requirements(version.id) });
  const maps = useQuery({ queryKey: ['mappings', version.id], queryFn: () => api.mappings(version.id) });
  const run = useAction(setError);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['mappings', version.id] }), qc.invalidateQueries({ queryKey: ['iqf-proposals', version.id] })]);
  const act = (fn: () => Promise<unknown>) => { setError(''); void run(fn).then(() => refresh()); };
  const canWrite = can(me, 'framework:write');
  const canReview = can(me, 'framework:review');

  if (!reqs.data || !maps.data) return <p>Loading…</p>;
  const { internalOptions, mappings } = maps.data;
  const rows = reqs.data.filter((r) => r.isAssessable);
  const current = rows.find((r) => r.id === selected) ?? null;
  const countFor = (code: string) => mappings.filter((m) => m.externalCode === code).length;
  const mine = current ? mappings.filter((m) => m.externalCode === current.code) : [];
  const stale = mappings.filter((m) => m.stale);

  if (internalOptions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        There is no quality framework to map onto yet. <Link to="/settings/quality-framework" className="underline">Set up your internal quality framework</Link> in Settings and add its standards first.
      </p>
    );
  }

  const propose = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!current) return;
    const f = new FormData(e.currentTarget);
    const internal = String(f.get('internal'));
    const relation = String(f.get('relation')) as Mapping['relation'];
    const rationale = String(f.get('rationale')).trim();
    act(() => api.createMapping(version.id, { externalRequirementId: current.id, internalRequirementId: internal, relation, ...(rationale ? { rationale } : {}) }));
    e.currentTarget.reset();
  };

  return (
    <>
    <Suggestions api={api} versionId={version.id} maps={maps.data} requirements={reqs.data} canReview={canReview} canWrite={canWrite} onChanged={() => void refresh()} />
    <div className="grid gap-6 md:grid-cols-2">
      <div className="min-w-0">
        <p className="mb-2 text-sm text-muted-foreground">Choose a requirement, then say which items of your internal quality framework answer it. Mappings are yours: they stay when this standard gets a new version.</p>
        {stale.length > 0 && <p role="status" className="mb-2 text-sm text-amber-800">{stale.length} mapping{stale.length === 1 ? '' : 's'} point at something that is not in this version or not in the published version of your internal quality framework (yet).</p>}
        <ul role="tree" aria-label="Requirements to map" className="space-y-1">
          {rows.map((r) => (
            <li key={r.id} role="treeitem" aria-selected={selected === r.id} style={{ paddingInlineStart: `${(r.depth ?? 0) * 1.25}rem` }}>
              <button type="button" onClick={() => setSelected(r.id)} className={`w-full break-words rounded px-2 py-1 text-start text-sm hover:bg-muted ${selected === r.id ? 'bg-muted font-medium' : ''}`}>
                <ContentText>{requirementLabel(r.code, r.title)}</ContentText>
                {countFor(r.code) > 0 && <span className="ms-2 rounded bg-muted px-1.5 text-xs text-muted-foreground" title="Mapped items">{countFor(r.code)}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-w-0">
        {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
        {!current && <p className="text-sm text-muted-foreground">Select a requirement.</p>}
        {current && (
          <section aria-label={`Mappings of ${current.code}`} className="space-y-3">
            <h3 className="font-medium"><ContentText>{requirementLabel(current.code, current.title)}</ContentText></h3>
            {mine.length === 0 && <p className="text-sm text-muted-foreground">Not mapped to your internal quality framework yet.</p>}
            <ul className="space-y-2">
              {mine.map((m) => (
                <li key={m.id} className="rounded-md border border-border p-3 text-sm" data-testid="mapping">
                  <div className="flex flex-wrap items-center gap-2">
                    {canWrite
                      ? <select aria-label={`Relation to ${m.internalCode}`} className={select} value={m.relation} onChange={(e) => { const relation = e.target.value as Mapping['relation']; act(() => api.updateMapping(m.id, { relation })); }}>
                          {Object.entries(RELATION).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      : <span className="font-medium">{RELATION[m.relation]}</span>}
                    <ContentText>{requirementLabel(m.internalCode, m.internalTitle ?? '')}</ContentText>
                    <ReviewBadge status={m.reviewStatus} />
                    {m.origin === 'ai' && m.reviewStatus === 'pending' && <span className="text-xs text-muted-foreground">Suggested link</span>}
                    {m.stale && <span className="text-xs text-amber-800">not in the published IQF or this version</span>}
                  </div>
                  {m.rationale && <p className="mt-1 text-muted-foreground"><ContentText>{m.rationale}</ContentText></p>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {canReview && m.reviewStatus !== 'approved' && <Button type="button" onClick={() => act(() => api.reviewMapping(m.id, 'approved'))}>Approve</Button>}
                    {canReview && m.reviewStatus === 'pending' && <Button type="button" variant="ghost" onClick={() => act(() => api.reviewMapping(m.id, 'rejected'))}>Reject</Button>}
                    {canWrite && <Button type="button" variant="ghost" aria-label={`Remove mapping to ${m.internalCode}`} onClick={() => act(() => api.deleteMapping(m.id))}>Remove</Button>}
                  </div>
                </li>
              ))}
            </ul>
            {canWrite && (
              <form onSubmit={propose} aria-label="Map to an internal quality framework item" className="space-y-2 rounded border border-dashed border-border p-3">
                <select name="internal" aria-label="Internal Quality Framework item" required className={`${select} w-full`} defaultValue="">
                  <option value="" disabled>Choose an item…</option>
                  {internalOptions.map((o) => <option key={o.id} value={o.id}>{' '.repeat(o.depth)}{requirementLabel(o.code, o.title)}</option>)}
                </select>
                <div className="flex flex-wrap gap-2">
                  <select name="relation" aria-label="Relation" className={select} defaultValue="covers">
                    {Object.entries(RELATION).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  <Input name="rationale" aria-label="Why" placeholder="Why (optional)" dir="auto" className="min-w-0 flex-1 basis-40" />
                </div>
                <Button type="submit">Propose mapping</Button>
              </form>
            )}
          </section>
        )}
      </div>
    </div>
    </>
  );
}
