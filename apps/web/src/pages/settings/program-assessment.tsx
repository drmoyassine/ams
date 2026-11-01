import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACTION_STATUSES, shareOf, type AssessmentPlan, type CorrectiveAction, type ImportResultRow, type LearningOutcome, type OutcomeResult, type PlanItem, type ProgramOutcomes } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { useFilePicker } from '../../components/files';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useAssessmentApi, type AssessmentApi } from '../../lib/assessment-api';
import { readSheets } from '../../lib/sheet-io';
import { useAction } from '../../lib/use-action';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
const STANDING = { at_or_above: ['At or above target', 'bg-emerald-100 text-emerald-900'], below: ['Below target', 'bg-red-100 text-red-900'], none: ['No target', 'bg-muted text-muted-foreground'] } as const;
const ACTION_STATUS = { open: 'Open', in_progress: 'In progress', implemented: 'Implemented', verified: 'Verified (re-assessed)', not_effective: 'Not effective', closed: 'Closed' } as const;
const PLAN_STATUS = { draft: 'Draft', submitted: 'Submitted', endorsed: 'Endorsed', returned: 'Returned' } as const;
const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));
/** The academic year that starts this calendar year from August ("2026-27"). */
const currentYear = () => { const d = new Date(); const y = d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; };

/**
 * A program's assessment of learning (TASK-114..117): the IE-001 plan of a year, course attainment by the QAIEO method, results with
 * their standing against the target, and the corrective actions that close the loop.
 */
export function ProgramAssessmentCard({ programId, outcomes, canWrite, api: override }: { programId: string; outcomes: ProgramOutcomes; canWrite: boolean; api?: AssessmentApi }) {
  const api = useAssessmentApi(override);
  const [tab, setTab] = useState<'plan' | 'attainment' | 'results' | 'actions'>('plan');
  const data = useQuery({ queryKey: ['program-assessment', programId], queryFn: () => api.programAssessment(programId) });
  const tabs = [{ id: 'plan', label: 'Plan' }, { id: 'attainment', label: 'Attainment' }, { id: 'results', label: 'Results' }, { id: 'actions', label: `Actions${data.data?.openGaps.length ? ` (${data.data.openGaps.length} gaps)` : ''}` }] as const;
  return (
    <Card role="region" aria-label="Assessment">
      <h4 className="mb-2 font-semibold">Assessment of learning</h4>
      <div role="tablist" aria-label="Assessment sections" className="mb-3 flex flex-wrap gap-1">
        {tabs.map((t) => <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`rounded-md px-3 py-1 text-sm ${tab === t.id ? 'bg-muted font-medium' : 'text-muted-foreground'}`}>{t.label}</button>)}
      </div>
      {!data.data ? <p className="text-sm text-muted-foreground">Loading…</p>
        : tab === 'plan' ? <PlanTab api={api} programId={programId} plans={data.data.plans} outcomes={outcomes} canWrite={canWrite} />
          : tab === 'attainment' ? <AttainmentTab api={api} programId={programId} outcomes={outcomes} canWrite={canWrite} />
            : tab === 'results' ? <ResultsTab api={api} programId={programId} results={data.data.results} outcomes={outcomes} canWrite={canWrite} />
              : <ActionsTab api={api} programId={programId} actions={data.data.actions} results={data.data.results} gaps={data.data.openGaps} outcomes={outcomes} canWrite={canWrite} />}
    </Card>
  );
}

function useRun(api: AssessmentApi, programId: string, extra: unknown[][] = []) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onError: (e) => setError((e as Error).message),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['program-assessment', programId] }); for (const k of extra) void qc.invalidateQueries({ queryKey: k }); },
  });
  return { run: (fn: () => Promise<unknown>) => run.mutate(fn), error, setError };
}
const outcomeLabel = (o: ProgramOutcomes, id: string) => {
  const plo = o.plos.find((p) => p.id === id);
  if (plo) return plo.code;
  for (const c of o.courses) { const clo = c.clos.find((x) => x.id === id); if (clo) return `${c.code} ${clo.code}`; }
  return '…';
};

// ---- Plan ---------------------------------------------------------------------------------------------------------------------

function PlanTab({ api, programId, plans, outcomes, canWrite }: { api: AssessmentApi; programId: string; plans: { id: string; academicYear: string; status: string }[]; outcomes: ProgramOutcomes; canWrite: boolean }) {
  const [chosen, setChosen] = useState<string | null>(plans[0]?.id ?? null);
  const [year, setYear] = useState(currentYear());
  const { run, error } = useRun(api, programId, [['plan']]);
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ['plan', chosen], queryFn: () => api.plan(chosen!), enabled: !!chosen });
  const start = () => run(async () => { const p = await api.createPlan(programId, year, plans[0]?.academicYear); setChosen(p.id); await qc.invalidateQueries({ queryKey: ['plan'] }); });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        {plans.length > 0 && (
          <select aria-label="Plan year" className={select} value={chosen ?? ''} onChange={(e) => setChosen(e.target.value)}>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.academicYear} · {PLAN_STATUS[p.status as keyof typeof PLAN_STATUS]}</option>)}
          </select>
        )}
        {canWrite && (
          <>
            <Input aria-label="Academic year" className="w-24" value={year} onChange={(e) => setYear(e.target.value)} />
            <Button type="button" variant="outline" className="px-3 py-1" onClick={start}>Start plan{plans.length ? ` (copy ${plans[0]!.academicYear})` : ''}</Button>
          </>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {!chosen ? <p className="text-sm text-muted-foreground">No assessment plan yet. IE-001: every program has a current plan, endorsed by the dean, before the year starts.</p>
        : !plan.data ? <p className="text-sm text-muted-foreground">Loading…</p> : <PlanView plan={plan.data} api={api} programId={programId} outcomes={outcomes} canWrite={canWrite} />}
    </div>
  );
}

function PlanView({ plan, api, programId, outcomes, canWrite }: { plan: AssessmentPlan; api: AssessmentApi; programId: string; outcomes: ProgramOutcomes; canWrite: boolean }) {
  const { run, error } = useRun(api, programId, [['plan', plan.id]]);
  const editable = canWrite && plan.status !== 'endorsed';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded bg-muted px-2 py-0.5">{PLAN_STATUS[plan.status]}</span>
        {plan.submittedOn && <span className="text-muted-foreground">submitted {plan.submittedOn}</span>}
        {plan.endorsedOn && <span className="text-muted-foreground">endorsed {plan.endorsedOn}{plan.endorsedBy ? ` by ${plan.endorsedBy}` : ''}</span>}
        {canWrite && plan.status !== 'endorsed' && plan.status !== 'submitted' && <Button type="button" variant="outline" className="px-2 py-0.5" onClick={() => run(() => api.updatePlan(plan.id, { status: 'submitted' }))}>Submit to QAIEO</Button>}
        {canWrite && plan.status === 'submitted' && (
          <>
            <Button type="button" variant="outline" className="px-2 py-0.5" onClick={() => run(() => api.updatePlan(plan.id, { status: 'endorsed' }))}>Record endorsement</Button>
            <Button type="button" variant="ghost" className="px-2 py-0.5" onClick={() => run(() => api.updatePlan(plan.id, { status: 'returned' }))}>Return</Button>
          </>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {plan.issues.length > 0 && (
        <ul className="space-y-0.5 text-sm" aria-label="Plan gaps">
          {plan.issues.map((i, n) => <li key={n}><span className="me-2 rounded bg-amber-50 px-1.5 text-xs text-amber-900">IE-001</span>{i.message}</li>)}
        </ul>
      )}
      <ul className="divide-y divide-border rounded border border-border" aria-label="Plan by PLO">
        {plan.items.map((it) => <PlanItemRow key={it.id} item={it} plo={outcomes.plos.find((p) => p.id === it.ploId)} courses={outcomes.courses} editable={editable} onSave={(patch) => run(() => api.savePlanItem(it.id, patch))} />)}
      </ul>
    </div>
  );
}

function PlanItemRow({ item, plo, courses, editable, onSave }: { item: PlanItem; plo: LearningOutcome | undefined; courses: ProgramOutcomes['courses']; editable: boolean; onSave: (p: Record<string, unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    assessIn: item.assessIn ?? '', directCourseId: item.directCourseId ?? '', directMethod: item.directMethod ?? '', directRubric: item.directRubric ?? '',
    indirectMethod: item.indirectMethod ?? '', indirectFrequency: item.indirectFrequency ?? '', targetShare: item.targetShare?.toString() ?? '', targetScore: item.targetScore?.toString() ?? '',
    responsible: item.responsible ?? '', collectionWindow: item.collectionWindow ?? '', reassessIn: item.reassessIn ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const course = courses.find((c) => c.courseId === item.directCourseId);
  const field = 'flex flex-col gap-1 text-xs';
  return (
    <li className="px-3 py-2 text-sm">
      <button type="button" className="w-full text-start" aria-expanded={open} aria-label={`Plan for ${plo?.code ?? 'PLO'}`} onClick={() => setOpen(!open)}>
        <span className="font-mono font-semibold">{plo?.code}</span> <ContentText className="text-muted-foreground">{plo?.textEn}</ContentText>
        <span className="block text-xs text-muted-foreground">
          {[item.assessIn ? `assessed ${item.assessIn}` : 'no term', course ? `direct: ${item.directMethod ?? '…'} in ${course.code}` : 'no direct measure', item.indirectMethod ? `indirect: ${item.indirectMethod}` : 'no indirect measure',
            item.targetShare !== null ? `target ${item.targetShare}% of students${item.targetScore !== null ? ` at ≥ ${item.targetScore}%` : ''}` : item.targetScore !== null ? `target score ≥ ${item.targetScore}%` : null].filter(Boolean).join(' · ')}
        </span>
      </button>
      {open && (
        <form className="mt-2 grid gap-2 sm:grid-cols-4" aria-label={`Edit plan for ${plo?.code}`} onSubmit={(e) => {
          e.preventDefault();
          onSave({ ...f, directCourseId: f.directCourseId || null, targetShare: numOrNull(f.targetShare), targetScore: numOrNull(f.targetScore) });
          setOpen(false);
        }}>
          <label className={field}>Assessed in<Input aria-label="Assessed in" value={f.assessIn} placeholder="Fall 2026" onChange={set('assessIn')} disabled={!editable} /></label>
          <label className={field}>Direct course
            <select aria-label="Direct course" className={select} value={f.directCourseId} onChange={set('directCourseId')} disabled={!editable}>
              <option value="">Choose</option>
              {courses.map((c) => <option key={c.courseId} value={c.courseId}>{c.code}</option>)}
            </select>
          </label>
          <label className={field}>Direct method<Input aria-label="Direct method" value={f.directMethod} placeholder="Capstone project" onChange={set('directMethod')} disabled={!editable} /></label>
          <label className={field}>Rubric<Input aria-label="Rubric" value={f.directRubric} onChange={set('directRubric')} disabled={!editable} /></label>
          <label className={field}>Indirect method<Input aria-label="Indirect method" value={f.indirectMethod} placeholder="Exit survey" onChange={set('indirectMethod')} disabled={!editable} /></label>
          <label className={field}>Frequency<Input aria-label="Indirect frequency" value={f.indirectFrequency} placeholder="Every semester" onChange={set('indirectFrequency')} disabled={!editable} /></label>
          <label className={field}>Target: % of students<Input aria-label="Target share" inputMode="decimal" value={f.targetShare} onChange={set('targetShare')} disabled={!editable} /></label>
          <label className={field}>Target: at score %<Input aria-label="Target score" inputMode="decimal" value={f.targetScore} onChange={set('targetScore')} disabled={!editable} /></label>
          <label className={field}>Responsible<Input aria-label="Responsible" value={f.responsible} onChange={set('responsible')} disabled={!editable} /></label>
          <label className={field}>Collection<Input aria-label="Collection window" value={f.collectionWindow} placeholder="Weeks 12-14" onChange={set('collectionWindow')} disabled={!editable} /></label>
          <label className={field}>Re-assess in<Input aria-label="Re-assess in" value={f.reassessIn} onChange={set('reassessIn')} disabled={!editable} /></label>
          {editable && <div className="flex items-end"><Button type="submit">Save</Button></div>}
        </form>
      )}
    </li>
  );
}

// ---- Attainment (the QAIEO method) ----------------------------------------------------------------------------------------------

function AttainmentTab({ api, programId, outcomes, canWrite }: { api: AssessmentApi; programId: string; outcomes: ProgramOutcomes; canWrite: boolean }) {
  const [courseId, setCourseId] = useState(outcomes.courses[0]?.courseId ?? '');
  const [term, setTerm] = useState('');
  const course = outcomes.courses.find((c) => c.courseId === courseId);
  const list = useQuery({ queryKey: ['course-assessments', courseId, term], queryFn: () => api.courseAssessments(courseId, term), enabled: !!courseId && !!term.trim() });
  const att = useQuery({ queryKey: ['attainment', courseId, term], queryFn: () => api.attainment(courseId, term), enabled: !!courseId && !!term.trim() });
  const { run, error } = useRun(api, programId, [['course-assessments', courseId, term], ['attainment', courseId, term]]);
  const [adding, setAdding] = useState(false);
  const [recorded, setRecorded] = useState<number | null>(null);
  if (!outcomes.courses.length) return <p className="text-sm text-muted-foreground">Add courses to the program first.</p>;
  const cloCode = (id: string) => course?.clos.find((c) => c.id === id)?.code ?? '…';
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">QAIEO method: each assessment's parts carry marks and CLOs; a CLO's achievement is its share of the marks times the class average. Totals per CLO give attainment and the CLO's weight in the course's assessment design; the CLO-PLO links roll them up to the PLOs.</p>
      <div className="flex flex-wrap gap-2">
        <select aria-label="Course" className={select} value={courseId} onChange={(e) => setCourseId(e.target.value)}>{outcomes.courses.map((c) => <option key={c.courseId} value={c.courseId}>{c.code} {c.titleEn}</option>)}</select>
        <Input aria-label="Term" className="w-36" placeholder="Spring 2026" value={term} onChange={(e) => setTerm(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {term.trim() && list.data && (
        <>
          <ul className="space-y-1 text-sm" aria-label="Assessments">
            {list.data.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{a.name}</span>
                <span className="text-xs text-muted-foreground">{a.totalMarks} marks · class average {a.classAverage ?? '—'}{a.students ? ` · ${a.students} students` : ''} · {a.parts.map((p) => `${p.label} ${p.marks} (${p.cloIds.map(cloCode).join('+') || 'no CLO'})`).join(', ')}</span>
                {canWrite && <Button type="button" variant="ghost" className="px-2 py-0.5 text-xs" aria-label={`Delete ${a.name}`} onClick={() => run(() => api.deleteCourseAssessment(courseId, a.id))}>Delete</Button>}
              </li>
            ))}
          </ul>
          {canWrite && (adding
            ? <AssessmentForm clos={course?.clos ?? []} onCancel={() => setAdding(false)} onSubmit={(v) => { run(() => api.saveCourseAssessment(courseId, { ...v, term: term.trim() })); setAdding(false); }} />
            : <Button type="button" variant="outline" className="px-3 py-1" onClick={() => setAdding(true)}>Add assessment</Button>)}
          {att.data && att.data.clos.length > 0 && (
            <div className="space-y-2">
              <table className="text-sm" aria-label="CLO attainment">
                <thead><tr className="text-xs text-muted-foreground"><th className="pe-3 text-start">CLO</th><th className="pe-3">Weight in design</th><th className="pe-3">Marks</th><th>Attainment</th></tr></thead>
                <tbody>
                  {att.data.clos.map((c) => <tr key={c.cloId}><td className="pe-3 font-mono">{cloCode(c.cloId)}</td><td className="pe-3 text-center">{c.weight}%</td><td className="pe-3 text-center">{c.achieved} / {c.possible}</td><td className="text-center font-semibold">{c.attainment ?? '—'}%</td></tr>)}
                  <tr className="border-t border-border"><td className="pe-3 font-medium">All CLOs</td><td /><td /><td className="text-center font-semibold">{att.data.overall ?? '—'}%</td></tr>
                </tbody>
              </table>
              {att.data.unmapped > 0 && <p className="text-xs text-amber-800">{att.data.unmapped} of {att.data.total} marks assess no CLO.</p>}
              <p className="text-sm">PLOs: {att.data.plos.filter((p) => p.programId === programId).map((p) => `${p.code} ${p.attainment ?? '—'}%`).join(' · ') || 'none linked'}</p>
              {canWrite && <Button type="button" onClick={() => run(async () => { const r = await api.recordAttainment(courseId, term.trim()); setRecorded(r.recorded); })}>Record as results</Button>}
              {recorded !== null && <p role="status" className="text-sm text-emerald-700">Recorded {recorded} results.</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AssessmentForm({ clos, onSubmit, onCancel }: { clos: LearningOutcome[]; onSubmit: (v: { name: string; totalMarks: number; classAverage: number | null; students: number | null; parts: { label: string; marks: number; cloIds: string[] }[] }) => void; onCancel: () => void }) {
  const [v, setV] = useState({ name: '', classAverage: '', students: '' });
  const [parts, setParts] = useState([{ label: 'Q1', marks: '', cloIds: [] as string[] }]);
  const total = parts.reduce((s, p) => s + (Number(p.marks) || 0), 0);
  const setPart = (i: number, patch: Partial<(typeof parts)[number]>) => setParts(parts.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <form className="space-y-2 rounded border border-border p-2" aria-label="Add assessment" onSubmit={(e) => {
      e.preventDefault();
      if (!v.name.trim() || !total) return;
      onSubmit({ name: v.name, totalMarks: total, classAverage: numOrNull(v.classAverage), students: numOrNull(v.students), parts: parts.filter((p) => Number(p.marks) > 0).map((p) => ({ label: p.label, marks: Number(p.marks), cloIds: p.cloIds })) });
    }}>
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Assessment name" className="w-40" placeholder="Quiz 1" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required />
        <Input aria-label="Class average" className="w-32" placeholder="Class average" inputMode="decimal" value={v.classAverage} onChange={(e) => setV({ ...v, classAverage: e.target.value })} />
        <Input aria-label="Students" className="w-24" placeholder="Students" inputMode="numeric" value={v.students} onChange={(e) => setV({ ...v, students: e.target.value })} />
        <span className="self-center text-sm text-muted-foreground">Total {total} marks</span>
      </div>
      {parts.map((p, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
          <Input aria-label={`Part ${i + 1} label`} className="w-20" value={p.label} onChange={(e) => setPart(i, { label: e.target.value })} />
          <Input aria-label={`Part ${i + 1} marks`} className="w-20" placeholder="Marks" inputMode="decimal" value={p.marks} onChange={(e) => setPart(i, { marks: e.target.value })} />
          {clos.map((c) => (
            <label key={c.id} className="flex items-center gap-1 text-xs"><input type="checkbox" aria-label={`Part ${i + 1} assesses ${c.code}`} checked={p.cloIds.includes(c.id)}
              onChange={(e) => setPart(i, { cloIds: e.target.checked ? [...p.cloIds, c.id] : p.cloIds.filter((x) => x !== c.id) })} />{c.code}</label>
          ))}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => setParts([...parts, { label: `Q${parts.length + 1}`, marks: '', cloIds: [] }])}>Add part</Button>
        <Button type="submit" disabled={!v.name.trim() || !total}>Save assessment</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

// ---- Results ------------------------------------------------------------------------------------------------------------------------

const RESULT_HEADERS: Record<string, keyof ImportResultRow> = {
  outcome: 'outcome', term: 'term', kind: 'kind', course: 'course', method: 'method', sample: 'sampleSize', 'sample size': 'sampleSize', 'at target': 'studentsAtTarget',
  'students at target': 'studentsAtTarget', share: 'shareAtTarget', '% at target': 'shareAtTarget', mean: 'meanScore', 'mean score': 'meanScore', scale: 'scaleMax', 'response rate': 'responseRate',
};
function ResultsTab({ api, programId, results, outcomes, canWrite }: { api: AssessmentApi; programId: string; results: OutcomeResult[]; outcomes: ProgramOutcomes; canWrite: boolean }) {
  const { run, error, setError } = useRun(api, programId);
  const [f, setF] = useState({ outcomeId: outcomes.plos[0]?.id ?? '', term: '', kind: 'direct', method: '', sampleSize: '', studentsAtTarget: '', meanScore: '', scaleMax: '' });
  const [importNote, setImportNote] = useState<string | null>(null);
  const picker = useFilePicker({
    kind: 'data', label: 'Results sheet',
    onFiles: ([file]) => {
      if (!file) return;
      void readSheets(file, ['Results', 'Sheet1']).then(async (sheets) => {
        const raw = sheets.Results ?? sheets.Sheet1 ?? [];
        const rows = raw.map((r) => {
          const o: Record<string, unknown> = {};
          for (const [h, v] of Object.entries(r)) { const k = RESULT_HEADERS[h.trim().toLowerCase()]; if (k && v !== '') o[k] = ['outcome', 'term', 'kind', 'course', 'method'].includes(k) ? v : Number(v); }
          if (typeof o.kind === 'string') o.kind = /indirect/i.test(o.kind) ? 'indirect' : 'direct';
          return o as ImportResultRow;
        }).filter((r) => r.outcome && r.term && r.kind);
        if (!rows.length) { setError('No rows with Outcome, Term and Kind columns were found (sheet "Results" or the first sheet).'); return; }
        run(async () => { const r = await api.importResults(programId, rows, true, file.name); setImportNote(`Imported ${r.added} results${r.skipped.length ? `; left out: ${r.skipped.map((s) => s.row).join(', ')}` : ''}.`); });
      }).catch((e: unknown) => setError((e as Error).message));
    },
  });
  const allOutcomes = [...outcomes.plos.map((p) => ({ id: p.id, label: p.code })), ...outcomes.courses.flatMap((c) => c.clos.map((o) => ({ id: o.id, label: `${c.code} ${o.code}` })))];
  return (
    <div className="space-y-3">
      {picker.input}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {importNote && <p role="status" className="text-sm">{importNote}</p>}
      {results.length === 0 ? <p className="text-sm text-muted-foreground">No results yet.</p> : (
        <div className="overflow-x-auto">
          <table className="text-sm" aria-label="Results">
            <thead><tr className="text-xs text-muted-foreground"><th className="pe-3 text-start">Outcome</th><th className="pe-3 text-start">Term</th><th className="pe-3 text-start">Measure</th><th className="pe-3">Students</th><th className="pe-3">Mean</th><th className="pe-3 text-start">Standing</th><th /></tr></thead>
            <tbody>
              {results.map((r) => {
                const share = shareOf(r);
                return (
                  <tr key={r.id} className="border-t border-border">
                    <td className="pe-3 font-mono">{outcomeLabel(outcomes, r.outcomeId)}</td>
                    <td className="pe-3">{r.term}</td>
                    <td className="pe-3">{r.kind === 'direct' ? 'Direct' : 'Indirect'}{r.method ? `: ${r.method}` : ''}{r.source ? <span className="block text-xs text-muted-foreground">{r.source}</span> : null}</td>
                    <td className="pe-3 text-center">{r.sampleSize !== null ? `${r.studentsAtTarget ?? '—'}/${r.sampleSize}` : '—'}{share !== null ? ` (${share}%)` : ''}{r.responseRate !== null ? <span className="block text-xs text-muted-foreground">response {r.responseRate}%</span> : null}</td>
                    <td className="pe-3 text-center">{r.meanScore ?? '—'}{r.scaleMax ? `/${r.scaleMax}` : ''}</td>
                    <td className="pe-3"><span className={`rounded px-1.5 py-0.5 text-xs ${STANDING[r.standing][1]}`} title={r.target ?? ''}>{STANDING[r.standing][0]}</span></td>
                    <td>{canWrite && <Button type="button" variant="ghost" className="px-2 py-0.5 text-xs" aria-label={`Delete result ${outcomeLabel(outcomes, r.outcomeId)} ${r.term}`} onClick={() => run(() => api.deleteResult(r.id))}>Delete</Button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {canWrite && (
        <form className="flex flex-wrap items-end gap-2 rounded border border-border p-2" aria-label="Add result" onSubmit={(e) => {
          e.preventDefault();
          if (!f.outcomeId || !f.term.trim()) return;
          run(() => api.addResult({ outcomeId: f.outcomeId, term: f.term, kind: f.kind as 'direct' | 'indirect', method: f.method || null, sampleSize: numOrNull(f.sampleSize), studentsAtTarget: numOrNull(f.studentsAtTarget), meanScore: numOrNull(f.meanScore), scaleMax: numOrNull(f.scaleMax) }));
          setF({ ...f, term: '', method: '', sampleSize: '', studentsAtTarget: '', meanScore: '', scaleMax: '' });
        }}>
          <select aria-label="Result outcome" className={select} value={f.outcomeId} onChange={(e) => setF({ ...f, outcomeId: e.target.value })}>{allOutcomes.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
          <Input aria-label="Result term" className="w-28" placeholder="Spring 2026" value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })} />
          <select aria-label="Result kind" className={select} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="direct">Direct</option><option value="indirect">Indirect</option></select>
          <Input aria-label="Result method" className="w-36" placeholder="Method" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} />
          <Input aria-label="Sample size" className="w-20" placeholder="Students" value={f.sampleSize} onChange={(e) => setF({ ...f, sampleSize: e.target.value })} />
          <Input aria-label="Students at target" className="w-20" placeholder="At target" value={f.studentsAtTarget} onChange={(e) => setF({ ...f, studentsAtTarget: e.target.value })} />
          <Input aria-label="Mean score" className="w-20" placeholder="Mean" value={f.meanScore} onChange={(e) => setF({ ...f, meanScore: e.target.value })} />
          <Input aria-label="Scale" className="w-16" placeholder="of" value={f.scaleMax} onChange={(e) => setF({ ...f, scaleMax: e.target.value })} />
          <Button type="submit" variant="outline" className="px-3 py-1">Add result</Button>
          <Button type="button" variant="ghost" className="px-3 py-1" onClick={picker.open} title="Columns: Outcome (SO2, or ECE 420 CLO3), Term, Kind, Course, Method, Sample, At target, Share, Mean, Scale, Response rate">Import sheet</Button>
        </form>
      )}
    </div>
  );
}

// ---- Corrective actions --------------------------------------------------------------------------------------------------------------

function ActionsTab({ api, programId, actions, results, gaps, outcomes, canWrite }: {
  api: AssessmentApi; programId: string; actions: CorrectiveAction[]; results: OutcomeResult[]; gaps: { resultId: string; outcomeId: string; term: string }[]; outcomes: ProgramOutcomes; canWrite: boolean;
}) {
  const { run, error } = useRun(api, programId);
  const [draft, setDraft] = useState<{ resultId: string | null; outcomeId: string | null; gap: string } | null>(null);
  const [f, setF] = useState({ rootCause: '', action: '', owner: '', implementIn: '', verificationPlan: '' });
  const gapText = (g: { resultId: string; outcomeId: string; term: string }) => {
    const r = results.find((x) => x.id === g.resultId);
    const share = r ? shareOf(r) : null;
    return `${outcomeLabel(outcomes, g.outcomeId)} ${g.term}: ${share !== null ? `${share}% of students at target` : `mean ${r?.meanScore ?? '—'}`} (target ${r?.target ?? '—'})`;
  };
  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {gaps.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">
          <p className="font-medium">Below target, no action yet (IE-001: the cycle is incomplete without one)</p>
          <ul className="mt-1 space-y-1">{gaps.map((g) => (
            <li key={g.resultId} className="flex flex-wrap items-center gap-2">{gapText(g)}{canWrite && <Button type="button" variant="outline" className="px-2 py-0.5 text-xs" onClick={() => setDraft({ resultId: g.resultId, outcomeId: g.outcomeId, gap: gapText(g) })}>Start action</Button>}</li>
          ))}</ul>
        </div>
      )}
      {canWrite && !draft && <Button type="button" variant="outline" className="px-3 py-1" onClick={() => setDraft({ resultId: null, outcomeId: null, gap: '' })}>Add action</Button>}
      {draft && (
        <form className="grid gap-2 rounded border border-border p-2 sm:grid-cols-2" aria-label="Corrective action" onSubmit={(e) => {
          e.preventDefault();
          if (!draft.gap.trim()) return;
          run(() => api.addAction(programId, { ...f, gap: draft.gap, resultId: draft.resultId, outcomeId: draft.outcomeId }));
          setDraft(null); setF({ rootCause: '', action: '', owner: '', implementIn: '', verificationPlan: '' });
        }}>
          <Input aria-label="Gap" className="sm:col-span-2" placeholder="The gap: who, how far below target" value={draft.gap} onChange={(e) => setDraft({ ...draft, gap: e.target.value })} required />
          <Input aria-label="Root cause" className="sm:col-span-2" placeholder="Root cause analysis" value={f.rootCause} onChange={(e) => setF({ ...f, rootCause: e.target.value })} />
          <Input aria-label="Action" className="sm:col-span-2" placeholder="What changes, where, when" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} />
          <Input aria-label="Owner" placeholder="Owner" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} />
          <Input aria-label="Implement in" placeholder="Fall 2026" value={f.implementIn} onChange={(e) => setF({ ...f, implementIn: e.target.value })} />
          <Input aria-label="Verification plan" className="sm:col-span-2" placeholder="How and when the outcome is re-assessed" value={f.verificationPlan} onChange={(e) => setF({ ...f, verificationPlan: e.target.value })} />
          <div className="flex gap-2"><Button type="submit">Save action</Button><Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button></div>
        </form>
      )}
      {actions.length === 0 ? <p className="text-sm text-muted-foreground">No corrective actions yet.</p> : (
        <ul className="divide-y divide-border rounded border border-border" aria-label="Corrective actions">
          {actions.map((a) => (
            <li key={a.id} className="space-y-1 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {a.outcomeId && <span className="font-mono font-semibold">{outcomeLabel(outcomes, a.outcomeId)}</span>}
                <ContentText className="min-w-0 flex-1">{a.gap}</ContentText>
                {canWrite ? (
                  <select aria-label={`Status of action on ${a.outcomeId ? outcomeLabel(outcomes, a.outcomeId) : 'gap'}`} className={select} value={a.status}
                    onChange={(e) => { const s = e.target.value as CorrectiveAction['status']; const later = results.find((r) => r.outcomeId === a.outcomeId && r.id !== a.resultId); run(() => api.updateAction(a.id, { status: s, ...((s === 'verified' || s === 'not_effective') && !a.verifiedResultId && later ? { verifiedResultId: later.id } : {}) })); }}>
                    {ACTION_STATUSES.map((s) => <option key={s} value={s}>{ACTION_STATUS[s]}</option>)}
                  </select>
                ) : <span className="rounded bg-muted px-2 py-0.5 text-xs">{ACTION_STATUS[a.status]}</span>}
              </div>
              <p className="text-xs text-muted-foreground">{[a.rootCause && `Cause: ${a.rootCause}`, a.action && `Action: ${a.action}`, a.owner && `Owner: ${a.owner}`, a.implementIn && `In: ${a.implementIn}`, a.verificationPlan && `Verify: ${a.verificationPlan}`].filter(Boolean).join(' · ')}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
