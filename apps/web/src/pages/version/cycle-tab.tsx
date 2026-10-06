import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BUILDING_BLOCKS, checkQmsCycle, cycleToMermaid, DEFAULT_QMS_CYCLE, type BuildingBlock, type Me, type QmsCycle } from '@ams/shared';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { renderMermaid } from '../../lib/diagram';
import type { FrameworkApi, Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 's_$1') || 'stage';

/** The diagram, drawn from the Mermaid text; the text itself stays available if drawing fails. */
function Diagram({ text }: { text: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    renderMermaid(text).then((s) => { if (live) { setSvg(s); setFailed(false); } }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [text]);
  if (failed) return <p className="text-sm text-muted-foreground">The diagram could not be drawn here; its text is below.</p>;
  if (!svg) return <p className="text-sm text-muted-foreground">Drawing…</p>;
  return <div role="img" aria-label="Quality cycle diagram" className="overflow-x-auto rounded-md border border-border bg-background p-3" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/**
 * The quality cycle (Plan, Do, Check, Act by default): stages, the building blocks in each, and the flows between them.
 * It is edited as data and drawn as a Mermaid diagram from the same data; the model (definitions, levels, cycle and
 * diagram) downloads as one JSON file that an agent can read.
 */
export function CycleTab({ api, version, me }: { api: FrameworkApi; version: Version; me: Me | undefined }) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const model = useQuery({ queryKey: ['qms-model', version.id], queryFn: () => api.qmsModel(version.id) });
  const [draft, setDraft] = useState<QmsCycle | null>(null);
  const run = useAction(setError);
  const editable = version.status === 'draft' && can(me, 'framework:write');

  const saved = model.data?.cycle ?? null;
  const cycle = draft ?? saved;
  const names = useMemo(() => Object.fromEntries((model.data?.blocks ?? []).map((b) => [b.key, b.name])), [model.data]);
  // A block is in use unless it has been switched off in Definitions.
  const off = new Set((model.data?.blocks ?? []).filter((b) => !b.active).map((b) => b.key));
  const active = { has: (b: string) => !off.has(b) };
  if (!model.data || !cycle) return <p>Loading…</p>;

  const mermaid = cycleToMermaid(cycle, names);
  const issues = checkQmsCycle(cycle);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const placed = new Set(cycle.stages.flatMap((s) => s.blocks));
  const name = (b: string) => names[b] ?? b.charAt(0).toUpperCase() + b.slice(1).replace(/_/g, ' ');
  const edit = (fn: (c: QmsCycle) => QmsCycle) => setDraft(fn(structuredClone(cycle)));
  const save = () => {
    setError('');
    void run(async () => {
      await api.setQmsCycle(version.id, cycle);
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['qms-model', version.id] });
      await qc.invalidateQueries({ queryKey: ['version', version.id] });
    });
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">How your building blocks work together over time. Each stage holds blocks from Definitions, and arrows show what feeds what. The diagram is drawn from this, and the whole model downloads for agents.</p>
      {model.data.cycleIsDefault && !dirty && <p className="text-xs text-muted-foreground">This is the standard Plan, Do, Check, Act cycle. Change it to match how you work, then save.</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      <Diagram text={mermaid} />

      <section aria-label="Stages" className="space-y-2">
        <h3 className="font-medium">Stages</h3>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {cycle.stages.map((s, i) => (
            <div key={i} className="space-y-2 rounded-md border border-border p-3" data-testid="stage">
              {editable
                ? <Input aria-label={`Stage ${i + 1} name`} value={s.name} onChange={(e) => { const v = e.target.value; edit((c) => { c.stages[i]!.name = v; return c; }); }} />
                : <h4 className="font-medium">{s.name}</h4>}
              <ul className="space-y-1">
                {s.blocks.map((b) => (
                  <li key={b} className={`flex items-center justify-between rounded bg-muted px-2 py-1 text-sm ${active.has(b) ? '' : 'opacity-60'}`}>
                    <span>{name(b)}{!active.has(b) && <span className="ms-1 text-xs">(switched off)</span>}</span>
                    {editable && <button type="button" aria-label={`Remove ${name(b)} from ${s.name}`} className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => edit((c) => { c.stages[i]!.blocks = c.stages[i]!.blocks.filter((x) => x !== b); c.flows = c.flows.filter((f) => f.from !== b && f.to !== b); return c; })}>✕</button>}
                  </li>
                ))}
              </ul>
              {editable && (
                <div className="flex flex-wrap gap-2">
                  <select aria-label={`Add a block to ${s.name}`} className={select} value="" onChange={(e) => { const b = e.target.value as BuildingBlock; if (b) edit((c) => { c.stages[i]!.blocks.push(b); return c; }); }}>
                    <option value="">Add a block…</option>
                    {BUILDING_BLOCKS.filter((b) => !placed.has(b) && active.has(b)).map((b) => <option key={b} value={b}>{name(b)}</option>)}
                  </select>
                  {cycle.stages.length > 1 && <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => edit((c) => {
                    const gone = new Set(c.stages[i]!.blocks as string[]);
                    c.stages.splice(i, 1);
                    c.flows = c.flows.filter((f) => !gone.has(f.from) && !gone.has(f.to));
                    return c;
                  })}>Remove stage</Button>}
                </div>
              )}
            </div>
          ))}
        </div>
        {editable && <Button type="button" variant="ghost" onClick={() => edit((c) => {
          const used = new Set(c.stages.map((s) => s.key));
          let key = slug(`stage ${c.stages.length + 1}`);
          while (used.has(key)) key = `${key}_`;
          c.stages.push({ key, name: `Stage ${c.stages.length + 1}`, blocks: [] });
          return c;
        })}>Add a stage</Button>}
      </section>

      <section aria-label="Flows" className="space-y-2">
        <h3 className="font-medium">Flows</h3>
        <ul className="space-y-1 text-sm">
          {cycle.flows.map((f, i) => (
            <li key={`${f.from}>${f.to}`} className="flex items-center gap-2" data-testid="flow">
              <span>{name(f.from)} → {name(f.to)}{f.label ? <span className="text-muted-foreground"> ({f.label})</span> : null}</span>
              {editable && <button type="button" aria-label={`Remove flow ${name(f.from)} to ${name(f.to)}`} className="text-xs text-muted-foreground hover:text-foreground" onClick={() => edit((c) => { c.flows.splice(i, 1); return c; })}>✕</button>}
            </li>
          ))}
          {cycle.flows.length === 0 && <li className="text-muted-foreground">No flows yet.</li>}
        </ul>
        {editable && (
          <form aria-label="Add a flow" className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const from = String(f.get('from')) as BuildingBlock;
            const to = String(f.get('to')) as BuildingBlock;
            const label = String(f.get('label')).trim();
            if (from && to) edit((c) => { c.flows.push({ from, to, ...(label ? { label } : {}) }); return c; });
            e.currentTarget.reset();
          }}>
            <select name="from" aria-label="From" className={select} required defaultValue=""><option value="" disabled>From…</option>{[...placed].map((b) => <option key={b} value={b}>{name(b)}</option>)}</select>
            <span>→</span>
            <select name="to" aria-label="To" className={select} required defaultValue=""><option value="" disabled>To…</option>{[...placed].map((b) => <option key={b} value={b}>{name(b)}</option>)}</select>
            <Input name="label" aria-label="Flow label" placeholder="Label (optional)" className="w-48" />
            <Button type="submit" variant="ghost">Add flow</Button>
          </form>
        )}
      </section>

      {issues.length > 0 && <ul aria-label="Cycle problems" className="list-disc space-y-1 ps-5 text-sm text-red-700">{issues.map((x, n) => <li key={n}>{x.message}</li>)}</ul>}
      <div className="flex flex-wrap gap-2">
        {editable && <Button type="button" disabled={!dirty || issues.length > 0} onClick={save}>Save cycle</Button>}
        {editable && <Button type="button" variant="ghost" onClick={() => setDraft(structuredClone(DEFAULT_QMS_CYCLE))}>Start from Plan, Do, Check, Act</Button>}
        {dirty && <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Discard changes</Button>}
        <Button type="button" variant="ghost" onClick={() => download(`quality-model-${version.edition}.json`, { ...model.data, cycle, mermaid })}>Download model for agents (JSON)</Button>
      </div>
      {!editable && version.status !== 'draft' && <p className="text-xs text-muted-foreground">This version is {version.status.replace('_', ' ')}; its cycle is fixed. Create a new version to change it.</p>}
      <details>
        <summary className="cursor-pointer text-sm">Diagram text (Mermaid)</summary>
        <pre aria-label="Mermaid text" className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">{mermaid}</pre>
      </details>
    </div>
  );
}
