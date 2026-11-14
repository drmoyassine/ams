import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LearningOutcome, Program, ProgramOutcomes } from '@ams/shared';
import { LinkChip, OutcomeList, patchOf } from '../../components/outcomes/outcome-list';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { useConfirm } from '../../components/confirm-dialog';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useAction } from '../../lib/use-action';
import { ProgramReviewCard } from './program-review';
import { ProgramAssessmentCard } from './program-assessment';
import type { AssessmentApi } from '../../lib/assessment-api';


/**
 * A program's outcomes (TASK-112): its statements, PEOs, PLOs with performance indicators and their links to ILOs and PEOs, the
 * courses in the program, the curriculum map (PLO x course, from the CLO-PLO links and their levels) and the coverage checks.
 */
export function ProgramOutcomesPanel({ program, canWrite, onBack, onAddOutcomes, api: override, assessment }: { program: Program; canWrite: boolean; onBack: () => void; /** Opens the program's dialog, where PEOs and PLOs are added. */ onAddOutcomes?: () => void; api?: OutcomesApi; assessment?: AssessmentApi }) {
  const api = useOutcomesApi(override);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = ['program-outcomes', program.id];
  const data = useQuery({ queryKey: key, queryFn: () => api.programOutcomes(program.id) });
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onError: (e) => setError((e as Error).message), onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['courses'] }); } });
  const del = (o: LearningOutcome) => { void confirm({ title: `Delete ${o.code}?`, message: 'The draft and its links are deleted.', confirmLabel: 'Delete', tone: 'danger' }).then((ok) => { if (ok) run.mutate(() => api.deleteOutcome(o.id)); }); };
  const v = data.data;
  const linked = (from: string, to: string) => !!v?.links.some((l) => l.fromId === from && l.toId === to);
  const toggle = (from: string, to: string) => run.mutate(() => (linked(from, to) ? api.removeLink(from, to) : api.setLink({ fromId: from, toId: to })));

  return (
    <div className="space-y-5" aria-label={`Outcomes of ${program.nameEn}`}>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="ghost" className="px-2 py-1" onClick={onBack}>← Programs</Button>
        <h3 className="text-lg font-semibold"><ContentText>{program.nameEn}</ContentText>{program.code ? <span className="ms-2 font-mono text-sm text-muted-foreground">{program.code}</span> : null}</h3>
        {canWrite && onAddOutcomes && <Button type="button" className="ms-auto" onClick={onAddOutcomes}>Add PEOs and PLOs</Button>}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <Card aria-label="Statements">
        <h4 className="mb-2 font-semibold">Mission and vision</h4>
        {program.mission ? <ContentText className="block text-sm">{program.mission}</ContentText> : <p className="text-sm text-muted-foreground">No mission recorded (edit the program to add it).</p>}
        {program.vision && <p className="mt-2 text-sm"><span className="text-muted-foreground">Vision: </span><ContentText>{program.vision}</ContentText></p>}
      </Card>
      {!v ? <p className="text-sm text-muted-foreground">{data.isError ? 'Could not load the outcomes.' : 'Loading…'}</p> : (
        <>
          <Card><OutcomeList title="Program educational objectives" label="PEO" items={v.peos} canWrite={canWrite} canAdd={false} codeHint="PEO1"
            onAdd={(d) => run.mutate(() => api.createOutcome({ kind: 'peo', programId: program.id, ...patchOf(d), code: d.code, textEn: d.textEn }))}
            onSave={(id, d) => run.mutate(() => api.updateOutcome(id, patchOf(d)))} onDelete={del} /></Card>
          <Card><OutcomeList title="Program learning outcomes" label="PLO" items={v.plos} canWrite={canWrite} canAdd={false} codeHint="PLO1" withBloom
            onAdd={(d) => run.mutate(() => api.createOutcome({ kind: 'plo', programId: program.id, ...patchOf(d), code: d.code, textEn: d.textEn }))}
            onSave={(id, d) => run.mutate(() => api.updateOutcome(id, patchOf(d)))} onDelete={del}
            extra={(plo) => <PloExtras plo={plo} v={v} canWrite={canWrite} linked={linked} toggle={toggle} run={(fn) => run.mutate(fn)} api={api} onDelete={del} />} /></Card>
          <Card><p className="text-sm text-muted-foreground">The program's curriculum map and coverage checks are on the <span className="font-medium text-foreground">Curriculum map</span> tab.</p></Card>
          <ProgramAssessmentCard programId={program.id} outcomes={v} canWrite={canWrite} {...(assessment ? { api: assessment } : {})} />
          <ProgramReviewCard programId={program.id} canWrite={canWrite} {...(override ? { api: override } : {})} />
        </>
      )}
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
