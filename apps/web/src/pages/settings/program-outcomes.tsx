import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LearningOutcome, ProgramOutcomes } from '@ams/shared';
import { LinkChip, OutcomeList, patchOf } from '../../components/outcomes/outcome-list';
import { useConfirm } from '../../components/confirm-dialog';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useAction } from '../../lib/use-action';
import { PloCourses, useMapping, type Mapping } from './curriculum-map';
import type { SyllabusApi } from '../../lib/syllabus-api';

/**
 * A program's recorded PEOs or PLOs, edited in place inside the program's dialog (TASK-112): each saves on its own (code, statements,
 * Bloom level, status), a draft can be deleted, and under each PLO are its links to ILOs and PEOs and its performance indicators.
 * New outcomes are typed as rows in the same dialog and saved with the program.
 */
export function RecordedOutcomes({ programId, kind, canWrite, api: override, syllabus }: { programId: string; kind: 'peo' | 'plo'; canWrite: boolean; api?: OutcomesApi; syllabus?: SyllabusApi }) {
  const api = useOutcomesApi(override);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = ['program-outcomes', programId];
  const data = useQuery({ queryKey: key, queryFn: () => api.programOutcomes(programId) });
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); } });
  const mapping = useMapping(programId, syllabus);
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
        {...(kind === 'plo' ? { extra: (plo: LearningOutcome) => <PloExtras plo={plo} v={v} canWrite={canWrite} linked={linked} toggle={toggle} run={(fn) => run.mutate(fn)} api={api} onDelete={del} mapping={mapping} /> } : {})} />
    </div>
  );
}

function PloExtras({ plo, v, canWrite, linked, toggle, run, api, onDelete, mapping }: {
  plo: LearningOutcome; v: ProgramOutcomes; canWrite: boolean; linked: (a: string, b: string) => boolean; toggle: (a: string, b: string) => void;
  run: (fn: () => Promise<unknown>) => void; api: OutcomesApi; onDelete: (o: LearningOutcome) => void; mapping: Mapping;
}) {
  const [showPi, setShowPi] = useState(false);
  const [showCourses, setShowCourses] = useState(false);
  // The PLO's courses and CLOs at a glance (as approved), opening into the same block as the curriculum map's By PLO view (DEC-039).
  const cells = v.map.filter((m) => m.ploId === plo.id);
  const count = (code: string) => cells.filter((m) => (m.topDown ?? m.highest) === code).length;
  const clos = v.links.filter((l) => l.toId === plo.id && v.courses.some((c) => c.clos.some((o) => o.id === l.fromId))).length;
  const waiting = v.drafts.filter((d) => d.coverage.some((x) => x.ploId === plo.id) || d.clos.some((x) => x.plos.some((m) => m.ploId === plo.id))).length;
  const summary = `${cells.length} course${cells.length === 1 ? '' : 's'}${cells.length ? ` · ${v.levels.map((l) => `${l.code} ${count(l.code)}`).join(' · ')}` : ''} · ${clos} CLO${clos === 1 ? '' : 's'}${waiting ? ` · ${waiting} waiting for approval` : ''}`;
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
      <button type="button" className="me-3 text-xs text-muted-foreground underline" aria-expanded={showCourses} aria-label={`${plo.code} courses and CLOs: ${summary}`} onClick={() => setShowCourses(!showCourses)}>
        Courses and CLOs: {summary}
      </button>
      {showCourses && <div className="rounded-md border border-border p-2"><PloCourses v={v} ploId={plo.id} canWrite={canWrite} mapping={mapping} /></div>}
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
