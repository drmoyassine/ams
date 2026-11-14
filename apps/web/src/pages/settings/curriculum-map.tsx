import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProgramOutcomes } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { ReadOnlyNote } from '../../components/read-only-note';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { can, useMe } from '../../lib/me';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';

const select = 'min-w-0 max-w-full rounded-md border border-border bg-background px-2 py-1 text-sm';
const COVERAGE_TITLE = {
  plo_unmapped: 'PLO with no course', plo_no_mastery: 'PLO never mastered', course_unmapped: 'Course mapped to no PLO',
  clo_unmapped: 'CLO mapped to no PLO', plo_no_ilo: 'PLO with no ILO', link_no_level: 'Link without a level',
  course_map_no_clo: 'Mapped course with no CLO', level_mismatch: 'Levels differ', course_plo_count: 'PLOs per course', course_clo_count: 'CLOs per course',
} as const;

type Run = (fn: () => Promise<unknown>) => void;
type Cell = ProgramOutcomes['map'][number];

/**
 * Settings -> Organization -> Curriculum map (DEC-039): pick a program and build its map either way. Top-down, a course is mapped to a
 * PLO at one level (no CLOs needed); bottom-up, a course's CLOs are linked to the PLO at a level and fill the cell. Coverage flags a course
 * mapped top-down with no CLO behind it, levels that differ, a course mapped to no PLO and the syllabus rules' limits. Nothing is blocked.
 */
export function CurriculumMapPage({ api: override, outcomes }: { api?: SettingsApi; outcomes?: OutcomesApi }) {
  const api = useSettingsApi(override);
  const oapi = useOutcomesApi(outcomes);
  const qc = useQueryClient();
  const me = useMe(api);
  const canWrite = can(me.data, 'program:write');
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.programs() });
  const active = (programs.data ?? []).filter((p) => p.active).sort((a, b) => a.nameEn.localeCompare(b.nameEn));
  const [picked, setPicked] = useState('');
  const programId = picked || active[0]?.id || '';
  const key = ['program-outcomes', programId];
  const data = useQuery({ queryKey: key, queryFn: () => oapi.programOutcomes(programId), enabled: !!programId });
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const mutation = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['courses'] }); },
  });
  const run: Run = (fn) => mutation.mutate(fn);
  const [view, setView] = useState<'course' | 'plo'>('course');
  const v = data.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold">Curriculum map</h3>
          <p className="text-sm text-muted-foreground">Map a course to a PLO directly (top-down), or link its CLOs to the PLO (bottom-up). Both fill the same map.</p>
          <ReadOnlyNote show={!!me.data && !canWrite} />
        </div>
        <label className="flex min-w-0 flex-col gap-1 text-xs">Program
          <select aria-label="Program" className={`${select} w-full sm:w-80`} value={programId} onChange={(e) => setPicked(e.target.value)}>
            {active.length === 0 && <option value="">No programs yet</option>}
            {active.map((p) => <option key={p.id} value={p.id}>{p.code ? `${p.code} · ` : ''}{p.nameEn}</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {!programId ? <p className="text-sm text-muted-foreground">{programs.isError ? 'Could not load programs.' : programs.data ? 'Add a program first.' : 'Loading…'}</p>
        : !v ? <p className="text-sm text-muted-foreground">{data.isError ? 'Could not load the map.' : 'Loading…'}</p> : (
          <>
            <Card>
              <div role="tablist" aria-label="Map view" className="mb-3 flex gap-1">
                {([['course', 'By course'], ['plo', 'By PLO']] as const).map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
                    className={`rounded-md px-3 py-1 text-sm ${view === id ? 'bg-muted font-medium' : 'text-muted-foreground'}`}>{label}</button>
                ))}
              </div>
              {view === 'course' ? <CurriculumMap v={v} canWrite={canWrite} api={oapi} run={run} /> : <ByPlo v={v} canWrite={canWrite} api={oapi} run={run} />}
            </Card>
            <Card><Coverage v={v} /></Card>
          </>
        )}
    </div>
  );
}

const levelNames = (v: ProgramOutcomes) => new Map(v.levels.map((l) => [l.code, l.name]));

/** How a cell reads: the level, how it was set, and whether it needs attention (a top-down level with no CLO, or levels that differ). */
function describe(v: ProgramOutcomes, m: Cell | undefined, hasLinks: boolean) {
  const name = levelNames(v);
  if (!m) return { text: '·', label: 'not mapped', warn: false, from: 'none' as const };
  if (m.topDown) {
    if (!hasLinks) return { text: m.topDown, label: `${name.get(m.topDown)} (course), no CLO`, warn: true, from: 'top' as const };
    if (m.highest && m.highest !== m.topDown) return { text: `${m.topDown}/${m.highest}`, label: `${name.get(m.topDown)} (course), CLOs reach ${name.get(m.highest)}`, warn: true, from: 'both' as const };
    return { text: m.topDown, label: name.get(m.topDown) ?? m.topDown, warn: false, from: 'both' as const };
  }
  if (m.highest) return { text: m.highest, label: name.get(m.highest) ?? m.highest, warn: false, from: 'clo' as const };
  return { text: '✓', label: 'linked, no level', warn: false, from: 'clo' as const };
}

/** PLO x course. A cell opens the course's level for that PLO (top-down) and its CLOs' links to it (bottom-up). */
export function CurriculumMap({ v, canWrite, api, run }: { v: ProgramOutcomes; canWrite: boolean; api: OutcomesApi; run: Run }) {
  const [cell, setCell] = useState<{ ploId: string; courseId: string } | null>(null);
  const [adding, setAdding] = useState('');
  const all = useQuery({ queryKey: ['courses'], queryFn: () => api.courses(), enabled: canWrite });
  const at = (ploId: string, courseId: string) => v.map.find((m) => m.ploId === ploId && m.courseId === courseId);
  const cloIds = (courseId: string) => new Set(v.courses.find((c) => c.courseId === courseId)?.clos.map((o) => o.id));
  const hasLinks = (ploId: string, courseId: string) => { const ids = cloIds(courseId); return v.links.some((l) => l.toId === ploId && ids.has(l.fromId)); };
  const plos = v.plos.filter((p) => p.status !== 'retired');
  return (
    <section aria-label="Curriculum map" className="space-y-3">
      <Legend v={v} />
      {v.courses.length === 0 ? <p className="text-sm text-muted-foreground">No courses in this program yet.</p> : plos.length === 0 ? <p className="text-sm text-muted-foreground">Add PLOs to the program to map its courses to.</p> : (
        <div className="overflow-x-auto">
          <table className="text-sm" aria-label="PLO by course">
            <thead>
              <tr><th className="sticky start-0 bg-background px-2 py-1 text-start">Course</th>{plos.map((p) => <th key={p.id} className="px-2 py-1 font-mono text-xs" title={p.textEn}>{p.code}</th>)}</tr>
            </thead>
            <tbody>
              {v.courses.map((c) => (
                <tr key={c.courseId} className="border-t border-border">
                  <th scope="row" className="sticky start-0 bg-background px-2 py-1 text-start font-normal">
                    <span className="font-mono">{c.code}</span> <span className="text-xs text-muted-foreground">{c.role !== 'core' ? c.role : ''}{c.year ? ` Y${c.year}` : ''}{c.term ? `T${c.term}` : ''}</span>
                  </th>
                  {plos.map((p) => {
                    const d = describe(v, at(p.id, c.courseId), hasLinks(p.id, c.courseId));
                    const tone = d.warn ? 'bg-amber-100 font-semibold text-amber-900' : d.from === 'both' || d.from === 'top' ? 'bg-primary/15 font-semibold' : d.from === 'clo' ? 'bg-primary/5 italic' : 'text-muted-foreground';
                    return (
                      <td key={p.id} className="px-1 py-0.5 text-center">
                        <button type="button" aria-label={`${c.code} ${p.code}: ${d.label}`} title={d.label}
                          className={`min-w-8 rounded px-1 ${tone} ${cell?.ploId === p.id && cell.courseId === c.courseId ? 'ring-2 ring-primary' : ''}`}
                          onClick={() => setCell({ ploId: p.id, courseId: c.courseId })}>{d.text}{d.warn ? '!' : ''}</button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cell && <CellPanel v={v} ploId={cell.ploId} courseId={cell.courseId} canWrite={canWrite} api={api} run={run} onClose={() => setCell(null)} />}
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

function Legend({ v }: { v: ProgramOutcomes }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>{v.levels.map((l) => `${l.code} ${l.name}${l.mastery ? ' (mastery)' : ''}`).join(' · ')}</span>
      <span><span className="rounded bg-primary/15 px-1 font-semibold text-foreground">M</span> mapped to the course</span>
      <span><span className="rounded bg-primary/5 px-1 italic text-foreground">M</span> from its CLOs only</span>
      <span><span className="rounded bg-amber-100 px-1 font-semibold text-amber-900">M!</span> needs attention</span>
    </div>
  );
}

/** One course and one PLO: the course's level for it (top-down) and the CLOs that deliver it (bottom-up). */
function CellPanel({ v, ploId, courseId, canWrite, api, run, onClose }: { v: ProgramOutcomes; ploId: string; courseId: string; canWrite: boolean; api: OutcomesApi; run: Run; onClose: () => void }) {
  const plo = v.plos.find((p) => p.id === ploId);
  const course = v.courses.find((c) => c.courseId === courseId);
  if (!plo || !course) return null;
  const m = v.map.find((x) => x.ploId === ploId && x.courseId === courseId);
  return (
    <div className="space-y-3 rounded-lg border border-border p-3" aria-label={`${course.code} to ${plo.code}`} role="group">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm"><span className="font-mono font-semibold">{course.code}</span> → <span className="font-mono font-semibold">{plo.code}</span> <ContentText className="text-muted-foreground">{plo.textEn}</ContentText></p>
        <Button type="button" variant="ghost" className="px-2 py-1" onClick={onClose}>Close</Button>
      </div>
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Course level (top-down)</span>
        <select aria-label={`${course.code} level for ${plo.code}`} className={select} value={m?.topDown ?? ''} disabled={!canWrite}
          onChange={(e) => { const level = e.target.value || null; run(() => api.setCourseMap({ courseId, outcomeId: ploId, level })); }}>
          <option value="">Not mapped</option>
          {v.levels.map((l) => <option key={l.code} value={l.code}>{l.code} {l.name}</option>)}
        </select>
      </label>
      <div className="space-y-1">
        <p className="text-sm font-medium">CLOs that deliver it (bottom-up)</p>
        {course.clos.length === 0 && <p className="text-sm text-muted-foreground">This course has no CLOs yet (add them on the Courses tab or in its syllabus).</p>}
        <ul className="space-y-1">
          {course.clos.map((clo) => {
            const link = v.links.find((l) => l.fromId === clo.id && l.toId === ploId);
            const value = !link ? '' : (link.level ?? '-');
            return (
              <li key={clo.id} className="flex flex-wrap items-center gap-2 text-sm">
                <select aria-label={`${clo.code} level for ${plo.code}`} className={select} value={value} disabled={!canWrite}
                  onChange={(e) => { const to = e.target.value; run(() => (to === '' ? api.removeLink(clo.id, ploId) : api.setLink({ fromId: clo.id, toId: ploId, level: to === '-' ? null : to }))); }}>
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
    </div>
  );
}

/** PLO first (top-down): each PLO, the courses mapped to it and their CLOs; a course is added to a PLO at a level here. */
function ByPlo({ v, canWrite, api, run }: { v: ProgramOutcomes; canWrite: boolean; api: OutcomesApi; run: Run }) {
  const [open, setOpen] = useState<{ ploId: string; courseId: string } | null>(null);
  const plos = v.plos.filter((p) => p.status !== 'retired');
  const name = levelNames(v);
  if (!plos.length) return <p className="text-sm text-muted-foreground">Add PLOs to the program to map its courses to.</p>;
  return (
    <section aria-label="Map by PLO" className="space-y-3">
      {plos.map((p) => {
        const cells = v.map.filter((m) => m.ploId === p.id);
        const rest = v.courses.filter((c) => !cells.some((m) => m.courseId === c.courseId));
        return (
          <div key={p.id} className="space-y-2 rounded-lg border border-border p-3" role="group" aria-label={`${p.code} courses`}>
            <p className="text-sm"><span className="font-mono font-semibold">{p.code}</span> <ContentText>{p.textEn}</ContentText></p>
            {cells.length === 0 && <p className="text-sm text-muted-foreground">No course mapped yet.</p>}
            <ul className="space-y-1">
              {cells.map((m) => {
                const c = v.courses.find((x) => x.courseId === m.courseId)!;
                const linked = c.clos.filter((o) => v.links.some((l) => l.fromId === o.id && l.toId === p.id));
                const d = describe(v, m, linked.length > 0);
                return (
                  <li key={m.courseId} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="min-w-20 font-mono">{c.code}</span>
                    <select aria-label={`${c.code} level for ${p.code} (by PLO)`} className={select} value={m.topDown ?? ''} disabled={!canWrite}
                      onChange={(e) => { const level = e.target.value || null; run(() => api.setCourseMap({ courseId: c.courseId, outcomeId: p.id, level })); }}>
                      <option value="">{m.highest ? `From CLOs (${name.get(m.highest)})` : 'Not mapped'}</option>
                      {v.levels.map((l) => <option key={l.code} value={l.code}>{l.code} {l.name}</option>)}
                    </select>
                    <span className="text-xs text-muted-foreground">CLOs: {linked.length ? linked.map((o) => o.code).join(', ') : 'none'}</span>
                    {d.warn && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">{d.label}</span>}
                    <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => setOpen({ ploId: p.id, courseId: c.courseId })}>Link CLOs</Button>
                  </li>
                );
              })}
            </ul>
            {canWrite && rest.length > 0 && <AddCourseToPlo v={v} ploCode={p.code} courses={rest} onAdd={(courseId, level) => run(() => api.setCourseMap({ courseId, outcomeId: p.id, level }))} />}
            {open?.ploId === p.id && <CellPanel v={v} ploId={p.id} courseId={open.courseId} canWrite={canWrite} api={api} run={run} onClose={() => setOpen(null)} />}
          </div>
        );
      })}
    </section>
  );
}

function AddCourseToPlo({ v, ploCode, courses, onAdd }: { v: ProgramOutcomes; ploCode: string; courses: ProgramOutcomes['courses']; onAdd: (courseId: string, level: string) => void }) {
  const [courseId, setCourseId] = useState('');
  const [level, setLevel] = useState(v.levels[0]?.code ?? '');
  return (
    <form className="flex flex-wrap gap-2" aria-label={`Map a course to ${ploCode}`} onSubmit={(e) => { e.preventDefault(); if (courseId && level) { onAdd(courseId, level); setCourseId(''); } }}>
      <select aria-label={`Course for ${ploCode}`} className={select} value={courseId} onChange={(e) => setCourseId(e.target.value)}>
        <option value="">Map a course…</option>
        {courses.map((c) => <option key={c.courseId} value={c.courseId}>{c.code} {c.titleEn}</option>)}
      </select>
      <select aria-label={`Level for ${ploCode}`} className={select} value={level} onChange={(e) => setLevel(e.target.value)}>
        {v.levels.map((l) => <option key={l.code} value={l.code}>{l.code} {l.name}</option>)}
      </select>
      <Button type="submit" variant="outline" className="px-3 py-1" disabled={!courseId}>Map</Button>
    </form>
  );
}

export function Coverage({ v }: { v: ProgramOutcomes }) {
  return (
    <section aria-label="Coverage" className="space-y-2">
      <h4 className="font-semibold">Coverage</h4>
      {v.coverage.length === 0
        ? <p className="text-sm text-emerald-700">{v.plos.length ? 'Every PLO is mapped and reaches mastery; every course maps to a PLO with its CLOs behind it.' : 'Nothing to check yet.'}</p>
        : (
          <ul className="space-y-1 text-sm" aria-label="Coverage issues">
            {v.coverage.map((i, n) => <li key={n}><span className="me-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900">{COVERAGE_TITLE[i.kind]}</span>{i.message}</li>)}
          </ul>
        )}
    </section>
  );
}
