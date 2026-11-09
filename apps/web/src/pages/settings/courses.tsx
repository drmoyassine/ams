import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COURSE_ROLES, type Course, type CreateCourse, type Program } from '@ams/shared';
import { OutcomeList, patchOf } from '../../components/outcomes/outcome-list';
import { ContentText } from '../../components/content-text';
import { ReadOnlyNote } from '../../components/read-only-note';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useConfirm } from '../../components/confirm-dialog';
import { SyllabusLimits } from '../../components/syllabus/syllabus-limits';
import { Link } from '@tanstack/react-router';
import { can, useMe } from '../../lib/me';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
const ROLE = { core: 'Core', elective: 'Elective', service: 'Service' } as const;
const num = (s: string) => (s.trim() === '' ? null : Number(s));

function CourseForm({ initial, units, submitLabel, onSubmit, onCancel }: {
  initial?: Course; units: { id: string; nameEn: string; active: boolean }[]; submitLabel: string; onSubmit: (v: CreateCourse) => void; onCancel: () => void;
}) {
  const [v, setV] = useState({
    code: initial?.code ?? '', titleEn: initial?.titleEn ?? '', titleAr: initial?.titleAr ?? '', orgUnitId: initial?.orgUnitId ?? '', externalId: initial?.externalId ?? '',
    credits: initial?.credits?.toString() ?? '', level: initial?.level?.toString() ?? '', description: initial?.description ?? '',
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const field = 'flex flex-col gap-1 text-xs';
  return (
    <form className="grid gap-2 sm:grid-cols-6" aria-label={submitLabel} onSubmit={(e) => {
      e.preventDefault();
      if (!v.code.trim() || !v.titleEn.trim()) return;
      onSubmit({ code: v.code, titleEn: v.titleEn, titleAr: v.titleAr || null, orgUnitId: v.orgUnitId || null, externalId: v.externalId || null, credits: num(v.credits), level: num(v.level), description: v.description || null });
    }}>
      <label className={`${field} sm:col-span-1`}>Code<Input aria-label="Course code" value={v.code} placeholder="ECE 420" onChange={set('code')} required /></label>
      <label className={`${field} sm:col-span-3`}>Title (English)<Input aria-label="Course title" value={v.titleEn} onChange={set('titleEn')} required /></label>
      <label className={`${field} sm:col-span-2`}>Title (Arabic)<Input aria-label="Course title (Arabic)" dir="auto" value={v.titleAr} onChange={set('titleAr')} /></label>
      <label className={`${field} sm:col-span-2`}>Owning unit
        <select aria-label="Owning unit" className={select} value={v.orgUnitId} onChange={set('orgUnitId')}>
          <option value="">The institution</option>
          {units.filter((u) => u.active || u.id === initial?.orgUnitId).map((u) => <option key={u.id} value={u.id}>{u.nameEn}</option>)}
        </select>
      </label>
      <label className={`${field} sm:col-span-1`}>Credits<Input aria-label="Credits" inputMode="decimal" value={v.credits} onChange={set('credits')} /></label>
      <label className={`${field} sm:col-span-1`}>Year of study<Input aria-label="Year of study" inputMode="numeric" value={v.level} onChange={set('level')} /></label>
      <label className={`${field} sm:col-span-2`}>Student-system id<Input aria-label="Course student-system id" value={v.externalId} onChange={set('externalId')} /></label>
      <label className={`${field} sm:col-span-6`}>Description<Input aria-label="Course description" value={v.description} onChange={set('description')} /></label>
      <div className="flex flex-wrap gap-2 sm:col-span-6">
        <Button type="submit" disabled={!v.code.trim() || !v.titleEn.trim()}>{submitLabel}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/** Settings -> Organization -> Courses (TASK-105): the course catalogue, the programs each course serves, and its CLOs. */
export function CoursesSettingsPage({ api: settingsOverride, outcomes: outcomesOverride }: { api?: SettingsApi; outcomes?: OutcomesApi }) {
  const api = useSettingsApi(settingsOverride);
  const oapi = useOutcomesApi(outcomesOverride);
  const qc = useQueryClient();
  const me = useMe(api);
  const canWrite = can(me.data, 'program:write');
  const canLimits = can(me.data, 'org:write');
  const courses = useQuery({ queryKey: ['courses'], queryFn: () => oapi.courses() });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.orgUnits() });
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.programs() });
  const [q, setQ] = useState('');
  const [programFilter, setProgramFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['courses'] }); void qc.invalidateQueries({ queryKey: ['program-outcomes'] }); } });
  const unitName = new Map((units.data ?? []).map((u) => [u.id, u.nameEn]));
  const progName = new Map((programs.data ?? []).map((p) => [p.id, p.nameEn]));
  const needle = q.trim().toLowerCase();
  const rows = (courses.data ?? []).filter((c) => (!needle || `${c.code} ${c.titleEn} ${c.titleAr ?? ''}`.toLowerCase().includes(needle)) && (!programFilter || c.programIds.includes(programFilter)));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="text-lg font-semibold">Courses</h3><ReadOnlyNote show={!!me.data && !canWrite} /></div>
        {canWrite && <Button type="button" onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add course'}</Button>}
      </div>
      <SyllabusLimits canWrite={canLimits} />
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Search courses" placeholder="Search by code or title" className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Filter by program" className={select} value={programFilter} onChange={(e) => setProgramFilter(e.target.value)}>
          <option value="">All programs</option>
          {(programs.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.nameEn}</option>)}
        </select>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {adding && canWrite && <Card aria-label="Add course"><CourseForm units={units.data ?? []} submitLabel="Add course" onCancel={() => setAdding(false)} onSubmit={(v) => { run.mutate(() => oapi.createCourse(v)); setAdding(false); }} /></Card>}
      {courses.data && rows.length === 0 && <p className="text-muted-foreground">{courses.data.length ? 'No course matches.' : 'No courses yet.'}</p>}
      <ul className="divide-y divide-border rounded-lg border border-border empty:hidden" aria-label="Courses">
        {rows.map((c) => (
          <li key={c.id} className="px-4 py-3" data-testid="course">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="min-w-0 flex-1 text-start" aria-expanded={open === c.id} aria-label={`${c.code} ${c.titleEn}`} onClick={() => setOpen(open === c.id ? null : c.id)}>
                <span className="font-mono font-semibold">{c.code}</span> <ContentText className="font-medium">{c.titleEn}</ContentText>
                {c.titleAr && <ContentText className="ms-2 text-sm text-muted-foreground">{c.titleAr}</ContentText>}
                <span className="block text-xs text-muted-foreground">
                  {[c.orgUnitId ? unitName.get(c.orgUnitId) : null, c.credits !== null ? `${c.credits} credits` : null, c.level !== null ? `year ${c.level}` : null,
                    `${c.cloCount} CLO${c.cloCount === 1 ? '' : 's'}`, c.programIds.length ? c.programIds.map((p) => progName.get(p) ?? '…').join(', ') : 'no program'].filter(Boolean).join(' · ')}
                </span>
              </button>
              {!c.active && <span className="rounded border border-border px-2 py-0.5 text-xs">Inactive</span>}
            </div>
            {open === c.id && <CourseDetail course={c} units={units.data ?? []} programs={programs.data ?? []} canWrite={canWrite} oapi={oapi} run={(fn) => run.mutate(fn)} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CourseDetail({ course, units, programs, canWrite, oapi, run }: {
  course: Course; units: { id: string; nameEn: string; active: boolean }[]; programs: Program[]; canWrite: boolean; oapi: OutcomesApi; run: (fn: () => Promise<unknown>) => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [addProgram, setAddProgram] = useState({ programId: '', role: 'core', year: '', term: '' });
  const clos = useQuery({ queryKey: ['course-outcomes', course.id], queryFn: () => oapi.courseOutcomes(course.id) });
  const runClos = (fn: () => Promise<unknown>) => run(async () => { await fn(); await qc.invalidateQueries({ queryKey: ['course-outcomes', course.id] }); });
  const progName = new Map(programs.map((p) => [p.id, p.nameEn]));
  return (
    <div className="mt-3 space-y-4 border-s-2 border-border ps-3">
      {editing && canWrite
        ? <CourseForm initial={course} units={units} submitLabel="Save course" onCancel={() => setEditing(false)} onSubmit={(v) => { run(() => oapi.updateCourse(course.id, v)); setEditing(false); }} />
        : (
          <div className="space-y-1 text-sm">
            {course.description && <ContentText className="block">{course.description}</ContentText>}
            {course.externalId && <p className="text-xs text-muted-foreground">Student-system id: {course.externalId}</p>}
            <div className="flex flex-wrap gap-2">
              <Link to="/courses/$id/syllabus" params={{ id: course.id }} className="inline-flex items-center rounded-md border border-border px-3 py-1 text-sm hover:bg-muted">Syllabus</Link>
            {canWrite && (
              <>
                <Button type="button" variant="outline" className="px-3 py-1" onClick={() => setEditing(true)}>Edit course</Button>
                <Button type="button" variant="ghost" className="px-3 py-1" onClick={() => run(() => oapi.updateCourse(course.id, { active: !course.active }))}>{course.active ? 'Deactivate' : 'Reactivate'}</Button>
              </>
            )}
            </div>
          </div>
        )}
      <section aria-label="Programs it serves" className="space-y-2">
        <h4 className="font-semibold">Programs it serves</h4>
        {course.programIds.length === 0 && <p className="text-sm text-muted-foreground">Not in any program yet.</p>}
        <ul className="flex flex-wrap gap-2">
          {course.programIds.map((p) => (
            <li key={p} className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs">
              {progName.get(p) ?? 'A program you cannot see'}
              {canWrite && <button type="button" aria-label={`Remove from ${progName.get(p) ?? 'program'}`} className="text-muted-foreground" onClick={() => {
                void confirm({ title: 'Take the course out of the program?', message: 'Its CLOs\' links to that program\'s PLOs are removed with it.', confirmLabel: 'Remove', tone: 'danger' })
                  .then((ok) => { if (ok) run(() => oapi.removeCourseProgram(course.id, p)); });
              }}>×</button>}
            </li>
          ))}
        </ul>
        {canWrite && (
          <form className="flex flex-wrap items-end gap-2" aria-label="Add to a program" onSubmit={(e) => {
            e.preventDefault();
            if (!addProgram.programId) return;
            run(() => oapi.setCourseProgram(course.id, addProgram.programId, { role: addProgram.role as (typeof COURSE_ROLES)[number], year: num(addProgram.year), term: num(addProgram.term) }));
            setAddProgram({ programId: '', role: 'core', year: '', term: '' });
          }}>
            <select aria-label="Program" className={select} value={addProgram.programId} onChange={(e) => setAddProgram({ ...addProgram, programId: e.target.value })}>
              <option value="">Add to a program…</option>
              {programs.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.nameEn}</option>)}
            </select>
            <select aria-label="Role in the program" className={select} value={addProgram.role} onChange={(e) => setAddProgram({ ...addProgram, role: e.target.value })}>
              {COURSE_ROLES.map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}
            </select>
            <Input aria-label="Year in the program" className="w-20" placeholder="Year" value={addProgram.year} onChange={(e) => setAddProgram({ ...addProgram, year: e.target.value })} />
            <Input aria-label="Term in the program" className="w-20" placeholder="Term" value={addProgram.term} onChange={(e) => setAddProgram({ ...addProgram, term: e.target.value })} />
            <Button type="submit" variant="outline" className="px-3 py-1" disabled={!addProgram.programId}>Add</Button>
          </form>
        )}
      </section>
      <OutcomeList title="Course learning outcomes" label="CLO" items={clos.data ?? []} canWrite={canWrite} codeHint="CLO1" withBloom
        onAdd={(d) => runClos(() => oapi.createOutcome({ kind: 'clo', courseId: course.id, ...patchOf(d), code: d.code, textEn: d.textEn }))}
        onSave={(id, d) => runClos(() => oapi.updateOutcome(id, patchOf(d)))}
        onDelete={(o) => { void confirm({ title: `Delete ${o.code}?`, message: 'The draft and its links to PLOs are deleted.', confirmLabel: 'Delete', tone: 'danger' }).then((ok) => { if (ok) runClos(() => oapi.deleteOutcome(o.id)); }); }} />
    </div>
  );
}
