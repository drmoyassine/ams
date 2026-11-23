import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { curriculumMatrix, type CurriculumMatrix, type MappingChange, type ProgramOutcomes } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { ReadOnlyNote } from '../../components/read-only-note';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { can, useMe } from '../../lib/me';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';
import { download, fileNameFor, toXlsx } from '../../lib/sheet-io';
import { useSyllabusApi, type SyllabusApi } from '../../lib/syllabus-api';
import { useConfirm } from '../../components/confirm-dialog';

const select = 'min-w-0 max-w-full rounded-md border border-border bg-background px-2 py-1 text-sm';
const COVERAGE_TITLE = {
  plo_unmapped: 'PLO with no course', plo_no_mastery: 'PLO never mastered', course_unmapped: 'Course mapped to no PLO',
  clo_unmapped: 'CLO mapped to no PLO', plo_no_ilo: 'PLO with no ILO', link_no_level: 'Link without a level',
  course_map_no_clo: 'Mapped course with no CLO', level_mismatch: 'Levels differ', course_plo_count: 'PLOs per course', course_clo_count: 'CLOs per course',
  level_order: 'Out of order',
} as const;

type Run = (fn: () => Promise<unknown>) => void;
type Cell = ProgramOutcomes['map'][number];

/**
 * Settings -> Organization -> Curriculum map (DEC-039): pick a program and build its map either way. Top-down, a course is mapped to a
 * PLO at one level (no CLOs needed); bottom-up, a course's CLOs are linked to the PLO at a level and fill the cell. Coverage flags a course
 * mapped top-down with no CLO behind it, levels that differ, a course mapped to no PLO and the syllabus rules' limits. Nothing is blocked.
 */
export function CurriculumMapPage({ api: override, outcomes, syllabus, program: programProp, view: viewProp, onPick, fixed }: {
  api?: SettingsApi; outcomes?: OutcomesApi; syllabus?: SyllabusApi;
  /** From the address (deep link): the program and the view; `onPick` writes them back. Without them the page keeps its own. */
  program?: string | undefined; view?: 'course' | 'plo' | undefined; onPick?: (p: { program?: string; view?: 'course' | 'plo' }) => void;
  /** On the program's own page: the program is fixed, so there is no program to choose. */
  fixed?: boolean;
}) {
  const api = useSettingsApi(override);
  const oapi = useOutcomesApi(outcomes);
  const qc = useQueryClient();
  const me = useMe(api);
  const canWrite = can(me.data, 'program:write');
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.programs() });
  const active = (programs.data ?? []).filter((p) => p.active || (fixed && p.id === programProp)).sort((a, b) => a.nameEn.localeCompare(b.nameEn));
  const [own, setOwn] = useState('');
  const picked = programProp ?? own;
  const programId = (picked && active.some((p) => p.id === picked) ? picked : '') || active[0]?.id || '';
  const setPicked = (id: string) => { setOwn(id); onPick?.({ program: id, view }); };
  const key = ['program-outcomes', programId];
  const data = useQuery({ queryKey: key, queryFn: () => oapi.programOutcomes(programId), enabled: !!programId });
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const mutation = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['courses'] }); },
  });
  const run: Run = (fn) => mutation.mutate(fn);
  const [ownView, setOwnView] = useState<'course' | 'plo'>('course');
  const view = viewProp ?? ownView;
  const setView = (v: 'course' | 'plo') => { setOwnView(v); onPick?.({ ...(programId ? { program: programId } : {}), view: v }); };
  const mapping = useMapping(programId, syllabus);
  const v = data.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold">Curriculum map</h3>
          <p className="text-sm text-muted-foreground">Map a course to a PLO directly (top-down), or link its CLOs to the PLO (bottom-up). Both fill the same map.</p>
          <ReadOnlyNote show={!!me.data && !canWrite} />
        </div>
        {!fixed && <label className="flex min-w-0 flex-col gap-1 text-xs">Program
          <select aria-label="Program" className={`${select} w-full sm:w-80`} value={programId} onChange={(e) => setPicked(e.target.value)}>
            {active.length === 0 && <option value="">No programs yet</option>}
            {active.map((p) => <option key={p.id} value={p.id}>{p.code ? `${p.code} · ` : ''}{p.nameEn}</option>)}
          </select>
        </label>}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {!programId ? <p className="text-sm text-muted-foreground">{programs.isError ? 'Could not load programs.' : programs.data ? 'Add a program first.' : 'Loading…'}</p>
        : !v ? <p className="text-sm text-muted-foreground">{data.isError ? 'Could not load the map.' : 'Loading…'}</p> : (
          <>
            <PendingBar v={v} mapping={mapping} canWrite={canWrite} />
            <Card>
              <div role="tablist" aria-label="Map view" className="mb-3 flex gap-1">
                {([['course', 'By course'], ['plo', 'By PLO']] as const).map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
                    className={`rounded-md px-3 py-1 text-sm ${view === id ? 'bg-muted font-medium' : 'text-muted-foreground'}`}>{label}</button>
                ))}
              </div>
              {view === 'course' ? <CurriculumMap v={v} canWrite={canWrite} api={oapi} run={run} mapping={mapping} programName={active.find((p) => p.id === programId)?.nameEn ?? 'Program'} /> : <ByPlo v={v} canWrite={canWrite} mapping={mapping} />}
            </Card>
            <Card><Coverage v={v} /></Card>
          </>
        )}
    </div>
  );
}

const levelNames = (v: ProgramOutcomes) => new Map(v.levels.map((l) => [l.code, l.name]));
const rankOf = (v: ProgramOutcomes, code: string | null | undefined) => (code ? v.levels.findIndex((l) => l.code === code) : -1);
type Draft = ProgramOutcomes['drafts'][number];
const draftOf = (v: ProgramOutcomes, courseId: string): Draft | undefined => v.drafts.find((d) => d.courseId === courseId);

/** How a cell reads: the level, how it was set, and whether it needs attention (a top-down level with no CLO, or levels that differ). */
function describe(v: ProgramOutcomes, m: Pick<Cell, 'topDown' | 'highest'> | undefined, hasLinks: boolean) {
  const name = levelNames(v);
  if (!m || (!m.topDown && !m.highest && !hasLinks)) return { text: '·', label: 'not mapped', warn: false, from: 'none' as const };
  if (m.topDown) {
    if (!hasLinks) return { text: m.topDown, label: `${name.get(m.topDown)} (course), no CLO`, warn: true, from: 'top' as const };
    if (m.highest && m.highest !== m.topDown) return { text: `${m.topDown}/${m.highest}`, label: `${name.get(m.topDown)} (course), CLOs reach ${name.get(m.highest)}`, warn: true, from: 'both' as const };
    return { text: m.topDown, label: name.get(m.topDown) ?? m.topDown, warn: false, from: 'both' as const };
  }
  if (m.highest) return { text: m.highest, label: name.get(m.highest) ?? m.highest, warn: false, from: 'clo' as const };
  return { text: '✓', label: 'linked, no level', warn: false, from: 'clo' as const };
}

/** What the course's syllabus draft proposes for one PLO: its own level and the highest its CLOs reach (DEC-039). */
function proposed(v: ProgramOutcomes, d: Draft, ploId: string) {
  const levels = d.clos.flatMap((x) => x.plos.filter((m) => m.ploId === ploId).map((m) => m.level));
  const top = levels.reduce<string | null>((a, b) => (rankOf(v, b) > rankOf(v, a) ? b : a), null);
  return { topDown: d.coverage.find((c) => c.ploId === ploId)?.level || null, highest: top, hasLinks: levels.length > 0 };
}

/** The cell as approved, and as its course's syllabus draft would make it when that differs (a change waiting for approval). */
function cellState(v: ProgramOutcomes, courseId: string, ploId: string) {
  const m = v.map.find((x) => x.ploId === ploId && x.courseId === courseId);
  const ids = new Set(v.courses.find((c) => c.courseId === courseId)?.clos.map((o) => o.id));
  const live = describe(v, m, v.links.some((l) => l.toId === ploId && ids.has(l.fromId)));
  const d = draftOf(v, courseId);
  if (!d) return { live, shown: live, pending: false, draft: undefined };
  const p = proposed(v, d, ploId);
  const next = describe(v, p, p.hasLinks);
  const pending = (m?.topDown ?? null) !== p.topDown || (m?.highest ?? null) !== p.highest || (live.from === 'none') !== (next.from === 'none');
  return { live, shown: pending ? next : live, pending, draft: d };
}

/**
 * Proposing a mapping change (DEC-039): it goes into the course's syllabus draft, never straight to the live map, and is live once that
 * syllabus is approved. Giving a CLO a further PLO beyond what the syllabus rules allow asks whether to move it instead.
 */
export function useMapping(programId: string, override?: SyllabusApi) {
  const sapi = useSyllabusApi(override);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const settings = useQuery({ queryKey: ['syllabus-settings'], queryFn: () => sapi.settings() });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const act = useAction(setError);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['program-outcomes', programId] }); void qc.invalidateQueries({ queryKey: ['syllabi'] }); };
  const send = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); setNotice(null); return act(fn); }, onSuccess: refresh });
  const propose = (courseId: string, change: MappingChange) => send.mutate(() => sapi.proposeMapping({ courseId, change }));
  /** A CLO's level for a PLO; when the CLO already serves as many PLOs as the rules allow, asks to move it. */
  const setCloLevel = async (courseId: string, clo: { id: string; code: string; plos: { ploId: string }[] }, ploId: string, ploCode: string, level: string | null, codeOf: (id: string) => string) => {
    const others = clo.plos.filter((m) => m.ploId !== ploId);
    const max = settings.data?.maxPlosPerClo ?? 1;
    let replace = false;
    if (level && !clo.plos.some((m) => m.ploId === ploId) && others.length >= max) {
      const ok = await confirm({ title: `Move ${clo.code} to ${ploCode}?`, message: `${clo.code} is mapped to ${others.map((m) => codeOf(m.ploId)).join(', ')}. The syllabus rules allow ${max} PLO${max === 1 ? '' : 's'} per CLO, so it moves to ${ploCode}.`, confirmLabel: 'Move it' });
      if (!ok) return;
      replace = true;
    }
    propose(courseId, { kind: 'clo', cloId: clo.id, ploId, level, ...(replace ? { replace } : {}) });
  };
  const submitAll = (versionIds: string[]) => send.mutate(async () => {
    const r = await sapi.submitMany(versionIds);
    setNotice([
      r.submitted.length ? `${r.submitted.length} syllabus${r.submitted.length === 1 ? '' : 'es'} submitted for approval.` : '',
      ...r.refused.map((x) => `${x.courseCode}: ${x.reason}`),
    ].filter(Boolean).join(' '));
    return r;
  });
  return { propose, setCloLevel, submitAll, error, notice, busy: send.isPending };
}
export type Mapping = ReturnType<typeof useMapping>;

/** Courses of the program whose syllabus is in progress: their mapping changes wait for approval; drafts can be submitted at once. */
export function PendingBar({ v, mapping, canWrite }: { v: ProgramOutcomes; mapping: Mapping; canWrite: boolean }) {
  if (!v.drafts.length) return null;
  const code = (id: string) => v.courses.find((c) => c.courseId === id)?.code ?? '';
  const ready = v.drafts.filter((d) => d.status === 'draft');
  return (
    <div role="region" aria-label="Changes waiting for approval" className="space-y-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0">Changes wait in the syllabus of {v.drafts.length} course{v.drafts.length === 1 ? '' : 's'}: they are on the map once approved.</p>
        {canWrite && ready.length > 0 && <Button type="button" className="px-3 py-1" disabled={mapping.busy} onClick={() => mapping.submitAll(ready.map((d) => d.versionId))}>Submit {ready.length === 1 ? 'it' : `all ${ready.length}`} for approval</Button>}
      </div>
      <ul className="flex flex-wrap gap-2">
        {v.drafts.map((d) => (
          <li key={d.versionId}>
            <a className="rounded border border-sky-300 bg-background px-2 py-0.5 text-xs underline-offset-2 hover:underline" href={`/settings/organization/courses/${d.courseId}`}>
              {code(d.courseId)} · v{d.versionNo} {d.status === 'draft' ? 'draft' : d.status === 'in_review' ? 'in review' : 'endorsed'}{d.errorCount ? ` · ${d.errorCount} error${d.errorCount === 1 ? '' : 's'}` : ''}
            </a>
          </li>
        ))}
      </ul>
      {mapping.notice && <p role="status" className="text-xs">{mapping.notice}</p>}
    </div>
  );
}

/**
 * The curriculum map (DEC-039): courses by study year down the side, the program's PLOs and then the institution's ILOs across. A PLO
 * cell opens the course's own level for it (top-down) and its CLOs' links (bottom-up); a change goes into the course's syllabus draft and
 * shows as waiting until approved. An ILO cell is derived through the PLOs linked to that ILO. A totals row counts the courses at each
 * level (as approved); the map downloads as a workbook.
 */
export function CurriculumMap({ v, canWrite, api, run, mapping, programName }: { v: ProgramOutcomes; canWrite: boolean; api: OutcomesApi; run: Run; mapping: Mapping; programName?: string }) {
  const [cell, setCell] = useState<{ ploId: string; courseId: string } | null>(null);
  const [adding, setAdding] = useState('');
  const all = useQuery({ queryKey: ['courses'], queryFn: () => api.courses(), enabled: canWrite });
  const mx = curriculumMatrix(v);
  const { plos, ilos } = mx;
  const name = levelNames(v);
  const th = 'px-2 py-1 font-mono text-xs font-semibold';
  const sep = 'border-s-2 border-border';
  const total = (id: string) => v.levels.map((l) => mx.totals[id]?.[l.code] ?? 0);
  return (
    <section aria-label="Curriculum map" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Legend v={v} />
        {plos.length > 0 && v.courses.length > 0 && (
          <Button type="button" variant="outline" className="px-3 py-1" onClick={() => { void downloadMatrix(mx, v, programName ?? 'Curriculum map'); }}>Download (Excel)</Button>
        )}
      </div>
      {plos.length > 0 && v.courses.length > 0 && (
        <p className="text-xs text-muted-foreground">{canWrite ? 'Click a cell to set the course\'s level for a PLO or to link its CLOs. A change goes into the course\'s syllabus as a draft and is on the map once that syllabus is approved.' : 'Click a cell to see the course\'s level for a PLO and the CLOs that deliver it.'}</p>
      )}
      {v.courses.length === 0 ? <p className="text-sm text-muted-foreground">No courses in this program yet.</p> : plos.length === 0 ? <p className="text-sm text-muted-foreground">Add PLOs to the program to map its courses to.</p> : (
        <div className="overflow-x-auto">
          <table className="text-sm" aria-label="Courses by PLO and ILO">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="sticky start-0 bg-background" />
                <th colSpan={plos.length} className="px-2 pt-1 text-center font-medium">PLOs</th>
                {ilos.length > 0 && <th colSpan={ilos.length} className={`${sep} px-2 pt-1 text-center font-medium`}>ILOs (through the PLOs linked to them)</th>}
              </tr>
              <tr className="border-b border-border">
                <th className="sticky start-0 bg-background px-2 py-1 text-start">Course</th>
                {plos.map((p) => <th key={p.id} className={th} title={p.textEn}>{p.code}</th>)}
                {ilos.map((i, n) => <th key={i.id} className={`${th} ${n === 0 ? sep : ''}`} title={i.textEn}>{i.code}</th>)}
              </tr>
            </thead>
            <tbody>
              {mx.groups.map((g) => (
                <Fragment key={g.year ?? 'none'}>
                  <tr><th colSpan={1 + plos.length + ilos.length} className="bg-muted/50 px-2 py-1 text-start text-xs font-semibold">{g.year ? `Year ${g.year}` : 'Year not set'}</th></tr>
                  {g.rows.map((r) => (
                    <tr key={r.courseId} className="border-t border-border">
                      <th scope="row" className="sticky start-0 bg-background px-2 py-1 text-start font-normal">
                        <span className="font-mono">{r.code}</span> <span className="text-xs text-muted-foreground">{r.role !== 'core' ? r.role : ''}{r.term ? ` T${r.term}` : ''}</span>
                      </th>
                      {plos.map((p) => {
                        const st = cellState(v, r.courseId, p.id);
                        const d = st.shown;
                        const tone = d.warn ? 'bg-amber-100 font-semibold text-amber-900' : d.from === 'both' || d.from === 'top' ? 'bg-primary/15 font-semibold' : d.from === 'clo' ? 'bg-primary/5 italic' : 'text-muted-foreground';
                        const label = `${r.code} ${p.code}: ${d.label}${st.pending ? `, waiting for approval (was ${st.live.label})` : ''}`;
                        return (
                          <td key={p.id} className="px-1 py-0.5 text-center">
                            <button type="button" aria-label={label} title={label}
                              className={`min-w-9 cursor-pointer rounded border px-1 transition-colors hover:border-primary hover:bg-primary/10 ${d.from === 'none' ? 'border-dashed border-border' : 'border-transparent'} ${tone} ${st.pending ? 'outline-dashed outline-2 outline-offset-1 outline-sky-500' : ''} ${cell?.ploId === p.id && cell.courseId === r.courseId ? 'ring-2 ring-primary' : ''}`}
                              onClick={() => setCell({ ploId: p.id, courseId: r.courseId })}>{d.text === '·' ? (canWrite ? '+' : '—') : d.text}{d.warn ? '!' : ''}{st.pending ? '•' : ''}</button>
                          </td>
                        );
                      })}
                      {ilos.map((i, n) => {
                        const c = r.cells[i.id];
                        const label = c?.level ? `${name.get(c.level) ?? c.level} (through ${c.via.join(', ')})` : 'not reached';
                        return (
                          <td key={i.id} className={`px-1 py-0.5 text-center ${n === 0 ? sep : ''}`}>
                            <span role="img" aria-label={`${r.code} ${i.code}: ${label}`} title={label}
                              className={`inline-block min-w-8 rounded px-1 ${c?.level ? 'bg-sky-50 text-sky-900' : 'text-muted-foreground'}`}>{c?.level ?? '—'}</span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border text-xs text-muted-foreground">
                <th scope="row" className="sticky start-0 bg-background px-2 py-1 text-start font-medium">Courses at {v.levels.map((l) => l.code).join(' / ')}</th>
                {[...plos, ...ilos].map((o, n) => (
                  <td key={o.id} className={`px-1 py-1 text-center font-mono ${n === plos.length ? sep : ''}`} aria-label={`${o.code} totals: ${v.levels.map((l, k) => `${total(o.id)[k]} ${l.name}`).join(', ')}`}>{total(o.id).join('/')}</td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {cell && <CellPanel v={v} ploId={cell.ploId} courseId={cell.courseId} canWrite={canWrite} mapping={mapping} onClose={() => setCell(null)} />}
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
      <span><span className="rounded px-1 text-foreground outline-dashed outline-2 outline-sky-500">M•</span> waiting for approval</span>
    </div>
  );
}

/**
 * One course and one PLO: the course's level for it (top-down) and the CLOs that deliver it (bottom-up). With a syllabus in progress the
 * values are the draft's; a change goes into that draft (or starts one from the approved syllabus).
 */
export function CellPanel({ v, ploId, courseId, canWrite, mapping, onClose }: { v: ProgramOutcomes; ploId: string; courseId: string; canWrite: boolean; mapping: Mapping; onClose: () => void }) {
  const plo = v.plos.find((p) => p.id === ploId);
  const course = v.courses.find((c) => c.courseId === courseId);
  if (!plo || !course) return null;
  const d = draftOf(v, courseId);
  const m = v.map.find((x) => x.ploId === ploId && x.courseId === courseId);
  const locked = !!d && d.status !== 'draft';
  const can = canWrite && !locked;
  const codeOf = (id: string) => v.plos.find((p) => p.id === id)?.code ?? 'another PLO';
  // The CLOs as the draft has them when there is one, else as approved (each with the PLOs it serves in this program).
  const clos = d ? d.clos : course.clos.map((o) => ({ id: o.id, code: o.code, textEn: o.textEn, plos: v.links.filter((l) => l.fromId === o.id).map((l) => ({ ploId: l.toId, level: l.level ?? '' })) }));
  const top = d ? d.coverage.find((c) => c.ploId === ploId)?.level ?? '' : m?.topDown ?? '';
  return (
    <div className="space-y-3 rounded-lg border border-border p-3" aria-label={`${course.code} to ${plo.code}`} role="group">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm"><span className="font-mono font-semibold">{course.code}</span> → <span className="font-mono font-semibold">{plo.code}</span> <ContentText className="text-muted-foreground">{plo.textEn}</ContentText></p>
        <Button type="button" variant="ghost" className="px-2 py-1" onClick={onClose}>Close</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {d ? (locked ? `${course.code}'s syllabus (v${d.versionNo}) is ${d.status === 'in_review' ? 'in review' : 'endorsed'}: its mapping cannot change until it is returned or approved.`
          : `Showing ${course.code}'s syllabus draft (v${d.versionNo}). Changes go into it and are on the map once it is approved.`)
          : canWrite ? `A change starts a draft of ${course.code}'s syllabus from the approved one; it is on the map once approved.` : ''}
        {' '}<a className="underline" href={`/settings/organization/courses/${courseId}`}>Open the course</a>
      </p>
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Course level (top-down)</span>
        <select aria-label={`${course.code} level for ${plo.code}`} className={select} value={top} disabled={!can}
          onChange={(e) => mapping.propose(courseId, { kind: 'coverage', ploId, level: e.target.value || null })}>
          <option value="">Not mapped</option>
          {v.levels.map((l) => <option key={l.code} value={l.code}>{l.code} {l.name}</option>)}
        </select>
      </label>
      <div className="space-y-1">
        <p className="text-sm font-medium">CLOs that deliver it (bottom-up)</p>
        {clos.length === 0 && <p className="text-sm text-muted-foreground">This course has no CLOs yet: add them in its syllabus.</p>}
        <ul className="space-y-1">
          {clos.map((clo) => {
            const value = clo.plos.find((x) => x.ploId === ploId)?.level ?? '';
            const elsewhere = clo.plos.filter((x) => x.ploId !== ploId && x.ploId);
            return (
              <li key={clo.id} className="flex flex-wrap items-center gap-2 text-sm">
                <select aria-label={`${clo.code} level for ${plo.code}`} className={select} value={value} disabled={!can}
                  onChange={(e) => { void mapping.setCloLevel(courseId, clo, ploId, plo.code, e.target.value || null, codeOf); }}>
                  <option value="">Not mapped</option>
                  {v.levels.map((l) => <option key={l.code} value={l.code}>{l.code} {l.name}</option>)}
                </select>
                <span className="font-mono">{clo.code}</span><ContentText className="min-w-0 flex-1">{clo.textEn}</ContentText>
                {elsewhere.length > 0 && <span className="text-xs text-muted-foreground">also {elsewhere.map((x) => codeOf(x.ploId)).join(', ')}</span>}
              </li>
            );
          })}
        </ul>
      </div>
      {mapping.error && <p role="alert" className="text-sm text-red-700">{mapping.error}</p>}
    </div>
  );
}

/**
 * One PLO's courses (top-down): each course mapped to it (as approved, or as its syllabus draft proposes), its level, the CLOs that
 * deliver it, and "Map a course". Used by the map's By PLO view and under each PLO in the program's dialog.
 */
export function PloCourses({ v, ploId, canWrite, mapping }: { v: ProgramOutcomes; ploId: string; canWrite: boolean; mapping: Mapping }) {
  const [open, setOpen] = useState<string | null>(null);
  const p = v.plos.find((x) => x.id === ploId);
  if (!p) return null;
  const shown = v.courses.map((c) => ({ c, st: cellState(v, c.courseId, p.id) })).filter((x) => x.st.shown.from !== 'none' || x.st.pending);
  const rest = v.courses.filter((c) => !shown.some((x) => x.c.courseId === c.courseId));
  const levelName = levelNames(v);
  return (
    <div className="space-y-2">
      {shown.length === 0 && <p className="text-sm text-muted-foreground">No course mapped yet.</p>}
      <ul className="space-y-1">
        {shown.map(({ c, st }) => {
          const d = st.draft;
          const top = d ? d.coverage.find((x) => x.ploId === p.id)?.level ?? '' : v.map.find((x) => x.ploId === p.id && x.courseId === c.courseId)?.topDown ?? '';
          const delivering = d ? d.clos.filter((x) => x.plos.some((m) => m.ploId === p.id)).map((x) => x.code) : c.clos.filter((o) => v.links.some((l) => l.fromId === o.id && l.toId === p.id)).map((o) => o.code);
          const fromClos = st.shown.from === 'clo' && st.shown.text !== '✓' ? levelName.get(st.shown.text) : undefined;
          return (
            <li key={c.courseId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-20 font-mono">{c.code}</span>
              <select aria-label={`${c.code} level for ${p.code} (by PLO)`} className={select} value={top} disabled={!canWrite || (!!d && d.status !== 'draft')}
                onChange={(e) => mapping.propose(c.courseId, { kind: 'coverage', ploId: p.id, level: e.target.value || null })}>
                <option value="">{fromClos ? `From CLOs (${fromClos})` : 'Not mapped'}</option>
                {v.levels.map((l) => <option key={l.code} value={l.code}>{l.code} {l.name}</option>)}
              </select>
              <span className="text-xs text-muted-foreground">CLOs: {delivering.length ? delivering.join(', ') : 'none'}</span>
              {st.shown.warn && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">{st.shown.label}</span>}
              {st.pending && <span className="rounded px-1.5 py-0.5 text-xs text-sky-900 outline-dashed outline-1 outline-sky-500">waiting for approval</span>}
              <Button type="button" variant="ghost" className="px-2 py-1 text-xs" aria-expanded={open === c.courseId} onClick={() => setOpen(open === c.courseId ? null : c.courseId)}>{canWrite ? 'Link CLOs' : 'CLOs'}</Button>
            </li>
          );
        })}
      </ul>
      {canWrite && rest.length > 0 && <AddCourseToPlo v={v} ploCode={p.code} courses={rest} onAdd={(courseId, level) => mapping.propose(courseId, { kind: 'coverage', ploId: p.id, level })} />}
      {open && <CellPanel v={v} ploId={p.id} courseId={open} canWrite={canWrite} mapping={mapping} onClose={() => setOpen(null)} />}
      {!open && mapping.error && <p role="alert" className="text-sm text-red-700">{mapping.error}</p>}
    </div>
  );
}

/** PLO first (top-down): each PLO and its courses. */
function ByPlo({ v, canWrite, mapping }: { v: ProgramOutcomes; canWrite: boolean; mapping: Mapping }) {
  const plos = v.plos.filter((p) => p.status !== 'retired');
  if (!plos.length) return <p className="text-sm text-muted-foreground">Add PLOs to the program to map its courses to.</p>;
  return (
    <section aria-label="Map by PLO" className="space-y-3">
      {plos.map((p) => (
        <div key={p.id} className="space-y-2 rounded-lg border border-border p-3" role="group" aria-label={`${p.code} courses`}>
          <p className="text-sm"><span className="font-mono font-semibold">{p.code}</span> <ContentText>{p.textEn}</ContentText></p>
          <PloCourses v={v} ploId={p.id} canWrite={canWrite} mapping={mapping} />
        </div>
      ))}
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

/** The map as a workbook: one row per course (its year and term), one column per PLO and then per ILO, the level in each cell. */
async function downloadMatrix(mx: CurriculumMatrix, v: ProgramOutcomes, title: string) {
  const cols = [
    { key: 'course', label: 'Course' }, { key: 'title', label: 'Title' }, { key: 'year', label: 'Year' }, { key: 'term', label: 'Term' },
    ...mx.plos.map((p, n) => ({ key: `plo_${n}`, label: `PLO ${p.code}`, id: p.id })), ...mx.ilos.map((i, n) => ({ key: `ilo_${n}`, label: `ILO ${i.code}`, id: i.id })),
  ];
  const rows = mx.groups.flatMap((g) => g.rows).map((r) => Object.fromEntries(cols.map((c) => [c.key,
    c.key === 'course' ? r.code : c.key === 'title' ? r.titleEn : c.key === 'year' ? r.year : c.key === 'term' ? r.term : r.cells[(c as { id: string }).id]?.level ?? null])));
  rows.push(Object.fromEntries(cols.map((c) => [c.key, c.key === 'course' ? `Courses at ${v.levels.map((l) => l.code).join(' / ')}` : 'id' in c ? v.levels.map((l) => mx.totals[c.id]?.[l.code] ?? 0).join('/') : null])));
  const columns = cols.map((c) => ({ key: c.key, label: c.label, type: (c.key === 'year' || c.key === 'term' ? 'integer' : 'text') as 'integer' | 'text', required: false }));
  download(await toXlsx(`${title} curriculum map`, columns, rows), fileNameFor(`${title} curriculum map`, 'xlsx'));
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
