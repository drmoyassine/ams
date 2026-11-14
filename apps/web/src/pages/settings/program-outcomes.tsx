import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LearningOutcome, ProgramOutcomes } from '@ams/shared';
import { LinkChip, OutcomeList, patchOf } from '../../components/outcomes/outcome-list';
import { useConfirm } from '../../components/confirm-dialog';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useAction } from '../../lib/use-action';

/**
 * A program's recorded PEOs or PLOs, edited in place inside the program's dialog (TASK-112): each saves on its own (code, statements,
 * Bloom level, status), a draft can be deleted, and under each PLO are its links to ILOs and PEOs and its performance indicators.
 * New outcomes are typed as rows in the same dialog and saved with the program.
 */
export function RecordedOutcomes({ programId, kind, canWrite, api: override }: { programId: string; kind: 'peo' | 'plo'; canWrite: boolean; api?: OutcomesApi }) {
  const api = useOutcomesApi(override);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = ['program-outcomes', programId];
  const data = useQuery({ queryKey: key, queryFn: () => api.programOutcomes(programId) });
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); } });
  const del = (o: LearningOutcome) => { void confirm({ title: `Delete ${o.code}?`, message: 'The draft and its links are deleted.', confirmLabel: 'Delete', tone: 'danger' }).then((ok) => { if (ok) run.mutate(() => api.deleteOutcome(o.id)); }); };
  const v = data.data;
  if (!v) return <p className="text-sm text-muted-foreground">{data.isError ? 'Could not load the outcomes.' : 'Loading…'}</p>;
  const items = kind === 'peo' ? v.peos : v.plos;
  if (!items.length) return null;
  const linked = (from: string, to: string) => v.links.some((l) => l.fromId === from && l.toId === to);
  const toggle = (from: string, to: string) => run.mutate(() => (linked(from, to) ? api.removeLink(from, to) : api.setLink({ fromId: from, toId: to })));
  const label = kind === 'peo' ? 'PEO' : 'PLO';
  return (
    <div className="space-y-1">
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <OutcomeList label={label} items={items} canWrite={canWrite} canAdd={false} codeHint={`${label}1`} withBloom={kind === 'plo'}
        onAdd={() => undefined} onSave={(id, d) => run.mutate(() => api.updateOutcome(id, patchOf(d)))} onDelete={del}
        {...(kind === 'plo' ? { extra: (plo: LearningOutcome) => <PloExtras plo={plo} v={v} canWrite={canWrite} linked={linked} toggle={toggle} run={(fn) => run.mutate(fn)} api={api} onDelete={del} /> } : {})} />
    </div>
  );
}

function PloExtras({ plo, v, canWrite, linked, toggle, run, api, onDelete }: {
  plo: LearningOutcome; v: ProgramOutcomes; canWrite: boolean; linked: (a: string, b: string) => boolean; toggle: (a: string, b: string) => void;
  run: (fn: () => Promise<unknown>) => void; api: OutcomesApi; onDelete: (o: LearningOutcome) => void;
}) {
  const [showPi, setShowPi] = useState(false);
  const pis = v.indicators.filter((i) => i.parentId === plo.id);
  return (
    <div className="mt-1 space-y-1">
      {(v.ilos.length > 0 || v.peos.length > 0) && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          {v.ilos.length > 0 && <span className="text-muted-foreground">ILOs:</span>}
          {v.ilos.map((i) => <LinkChip key={i.id} label={`${plo.code} to ${i.code}`} title={i.textEn} on={linked(plo.id, i.id)} disabled={!canWrite} onToggle={() => toggle(plo.id, i.id)} />)}
          {v.peos.length > 0 && <span className="ms-2 text-muted-foreground">PEOs:</span>}
          {v.peos.map((p) => <LinkChip key={p.id} label={`${plo.code} to ${p.code}`} title={p.textEn} on={linked(plo.id, p.id)} disabled={!canWrite} onToggle={() => toggle(plo.id, p.id)} />)}
        </div>
      )}
      <button type="button" className="text-xs text-muted-foreground underline" aria-expanded={showPi} onClick={() => setShowPi(!showPi)}>
        {pis.length} performance indicator{pis.length === 1 ? '' : 's'}
      </button>
      {showPi && (
        <div className="ps-3">
          <OutcomeList label="indicator" items={pis} canWrite={canWrite} codeHint={`${plo.code}.1`} withBloom empty="No performance indicators yet."
            onAdd={(d) => run(() => api.createOutcome({ kind: 'pi', parentId: plo.id, ...patchOf(d), code: d.code, textEn: d.textEn }))}
            onSave={(id, d) => run(() => api.updateOutcome(id, patchOf(d)))} onDelete={onDelete} />
        </div>
      )}
    </div>
  );
}
