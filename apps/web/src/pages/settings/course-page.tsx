import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BLOCK_LABEL, COURSE_ROLES, REQUIREMENT_BLOCKS, type Course, type Program, type RequirementBlock } from '@ams/shared';
import { Breadcrumb } from '../../components/breadcrumb';
import { COURSE_TABS, CourseContent, type CourseTab } from '../../components/syllabus/course-content';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useConfirm } from '../../components/confirm-dialog';
import { useCatalogApi } from '../../lib/catalog-api';
import { ConcentrationChips } from '../../components/catalog/concentration-chips';
import { can, useMe } from '../../lib/me';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import type { SyllabusApi } from '../../lib/syllabus-api';
import { useAction } from '../../lib/use-action';
import { unitChoices } from './program-page';

export const ROLE = { core: 'Core', elective: 'Elective', service: 'Service' } as const;
const COURSES_HREF = '/settings/organization?tab=courses';
const num = (s: string) => (s.trim() === '' ? null : Number(s));
const field = 'flex min-w-0 flex-col gap-1 text-xs';
const select = 'h-9 w-full min-w-0 max-w-full rounded-md border border-border bg-background px-2 text-sm';
const req = <span className="text-red-700" aria-hidden="true"> *</span>;

/**
 * A course on a page of its own (Settings -> Organization -> Courses -> the course; /settings/organization/courses/<id>, or /new), the master
 * record (DEC-042): its record (code, unit, SIS code, year of study, active) and the programs it serves change at once; its content (titles,
 * credit hours, description, CLOs with their PLOs, outline, assessment plan, rubrics) changes through a draft that is approved, below. The
 * syllabus is the report generated from it.
 */
export function CoursePage({ courseId, api: override, outcomes, syllabus, onSaved, onCancel, tab = 'basic', onTab }: {
  courseId: string | 'new'; api?: SettingsApi; outcomes?: OutcomesApi; syllabus?: SyllabusApi; onSaved: (id: string) => void; onCancel: () => void;
  /** The tab shown (in the address, ?tab=); a page without onTab keeps it here. */
  tab?: CourseTab; onTab?: (tab: CourseTab) => void;
}) {
  const [ownTab, setOwnTab] = useState<CourseTab>(tab);
  const shownTab = onTab ? tab : ownTab;
  const pickTab = (t: CourseTab) => (onTab ? onTab(t) : setOwnTab(t));
  const api = useSettingsApi(override);
  const oapi = useOutcomesApi(outcomes);
  const me = useMe(api);
  const canWrite = can(me.data, 'program:write');
  const courses = useQuery({ queryKey: ['courses'], queryFn: () => oapi.courses() });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.orgUnits() });
  const types = useQuery({ queryKey: ['org-unit-types'], queryFn: () => api.orgUnitTypes() });
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.programs() });
  const isNew = courseId === 'new';
  const course = isNew ? undefined : courses.data?.find((c) => c.id === courseId);
  const choices = unitChoices(units.data ?? [], types.data ?? [], course?.orgUnitId ?? undefined);
  const crumbs = (label: string) => <Breadcrumb items={[{ label: 'Settings', href: '/settings' }, { label: 'Organization', href: '/settings/organization' }, { label: 'Courses', href: COURSES_HREF }, { label }]} />;
  if (isNew) {
    return (
      <div className="space-y-4">
        {crumbs('New course')}
        <h2 className="text-xl font-semibold">New course</h2>
        <NewCourse units={choices} programs={(programs.data ?? []).filter((p) => p.active)} oapi={oapi} canWrite={canWrite} onSaved={onSaved} onCancel={onCancel} />
      </div>
    );
  }
  if (!course) return <p className="text-sm text-muted-foreground">{courses.data ? 'This course is not there, or you may not see it.' : courses.isError ? 'Could not load the course.' : 'Loading…'}</p>;
  return (
    <div className="space-y-4">
      {crumbs(course.code)}
      <h2 className="min-w-0 text-xl font-semibold break-words">{course.code} · {course.titleEn}{!course.active && <span className="ms-2 rounded border border-border px-2 py-0.5 align-middle text-xs font-normal">Inactive</span>}</h2>
      {course.missing.length > 0 && <p role="note" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">This course lacks: {course.missing.join(', ')}.</p>}
      <CourseContent courseId={course.id} {...(syllabus ? { api: syllabus } : {})} tab={shownTab}
        // The description's second language is shown when a program the course serves teaches in Arabic or in both languages.
        secondLanguage={(programs.data ?? []).some((p) => course.programIds.includes(p.id) && /arabic|bilingual/i.test(p.languageOfInstruction ?? ''))}
        tabBar={
          <div role="tablist" aria-label="Course" className="flex gap-1 overflow-x-auto border-b border-border">
            {COURSE_TABS.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={shownTab === t.key} onClick={() => pickTab(t.key)}
                className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${shownTab === t.key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{t.label}</button>
            ))}
          </div>
        }
        record={(hasContent) => <CourseRecord key={JSON.stringify(course)} course={course} units={choices} oapi={oapi} canWrite={canWrite} hasContent={hasContent} />}
        after={<Placement course={course} programs={programs.data ?? []} oapi={oapi} canWrite={canWrite} />} />
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" onClick={onCancel}>Back to courses</Button>
      </div>
    </div>
  );
}

/** A new course: its record, its starting content (title, credit hours) and the first program it serves (required). */
function NewCourse({ units, programs, oapi, canWrite, onSaved, onCancel }: {
  units: { id: string; label: string }[]; programs: Program[]; oapi: OutcomesApi; canWrite: boolean; onSaved: (id: string) => void; onCancel: () => void;
}) {
  const qc = useQueryClient();
  const [v, setV] = useState({ code: '', titleEn: '', orgUnitId: '', credits: '', level: '', externalId: '', programId: '', role: 'core', year: '', term: '' });
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const REQ: [keyof typeof v, string][] = [['code', 'Course code'], ['titleEn', 'Title'], ['orgUnitId', 'Unit'], ['credits', 'Credit hours'], ['programId', 'A program (its study plan)']];
  const missing = REQ.filter(([k]) => !v[k].trim()).map(([, l]) => l);
  const bad = (k: keyof typeof v) => tried && !v[k].trim();
  const save = async () => {
    setTried(true);
    if (missing.length) { setError(`Fill in: ${missing.join(', ')}.`); return; }
    setSaving(true); setError(null);
    const made = await act(() => oapi.createCourse({ code: v.code.trim(), titleEn: v.titleEn.trim(), orgUnitId: v.orgUnitId, credits: num(v.credits), level: num(v.level), externalId: v.externalId.trim() || null }));
    if (made === undefined) { setSaving(false); return; }
    const id = (made as Course).id;
    await act(() => oapi.setCourseProgram(id, v.programId, { role: v.role as (typeof COURSE_ROLES)[number], year: num(v.year), term: num(v.term) }));
    await qc.invalidateQueries({ queryKey: ['courses'] });
    setSaving(false);
    onSaved(id);
  };
  return (
    <form aria-label="New course" className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (canWrite) void save(); }}>
      <Card>
        <fieldset className="grid min-w-0 gap-3 sm:grid-cols-4" disabled={!canWrite}>
          <legend className="mb-2 text-base font-semibold">The course</legend>
          <label className={field}><span>Course code{req}</span><Input aria-label="Course code" aria-invalid={bad('code')} value={v.code} placeholder="ECE 420" onChange={set('code')} autoFocus /></label>
          <label className={`${field} sm:col-span-3`}><span>Title{req}</span><Input aria-label="Course title" aria-invalid={bad('titleEn')} value={v.titleEn} onChange={set('titleEn')} /></label>
          <label className={`${field} sm:col-span-4`}><span>Unit (the college, school or department that owns it){req}</span>
            <select aria-label="Owning unit" aria-invalid={bad('orgUnitId')} className={select} value={v.orgUnitId} onChange={set('orgUnitId')}>
              <option value="">Choose a unit</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </label>
          <label className={field}><span>Credit hours{req}</span><Input aria-label="Credit hours" aria-invalid={bad('credits')} inputMode="decimal" value={v.credits} onChange={set('credits')} /></label>
          <label className={field}><span>Year of study</span><Input aria-label="Year of study" inputMode="numeric" value={v.level} onChange={set('level')} /></label>
          <label className={`${field} sm:col-span-2`}><span>SIS code (optional)</span><Input aria-label="SIS code" value={v.externalId} onChange={set('externalId')} /></label>
        </fieldset>
      </Card>
      <Card>
        <fieldset className="grid min-w-0 gap-3 sm:grid-cols-4" disabled={!canWrite}>
          <legend className="mb-2 text-base font-semibold">The program it serves</legend>
          <label className={`${field} sm:col-span-2`}><span>Program{req}</span>
            <select aria-label="Program" aria-invalid={bad('programId')} className={select} value={v.programId} onChange={set('programId')}>
              <option value="">Choose a program</option>
              {programs.map((p) => <option key={p.id} value={p.id}>{p.code ? `${p.code} · ` : ''}{p.nameEn}</option>)}
            </select>
          </label>
          <label className={field}><span>Role</span>
            <select aria-label="Role in the program" className={select} value={v.role} onChange={set('role')}>{COURSE_ROLES.map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className={field}><span>Year</span><Input aria-label="Year in the program" value={v.year} onChange={set('year')} /></label>
            <label className={field}><span>Term</span><Input aria-label="Term in the program" value={v.term} onChange={set('term')} /></label>
          </div>
        </fieldset>
      </Card>
      <p className="text-xs text-muted-foreground">Its outcomes, outline, assessment plan and the rest are added on the course's page once it is saved, as a draft that is approved.</p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        {canWrite && <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Add course'}</Button>}
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/**
 * The course record: code, unit, SIS code, year of study and active change at once. The title and credit hours belong to the content: editable
 * here only until the course has approved content, then changed through its draft (Course content).
 */
/** The record's own fields, saved at once. Once the course has content, its title and credit hours are edited there (in the draft), not here. */
function CourseRecord({ course, units, oapi, canWrite, hasContent }: { course: Course; units: { id: string; label: string }[]; oapi: OutcomesApi; canWrite: boolean; hasContent: boolean }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ code: course.code, titleEn: course.titleEn, orgUnitId: course.orgUnitId ?? '', credits: course.credits?.toString() ?? '', level: course.level?.toString() ?? '', externalId: course.externalId ?? '' });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); setSaved(false); return act(fn); }, onSuccess: (r) => { if (r !== undefined) { setSaved(true); void qc.invalidateQueries({ queryKey: ['courses'] }); } } });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => { setSaved(false); setV({ ...v, [k]: e.target.value }); };
  const locked = course.approved || hasContent;
  const missing = [...(!v.code.trim() ? ['Course code'] : []), ...(!locked && !v.titleEn.trim() ? ['Title'] : []), ...(!v.orgUnitId ? ['Unit'] : []), ...(!locked && !v.credits.trim() ? ['Credit hours'] : [])];
  return (
    <div>
      <form aria-label="Course record" className="grid min-w-0 gap-3 sm:grid-cols-4" onSubmit={(e) => {
        e.preventDefault();
        if (missing.length) { setError(`Fill in: ${missing.join(', ')}.`); return; }
        run.mutate(() => oapi.updateCourse(course.id, {
          code: v.code.trim(), orgUnitId: v.orgUnitId, externalId: v.externalId.trim() || null, level: num(v.level),
          ...(locked ? {} : { titleEn: v.titleEn.trim(), credits: num(v.credits) }),
        }));
      }}>
        <fieldset className="contents" disabled={!canWrite}>
          <label className={field}><span>Course code{req}</span><Input aria-label="Course code" value={v.code} onChange={set('code')} /></label>
          {!locked && <label className={`${field} sm:col-span-3`}><span>Title{req}</span><Input aria-label="Course title" value={v.titleEn} onChange={set('titleEn')} /></label>}
          <label className={`${field} sm:col-span-4`}><span>Unit{req}</span>
            <select aria-label="Owning unit" className={select} value={v.orgUnitId} onChange={set('orgUnitId')}>
              <option value="">Choose a unit</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </label>
          {!locked && <label className={field}><span>Credit hours{req}</span><Input aria-label="Credit hours" inputMode="decimal" value={v.credits} onChange={set('credits')} /></label>}
          <label className={field}><span>Year of study</span><Input aria-label="Year of study" inputMode="numeric" value={v.level} onChange={set('level')} /></label>
          <label className={`${field} sm:col-span-2`}><span>SIS code (optional)</span><Input aria-label="SIS code" value={v.externalId} onChange={set('externalId')} /></label>
          {locked && <p className="text-xs text-muted-foreground sm:col-span-4">The title, credit hours and the rest of the course information below are its content: they change in a draft, approved by the Dean.</p>}
          {error && <p role="alert" className="text-sm text-red-700 sm:col-span-4">{error}</p>}
          {canWrite && (
            <div className="flex flex-wrap items-center gap-2 sm:col-span-4">
              <Button type="submit" disabled={run.isPending}>Save</Button>
              <Button type="button" variant="ghost" onClick={() => run.mutate(() => oapi.updateCourse(course.id, { active: !course.active }))}>{course.active ? 'Deactivate' : 'Reactivate'}</Button>
              {saved && <span role="status" className="text-sm text-emerald-800">Saved.</span>}
            </div>
          )}
        </fieldset>
      </form>
    </div>
  );
}

/** The programs the course serves (at least one), each with its role, year and term. */
/** The block of a program's requirements a course sits in, and the concentration it is for (DEC-046). */
function PlacementBlock({ course, programId, role, year, term, block, concentrationIds, canWrite, run, oapi }: {
  course: Course; programId: string; role: (typeof COURSE_ROLES)[number]; year: number | null; term: number | null; block: RequirementBlock | null; concentrationIds: string[];
  canWrite: boolean; run: (fn: () => Promise<unknown>) => void; oapi: OutcomesApi;
}) {
  const catalog = useCatalogApi();
  const reqs = useQuery({ queryKey: ['requirements', programId], queryFn: () => catalog.requirements(programId) });
  const concs = (reqs.data?.concentrations ?? []).filter((k) => k.active || concentrationIds.includes(k.id));
  const set = (patch: { block?: RequirementBlock | null; concentrationIds?: string[] }) => run(() => oapi.setCourseProgram(course.id, programId, { role, year, term, ...patch }));
  if (!canWrite) return <span className="text-xs text-muted-foreground">{block ? BLOCK_LABEL[block] : 'No block'}{concentrationIds.length ? ` · ${concentrationIds.map((id) => concs.find((k) => k.id === id)?.nameEn ?? '').join(', ')}` : ''}</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <select aria-label={`Block of ${course.code} in ${programId}`} className={`${select} w-48`} value={block ?? ''} onChange={(e) => set({ block: (e.target.value || null) as RequirementBlock | null })}>
        <option value="">No block</option>{REQUIREMENT_BLOCKS.map((b) => <option key={b} value={b}>{BLOCK_LABEL[b]}</option>)}
      </select>
      {concs.length > 0 && (
        <ConcentrationChips label={`Concentrations of ${course.code} in ${programId}`} all={concs} value={concentrationIds} disabled={false} onChange={(ids) => set({ concentrationIds: ids })} />
      )}
    </span>
  );
}

function Placement({ course, programs, oapi, canWrite }: { course: Course; programs: Program[]; oapi: OutcomesApi; canWrite: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [add, setAdd] = useState({ programId: '', role: 'core', year: '', term: '' });
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['courses'] }); void qc.invalidateQueries({ queryKey: ['program-outcomes'] }); } });
  const name = new Map(programs.map((p) => [p.id, `${p.code ? `${p.code} · ` : ''}${p.nameEn}`]));
  return (
    <Card>
      <section aria-label="Study plan" className="space-y-2">
        <h3 className="text-base font-semibold">Study plan{req}</h3>
        <p className="text-xs text-muted-foreground">The programs this course is part of, with its role, year and term in each.</p>
        {course.programIds.length === 0 && <p className="text-sm text-amber-800">It is in no program&apos;s study plan yet: add one.</p>}
        <ul className="space-y-1 text-sm">
          {course.placements.map(({ programId: id, role, year, term, block, concentrationIds }) => (
            <li key={id} className="flex flex-wrap items-center gap-2">
              <span>{name.get(id) ?? 'A program you may not see'}</span>
              <span className="text-xs text-muted-foreground">{ROLE[role]}{year ? ` · year ${year}` : ''}{term ? `, term ${term}` : ''}</span>
              <PlacementBlock course={course} programId={id} role={role} year={year} term={term} block={block} concentrationIds={concentrationIds} canWrite={canWrite} run={(fn) => run.mutate(fn)} oapi={oapi} />
              {canWrite && <Button type="button" variant="ghost" className="px-2 py-0.5 text-xs" aria-label={`Take ${course.code} out of ${name.get(id) ?? 'the program'}`}
                onClick={() => { void confirm({ title: `Take ${course.code} out of ${name.get(id) ?? 'the program'}?`, message: 'Its CLOs\' links to that program\'s PLOs go with it.', confirmLabel: 'Take it out', tone: 'danger' }).then((ok) => { if (ok) run.mutate(() => oapi.removeCourseProgram(course.id, id)); }); }}>Remove</Button>}
            </li>
          ))}
        </ul>
        {canWrite && (
          <form className="flex flex-wrap items-end gap-2" aria-label="Add to a program" onSubmit={(e) => {
            e.preventDefault();
            if (!add.programId) return;
            run.mutate(() => oapi.setCourseProgram(course.id, add.programId, { role: add.role as (typeof COURSE_ROLES)[number], year: num(add.year), term: num(add.term) }));
            setAdd({ programId: '', role: 'core', year: '', term: '' });
          }}>
            <select aria-label="Program" className={`${select} sm:w-72`} value={add.programId} onChange={(e) => setAdd({ ...add, programId: e.target.value })}>
              <option value="">Add to a program…</option>
              {programs.filter((p) => p.active && !course.programIds.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{name.get(p.id)}</option>)}
            </select>
            <select aria-label="Role in the program" className={`${select} w-32`} value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}>{COURSE_ROLES.map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</select>
            <Input aria-label="Year in the program" className="w-20" placeholder="Year" value={add.year} onChange={(e) => setAdd({ ...add, year: e.target.value })} />
            <Input aria-label="Term in the program" className="w-20" placeholder="Term" value={add.term} onChange={(e) => setAdd({ ...add, term: e.target.value })} />
            <Button type="submit" variant="outline" disabled={!add.programId}>Add</Button>
          </form>
        )}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      </section>
    </Card>
  );
}
