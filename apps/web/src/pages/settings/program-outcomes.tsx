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

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
const COVERAGE_TITLE = {
  plo_unmapped: 'PLO with no course outcome', plo_no_mastery: 'PLO never mastered', course_unmapped: 'Course mapped to no PLO',
  clo_unmapped: 'CLO mapped to no PLO', plo_no_ilo: 'PLO with no ILO', link_no_level: 'Link without a level',
} as const;

/**
 * A program's outcomes (TASK-112): its statements, PEOs, PLOs with performance indicators and their links to ILOs and PEOs, the
 * courses in the program, the curriculum map (PLO x course, from the CLO-PLO links and their levels) and the coverage checks.
 */
export function ProgramOutcomesPanel({ program, canWrite, onBack, api: override, assessment }: { program: Program; canWrite: boolean; onBack: () => void; api?: OutcomesApi; assessment?: AssessmentApi }) {
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
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <Card aria-label="Statements">
        <h4 className="mb-2 font-semibold">Mission and vision</h4>
        {program.mission ? <ContentText className="block text-sm">{program.mission}</ContentText> : <p className="text-sm text-muted-foreground">No mission recorded (edit the program to add it).</p>}
        {program.vision && <p className="mt-2 text-sm"><span className="text-muted-foreground">Vision: </span><ContentText>{program.vision}</ContentText></p>}
      </Card>
      {!v ? <p className="text-sm text-muted-foreground">{data.isError ? 'Could not load the outcomes.' : 'Loading…'}</p> : (
        <>
          <Card><OutcomeList title="Program educational objectives" label="PEO" items={v.peos} canWrite={canWrite} codeHint="PEO1"
            onAdd={(d) => run.mutate(() => api.createOutcome({ kind: 'peo', programId: program.id, ...patchOf(d), code: d.code, textEn: d.textEn }))}
            onSave={(id, d) => run.mutate(() => api.updateOutcome(id, patchOf(d)))} onDelete={del} /></Card>
          <Card><OutcomeList title="Program learning outcomes" label="PLO" items={v.plos} canWrite={canWrite} codeHint="PLO1" withBloom
            onAdd={(d) => run.mutate(() => api.createOutcome({ kind: 'plo', programId: program.id, ...patchOf(d), code: d.code, textEn: d.textEn }))}
            onSave={(id, d) => run.mutate(() => api.updateOutcome(id, patchOf(d)))} onDelete={del}
            extra={(plo) => <PloExtras plo={plo} v={v} canWrite={canWrite} linked={linked} toggle={toggle} run={(fn) => run.mutate(fn)} api={api} onDelete={del} />} /></Card>
          <Card><CurriculumMap v={v} canWrite={canWrite} api={api} run={(fn) => run.mutate(fn)} /></Card>
          <Card><Coverage v={v} /></Card>
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

/** PLO x course: the highest level the course's CLOs reach; a cell opens the CLO links of that course to that PLO. */
function CurriculumMap({ v, canWrite, api, run }: { v: ProgramOutcomes; canWrite: boolean; api: OutcomesApi; run: (fn: () => Promise<unknown>) => void }) {
  const [cell, setCell] = useState<{ ploId: string; courseId: string } | null>(null);
  const [adding, setAdding] = useState('');
  const all = useQuery({ queryKey: ['courses'], queryFn: () => api.courses(), enabled: canWrite });
  const at = (ploId: string, courseId: string) => v.map.find((m) => m.ploId === ploId && m.courseId === courseId);
  const levelName = new Map(v.levels.map((l) => [l.code, l.name]));
  const plos = v.plos.filter((p) => p.status !== 'retired');
  const open = cell ? { plo: v.plos.find((p) => p.id === cell.ploId)!, course: v.courses.find((c) => c.courseId === cell.courseId)! } : null;
  return (
    <section aria-label="Curriculum map" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">Curriculum map</h4>
        <p className="text-xs text-muted-foreground">{v.levels.map((l) => `${l.code} ${l.name}${l.mastery ? ' (mastery)' : ''}`).join(' · ')}</p>
      </div>
      {v.courses.length === 0 ? <p className="text-sm text-muted-foreground">No courses in this program yet.</p> : plos.length === 0 ? <p className="text-sm text-muted-foreground">Add PLOs to map the courses to.</p> : (
        <div className="overflow-x-auto">
          <table className="text-sm" aria-label="PLO by course">
            <thead>
              <tr><th className="sticky start-0 bg-background px-2 py-1 text-start">Course</th>{plos.map((p) => <th key={p.id} className="px-2 py-1 font-mono text-xs" title={p.textEn}>{p.code}</th>)}</tr>
            </thead>
            <tbody>
              {v.courses.map((c) => (
                <tr key={c.courseId} className="border-t border-border">
                  <th scope="row" className="sticky start-0 bg-background px-2 py-1 text-start font-normal"><span className="font-mono">{c.code}</span> <span className="text-xs text-muted-foreground">{c.role !== 'core' ? c.role : ''}{c.year ? ` Y${c.year}` : ''}</span></th>
                  {plos.map((p) => {
                    const m = at(p.id, c.courseId);
                    const label = m ? (m.highest ?? '✓') : '·';
                    return (
                      <td key={p.id} className="px-1 py-0.5 text-center">
                        <button type="button" aria-label={`${c.code} ${p.code}: ${m ? (m.highest ? levelName.get(m.highest) : 'linked, no level') : 'not mapped'}`}
                          className={`min-w-8 rounded px-1 ${m ? 'bg-primary/10 font-semibold' : 'text-muted-foreground'} ${cell?.ploId === p.id && cell.courseId === c.courseId ? 'ring-2 ring-primary' : ''}`}
                          onClick={() => setCell({ ploId: p.id, courseId: c.courseId })}>{label}</button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <div className="rounded-lg border border-border p-3" aria-label={`${open.course.code} to ${open.plo.code}`}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm"><span className="font-mono font-semibold">{open.course.code}</span> CLOs → <span className="font-mono font-semibold">{open.plo.code}</span> <ContentText className="text-muted-foreground">{open.plo.textEn}</ContentText></p>
            <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => setCell(null)}>Close</Button>
          </div>
          {open.course.clos.length === 0 && <p className="text-sm text-muted-foreground">This course has no CLOs yet (add them on the Courses tab).</p>}
          <ul className="space-y-1">
            {open.course.clos.map((clo) => {
              const link = v.links.find((l) => l.fromId === clo.id && l.toId === open.plo.id);
              const value = !link ? '' : (link.level ?? '-');
              return (
                <li key={clo.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <select aria-label={`${clo.code} level for ${open.plo.code}`} className={select} value={value} disabled={!canWrite}
                    onChange={(e) => { const to = e.target.value; run(() => (to === '' ? api.removeLink(clo.id, open.plo.id) : api.setLink({ fromId: clo.id, toId: open.plo.id, level: to === '-' ? null : to }))); }}>
                    <option value="">Not mapped</option>
                    <option value="-">Linked, no level</option>
                    {v.levels.map((l) => <option key={l.code} value={l.code}>{l.code} {l.name}</option>)}
                  </select>
                  <span className="font-mono">{clo.code}</span><ContentText className="min-w-0 flex-1">{clo.textEn}</ContentText>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {canWrite && (
        <form className="flex flex-wrap gap-2" aria-label="Add a course to the program" onSubmit={(e) => { e.preventDefault(); if (adding) { run(() => api.setCourseProgram(adding, v.programId, { role: 'core' })); setAdding(''); } }}>
          <select aria-label="Course to add" className={select} value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a course to this program…</option>
            {(all.data ?? []).filter((c) => c.active && !v.courses.some((x) => x.courseId === c.id)).map((c) => <option key={c.id} value={c.id}>{c.code} {c.titleEn}</option>)}
          </select>
          <Button type="submit" variant="outline" className="px-3 py-1" disabled={!adding}>Add course</Button>
        </form>
      )}
    </section>
  );
}

function Coverage({ v }: { v: ProgramOutcomes }) {
  return (
    <section aria-label="Coverage" className="space-y-2">
      <h4 className="font-semibold">Coverage</h4>
      {v.coverage.length === 0
        ? <p className="text-sm text-emerald-700">{v.plos.length ? 'Every PLO is mapped and reaches mastery; every core course maps to a PLO.' : 'Nothing to check yet.'}</p>
        : (
          <ul className="space-y-1 text-sm" aria-label="Coverage issues">
            {v.coverage.map((i, n) => <li key={n}><span className="me-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900">{COVERAGE_TITLE[i.kind]}</span>{i.message}</li>)}
          </ul>
        )}
    </section>
  );
}
