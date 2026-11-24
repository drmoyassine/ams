// The syllabus editor (DEC-038): one block per section of the AIU template, with the rule checker's issues shown beside what they are about.
// It is a controlled component: the page holds the document, saves it, and runs the same shared checker live, so a coordinator sees an
// error as it appears. Nothing here blocks typing; only submitting for review waits for the errors to be fixed.
import { useState } from 'react';
import { BLOOM_LEVELS, DEFAULT_ACHIEVEMENT_SCALE, DEFAULT_RUBRIC_TEMPLATES, COURSE_CATEGORIES, COURSE_LEVELS, COURSE_TYPES, LANGUAGES_OF_DELIVERY, MATERIAL_KINDS, SDGS, SUSTAINABILITY, formatRequisites, parseRequisites } from '@ams/shared';
import type { AchievementScale, OutcomeLevel, RubricTemplate, SectionKey, SyllabusContent, SyllabusIssue, SyllabusPlo, SyllabusSettings, SyllabusTemplate } from '@ams/shared';
import { AssessmentPlan } from './assessment-plan';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { label } from './labels';

const newId = () => crypto.randomUUID();
const field = 'flex min-w-0 flex-col gap-1 text-xs text-muted-foreground';
const select = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground';
const area = 'w-full rounded-md border border-border bg-background p-2 text-sm text-foreground';
const replaceAt = <T,>(xs: T[], i: number, x: T) => xs.map((y, j) => (j === i ? x : y));
const removeAt = <T,>(xs: T[], i: number) => xs.filter((_, j) => j !== i);
const toNum = (s: string): number | null => { if (s.trim() === '') return null; const n = Number(s); return Number.isNaN(n) ? null : n; };
const toggle = (xs: string[], v: string) => (xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v]);

function Num({ value, onChange, ariaLabel, className }: { value: number | null; onChange: (v: number | null) => void; ariaLabel: string; className?: string }) {
  return <Input aria-label={ariaLabel} inputMode="decimal" className={className} value={value ?? ''} onChange={(e) => onChange(toNum(e.target.value))} />;
}
/**
 * Prerequisites or co-requisites as text: ; means and, | means or ("MATH 101; PHYS 101 | PHYS 111" is MATH 101 and one of PHYS 101 or PHYS 111).
 * The text is read when the field loses focus; a code that is not a course of the institution is named and left out.
 */
function RequisiteField({ label: text, ariaLabel, groups, courses, onChange }: {
  label: string; ariaLabel: string; groups: string[][]; courses: { id: string; code: string }[]; onChange: (v: string[][]) => void;
}) {
  const codeOf = (id: string) => courses.find((x) => x.id === id)?.code ?? '';
  const shown = formatRequisites(groups, codeOf);
  const [draft, setDraft] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<string[]>([]);
  const commit = () => {
    if (draft === null) return;
    const byCode = new Map(courses.map((x) => [x.code.normalize('NFC').trim().replace(/\s+/g, ' ').toUpperCase(), x.id]));
    const { groups: next, unknown: bad } = parseRequisites(draft, (c) => byCode.get(c));
    setUnknown(bad); setDraft(null);
    if (formatRequisites(next, codeOf) !== shown) onChange(next);
  };
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs sm:col-span-3"><span>{text}</span>
      <Input aria-label={ariaLabel} dir="auto" placeholder="MATH 101; PHYS 101 | PHYS 111" value={draft ?? shown} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
      <span className="text-muted-foreground">; means and, | means or.</span>
      {unknown.length > 0 && <span role="note" className="text-amber-800">Not a course of the institution: {unknown.join(', ')}.</span>}
    </label>
  );
}

function Chips({ options, value, onChange, ariaLabel }: { options: { id: string; text: string }[]; value: string[]; onChange: (v: string[]) => void; ariaLabel: string }) {
  if (!options.length) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value.includes(o.id)} onClick={() => onChange(toggle(value, o.id))}
          className={`rounded-full border px-2 py-0.5 text-xs ${value.includes(o.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}>{o.text}</button>
      ))}
    </div>
  );
}

/**
 * Program coverage (DEC-039): the level at which the course itself covers each PLO (the top-down side of the curriculum map), next to
 * the highest level its CLOs reach. The rule checker flags a level the CLOs do not reach, or a PLO no CLO maps to.
 */
function ProgramCoverage({ content: c, plos, programs, levels, onChange }: { content: SyllabusContent; plos: SyllabusPlo[]; programs: string[]; levels: OutcomeLevel[]; onChange: (v: SyllabusContent['coverage']) => void }) {
  const rank = (code: string) => levels.findIndex((l) => l.code === code);
  const reach = (ploId: string) => {
    const r = Math.max(-1, ...c.clos.flatMap((x) => x.plos.filter((m) => m.ploId === ploId).map((m) => rank(m.level))));
    return r >= 0 ? levels[r]!.name : 'no CLO';
  };
  const used = new Set(c.coverage.map((x) => x.ploId));
  return (
    <div className="space-y-2 rounded-md border border-border p-3" role="group" aria-label="Program coverage">
      <p className="text-sm font-medium text-foreground">Program coverage</p>
      <p className="text-xs text-muted-foreground">The level at which this course covers each PLO, as the curriculum map shows it. Its CLOs deliver it.</p>
      {c.coverage.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
      {c.coverage.map((cv, k) => (
        <div key={k} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2 sm:grid-cols-[10rem_10rem_1fr_auto]">
          <label className={field}>PLO
            <select aria-label={`Covered PLO ${k + 1}`} className={select} value={cv.ploId} onChange={(e) => onChange(replaceAt(c.coverage, k, { ...cv, ploId: e.target.value }))}>
              <option value="">Choose</option>
              {programs.map((pn) => <optgroup key={pn} label={pn}>{plos.filter((p) => p.programName === pn && (p.id === cv.ploId || !used.has(p.id))).map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</optgroup>)}
            </select>
          </label>
          <label className={field}>Course level
            <select aria-label={`Covered PLO ${k + 1} level`} className={select} value={cv.level} onChange={(e) => onChange(replaceAt(c.coverage, k, { ...cv, level: e.target.value }))}>
              <option value="">Choose</option>{levels.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </label>
          <span className="hidden pb-2 text-xs text-muted-foreground sm:block">{cv.ploId ? `CLOs reach: ${reach(cv.ploId)}` : ''}</span>
          <Button type="button" variant="ghost" className="px-2 py-1 text-xs" aria-label={`Remove covered PLO ${k + 1}`} onClick={() => onChange(removeAt(c.coverage, k))}>✕</Button>
        </div>
      ))}
      {plos.some((p) => !used.has(p.id)) && <Button type="button" variant="outline" className="px-3 py-1" onClick={() => onChange([...c.coverage, { ploId: '', level: '' }])}>+ PLO the course covers</Button>}
    </div>
  );
}

function Section({ id, title, help, issues, children, rowsShowTheirs = false }: { id: SectionKey; title: string; help: string; issues: SyllabusIssue[]; children: React.ReactNode; /** Issues about a row are shown on the row only. */ rowsShowTheirs?: boolean }) {
  const errors = issues.filter((x) => x.severity === 'error');
  const warnings = issues.filter((x) => x.severity === 'warning');
  return (
    <section aria-label={title} data-section={id} className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0"><h3 className="text-base font-semibold">{title}</h3><p className="text-xs text-muted-foreground">{help}</p></div>
        {(errors.length > 0 || warnings.length > 0) && (
          <span className="flex gap-1 text-xs">
            {errors.length > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-900">{errors.length} error{errors.length === 1 ? '' : 's'}</span>}
            {warnings.length > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">{warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>}
          </span>
        )}
      </div>
      {issues.some((x) => !rowsShowTheirs || !x.ref) && (
        <ul aria-label={`Issues in ${title}`} className="space-y-0.5 text-xs">
          {issues.filter((x) => !rowsShowTheirs || !x.ref).map((x, k) => <li key={k} className={x.severity === 'error' ? 'text-red-800' : 'text-amber-800'}>{x.severity === 'error' ? 'Error: ' : 'Warning: '}{x.message}</li>)}
        </ul>
      )}
      {children}
    </section>
  );
}

export interface SyllabusEditorProps {
  content: SyllabusContent; onChange: (c: SyllabusContent) => void;
  plos: SyllabusPlo[]; levels: OutcomeLevel[]; courses: { id: string; code: string; titleEn: string }[]; courseId: string; code: string;
  issues: SyllabusIssue[]; settings: SyllabusSettings; template: SyllabusTemplate;
  /** Only these blocks, in this order (the course page's tabs); 'policies' is the assessment notes and the template's own sections. */
  only?: readonly string[];
  /** The description in the second language: by default only when a program the course serves teaches in it. */
  secondLanguage?: boolean;
  /** The institution's achievement scale and rubric templates (the defaults when not given). */
  scale?: AchievementScale; rubricTemplates?: RubricTemplate[];
}

export function SyllabusEditor({ content: c, onChange, plos, levels, courses, courseId, code, issues, settings, template, only, secondLanguage = true, scale = DEFAULT_ACHIEVEMENT_SCALE, rubricTemplates = DEFAULT_RUBRIC_TEMPLATES }: SyllabusEditorProps) {
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const set = (patch: Partial<SyllabusContent>) => onChange({ ...c, ...patch });
  const setInfo = (p: Partial<SyllabusContent['info']>) => set({ info: { ...c.info, ...p } });
  const of = (s: SectionKey) => issues.filter((x) => x.section === s);
  const refIssues = (ref: string) => issues.filter((x) => x.ref === ref);
  const sec = (key: string) => template.sections.find((s) => s.key === key);
  const cloOptions = c.clos.map((x) => ({ id: x.id, text: x.code }));
  const recode = (clos: SyllabusContent['clos']) => clos.map((x, k) => ({ ...x, code: `CLO${k + 1}` }));
  const otherCourses = courses.filter((x) => x.id !== courseId);
  const programs = [...new Set(plos.map((p) => p.programName))];
  const hint = (key: string) => (sec(key)?.help ?? '');
  const title = (key: string, fallback: string) => sec(key)?.title ?? fallback;
  const Row = ({ about }: { about: string }) => <>{refIssues(about).map((x, k) => <p key={k} role="alert" className={`text-xs ${x.severity === 'error' ? 'text-red-800' : 'text-amber-800'}`}>{x.message}</p>)}</>;

  const notes = (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field}>Pass percentage and submission details<textarea aria-label="Pass percentage and submission details" rows={2} className={area} value={c.assessmentNotes.passPercentage} onChange={(e) => set({ assessmentNotes: { ...c.assessmentNotes, passPercentage: e.target.value } })} /></label>
          <label className={field}>How assignments, quizzes and exams work<textarea aria-label="How assessments work" rows={2} className={area} value={c.assessmentNotes.howItWorks} onChange={(e) => set({ assessmentNotes: { ...c.assessmentNotes, howItWorks: e.target.value } })} /></label>
        </div>
  );
  const blocks: Record<string, React.ReactNode> = {
    info: (
      <Section id="info" title={title('info', 'Basic course information')} help={hint('info')} issues={of('info')}>
        <div className="grid gap-3 sm:grid-cols-6">
          {!only && <div className={`${field} sm:col-span-1`}>Course code<Input aria-label="Course code" value={code} readOnly disabled /></div>}
          <label className={`${field} ${only ? 'sm:col-span-4' : 'sm:col-span-3'}`}>Course title (English)<Input aria-label="Course title (English)" value={c.info.titleEn} onChange={(e) => setInfo({ titleEn: e.target.value })} /></label>
          <label className={field}>Credit hours<Num ariaLabel="Credit hours" value={c.info.credits} onChange={(v) => setInfo({ credits: v })} /></label>
          <label className={field}>Lecture hours<Num ariaLabel="Lecture hours" value={c.info.contactLecture} onChange={(v) => setInfo({ contactLecture: v })} /></label>
          <label className={field}>Lab hours<Num ariaLabel="Lab hours" value={c.info.contactLab} onChange={(v) => setInfo({ contactLab: v })} /></label>
          <label className={field}>Other hours (studio…)<Num ariaLabel="Other hours" value={c.info.contactOther} onChange={(v) => setInfo({ contactOther: v })} /></label>
          <label className={`${field} sm:col-span-2`}>Language of delivery
            <select aria-label="Language of delivery" className={select} value={c.info.languageOfDelivery} onChange={(e) => setInfo({ languageOfDelivery: e.target.value })}>
              <option value="">Choose</option>{LANGUAGES_OF_DELIVERY.map((v) => <option key={v} value={v}>{label(v)}</option>)}
            </select>
          </label>
          <label className={`${field} sm:col-span-2`}>Course type
            <select aria-label="Course type" className={select} value={c.info.courseType} onChange={(e) => setInfo({ courseType: e.target.value })}>
              <option value="">Choose</option>{COURSE_TYPES.map((v) => <option key={v} value={v}>{label(v)}</option>)}
            </select>
          </label>
          <label className={`${field} sm:col-span-1`}>Course level
            <select aria-label="Course level" className={select} value={c.info.courseLevel} onChange={(e) => setInfo({ courseLevel: e.target.value })}>
              <option value="">Choose</option>{COURSE_LEVELS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className={`${field} sm:col-span-2`}>Course category
            <select aria-label="Course category" className={select} value={c.info.category} onChange={(e) => setInfo({ category: e.target.value })}>
              <option value="">Choose</option>{COURSE_CATEGORIES.map((v) => <option key={v} value={v}>{label(v)}</option>)}
            </select>
          </label>
          <label className={`${field} sm:col-span-2`}>Sustainability indicator
            <select aria-label="Sustainability indicator" className={select} value={c.info.sustainability} onChange={(e) => setInfo({ sustainability: e.target.value })}>
              <option value="">Choose</option>{SUSTAINABILITY.map((v) => <option key={v} value={v}>{label(v)}</option>)}
            </select>
          </label>
          <RequisiteField label="Prerequisite(s)" ariaLabel="Prerequisites" groups={c.info.prerequisites} courses={otherCourses} onChange={(v) => setInfo({ prerequisites: v })} />
          <RequisiteField label="Co-requisite(s)" ariaLabel="Co-requisites" groups={c.info.corequisites} courses={otherCourses} onChange={(v) => setInfo({ corequisites: v })} />
          <label className={`${field} sm:col-span-6`}><span>Other requirements</span>
            <Input aria-label="Other requirements" dir="auto" placeholder="Junior standing; consent of the instructor" value={c.info.otherRequirements} onChange={(e) => setInfo({ otherRequirements: e.target.value })} />
          </label>
        </div>
      </Section>
    ),
    description: (
      <Section id="description" title={title('description', 'Course description')} help={hint('description')} issues={of('description')}>
        <label className={field}>Description (English)<textarea aria-label="Description (English)" rows={5} className={area} value={c.description.en} onChange={(e) => set({ description: { ...c.description, en: e.target.value } })} /></label>
        {(secondLanguage || c.description.ar.trim() !== '') && <label className={field}>Description (Arabic)<textarea aria-label="Description (Arabic)" dir="auto" rows={3} className={area} value={c.description.ar} onChange={(e) => set({ description: { ...c.description, ar: e.target.value } })} /></label>}
      </Section>
    ),
    clos: (
      <Section id="clos" title={title('clos', 'Course learning outcomes (CLOs)')} help={`${hint('clos')} Between ${settings.minClos} and ${settings.maxClos} CLOs, mapping to ${settings.minPlos} to ${settings.maxPlos} PLOs.`} issues={of('clos')}>
        {plos.length === 0 && <p className="text-xs text-amber-800">This course serves no program with PLOs yet: put it in a program (Settings, Organization, Courses) before mapping CLOs.</p>}
        <div className="space-y-3">
          {c.clos.map((x, k) => (
            <div key={x.id} className="space-y-1 rounded-md border border-border p-2" data-testid="clo-row">
              <div className="grid gap-2 sm:grid-cols-12">
                <div className="flex items-center text-sm font-semibold sm:col-span-1">{x.code}</div>
                <label className={`${field} sm:col-span-4`}>Outcome (English)<textarea aria-label={`${x.code} text`} rows={2} className={area} value={x.textEn} onChange={(e) => set({ clos: replaceAt(c.clos, k, { ...x, textEn: e.target.value }) })} /></label>
                <label className={`${field} sm:col-span-2`}>Bloom level
                  <select aria-label={`${x.code} Bloom level`} className={select} value={x.bloom} onChange={(e) => set({ clos: replaceAt(c.clos, k, { ...x, bloom: e.target.value }) })}>
                    <option value="">Choose</option>{BLOOM_LEVELS.map((v) => <option key={v} value={v}>{label(v)}</option>)}
                  </select>
                </label>
                <div className="space-y-1 sm:col-span-5">
                  {/* The PLOs this CLO maps to, each with its level: as many as the syllabus rules allow (DEC-039). */}
                  {(x.plos.length ? x.plos : [{ ploId: '', level: '' }]).map((m, j) => {
                    const n = j === 0 ? '' : ` ${j + 1}`;
                    const put = (patch: Partial<typeof m>) => { const next = [...(x.plos.length ? x.plos : [{ ploId: '', level: '' }])]; next[j] = { ...m, ...patch }; set({ clos: replaceAt(c.clos, k, { ...x, plos: next }) }); };
                    return (
                      <div key={j} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                        <label className={field}>{j === 0 ? 'PLO' : `PLO ${j + 1}`}
                          <select aria-label={`${x.code} PLO${n}`} className={select} value={m.ploId} onChange={(e) => put({ ploId: e.target.value })}>
                            <option value="">Choose</option>
                            {programs.map((pn) => <optgroup key={pn} label={pn}>{plos.filter((p) => p.programName === pn).map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</optgroup>)}
                          </select>
                        </label>
                        <label className={field}>Coverage
                          <select aria-label={`${x.code} coverage${n}`} className={select} value={m.level} onChange={(e) => put({ level: e.target.value })}>
                            <option value="">Choose</option>{levels.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                          </select>
                        </label>
                        {j > 0 ? <Button type="button" variant="ghost" className="px-2 py-1 text-xs" aria-label={`Remove ${x.code} PLO${n}`} onClick={() => set({ clos: replaceAt(c.clos, k, { ...x, plos: removeAt(x.plos, j) }) })}>✕</Button> : <span />}
                      </div>
                    );
                  })}
                  {x.plos.length > 0 && x.plos.length < settings.maxPlosPerClo && (
                    <button type="button" className="text-xs underline" onClick={() => set({ clos: replaceAt(c.clos, k, { ...x, plos: [...x.plos, { ploId: '', level: '' }] }) })}>+ another PLO for {x.code}</button>
                  )}
                </div>
              </div>
              <div className="flex items-start justify-between gap-2"><div><Row about={x.id} /></div><Button type="button" variant="ghost" onClick={() => set({ clos: recode(removeAt(c.clos, k)) })} aria-label={`Remove ${x.code}`}>Remove</Button></div>
            </div>
          ))}
        </div>
        <Button type="button" variant="outline" onClick={() => set({ clos: recode([...c.clos, { id: newId(), code: '', textEn: '', textAr: '', bloom: '', plos: [] }]) })}>+ CLO</Button>
        <ProgramCoverage content={c} plos={plos} programs={programs} levels={levels} onChange={(coverage) => set({ coverage })} />
      </Section>
    ),
    outline: (
      <Section id="outline" title={title('outline', 'Course outline')} help={hint('outline')} issues={of('outline')}>
        <div className="space-y-2">
          {c.outline.map((w, k) => (
            <div key={k} className="space-y-1 rounded-md border border-border p-2" data-testid="week-row">
              <div className="grid gap-2 sm:grid-cols-12">
                <label className={`${field} sm:col-span-1`}>Week<Num ariaLabel={`Week ${k + 1} number`} value={w.week} onChange={(v) => set({ outline: replaceAt(c.outline, k, { ...w, week: v }) })} /></label>
                <label className={`${field} sm:col-span-5`}>Topic<Input aria-label={`Week ${k + 1} topic`} value={w.topic} onChange={(e) => set({ outline: replaceAt(c.outline, k, { ...w, topic: e.target.value }) })} /></label>
                <label className={`${field} sm:col-span-3`}>Reading<Input aria-label={`Week ${k + 1} reading`} value={w.reading} onChange={(e) => set({ outline: replaceAt(c.outline, k, { ...w, reading: e.target.value }) })} /></label>
                <label className={`${field} sm:col-span-3`}>Lab / other sessions<Input aria-label={`Week ${k + 1} lab`} value={w.lab} onChange={(e) => set({ outline: replaceAt(c.outline, k, { ...w, lab: e.target.value }) })} /></label>
              </div>
              <div className="grid gap-2 sm:grid-cols-12">
                <div className={`${field} sm:col-span-4`}>Mapped CLOs<Chips ariaLabel={`Week ${k + 1} CLOs`} options={cloOptions} value={w.cloIds} onChange={(v) => set({ outline: replaceAt(c.outline, k, { ...w, cloIds: v }) })} /></div>
                <label className={`${field} sm:col-span-3`}>SDGs (numbers, comma-separated)<Input aria-label={`Week ${k + 1} SDGs`} value={w.sdgs.join(', ')} onChange={(e) => set({ outline: replaceAt(c.outline, k, { ...w, sdgs: e.target.value.split(',').map((x) => x.trim()).filter((x) => SDGS.includes(x)) }) })} /></label>
                <label className={`${field} sm:col-span-3`}>Assessment this week
                  <select aria-label={`Week ${k + 1} assessment`} className={select} value={w.assessmentId} onChange={(e) => set({ outline: replaceAt(c.outline, k, { ...w, assessmentId: e.target.value }) })}>
                    <option value="">None</option>{c.assessments.map((a) => <option key={a.id} value={a.id}>{a.name || 'Unnamed'}</option>)}
                  </select>
                </label>
                <div className="flex items-end justify-end sm:col-span-2"><Button type="button" variant="ghost" aria-label={`Remove week ${k + 1}`} onClick={() => set({ outline: removeAt(c.outline, k) })}>Remove</Button></div>
              </div>
              <Row about={w.week === null ? '' : String(w.week)} />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => set({ outline: [...c.outline, { week: (c.outline.reduce((m, x) => Math.max(m, x.week ?? 0), 0)) + 1, topic: '', reading: '', lab: '', cloIds: [], sdgs: [], assessmentId: '', activity: '' }] })}>+ Week</Button>
          {c.outline.length === 0 && <Button type="button" variant="outline" onClick={() => set({ outline: Array.from({ length: 14 }, (_, k) => ({ week: k + 1, topic: '', reading: '', lab: '', cloIds: [], sdgs: [], assessmentId: '', activity: '' })) })}>Add 14 weeks</Button>}
        </div>
      </Section>
    ),
    materials: (
      <Section id="materials" title={title('materials', 'Textbooks, materials and software')} help={hint('materials')} issues={of('materials')}>
        {c.materials.map((m, k) => (
          <div key={k} className="grid gap-2 sm:grid-cols-12" data-testid="material-row">
            <label className={`${field} sm:col-span-3`}>Kind
              <select aria-label={`Material ${k + 1} kind`} className={select} value={m.kind} onChange={(e) => set({ materials: replaceAt(c.materials, k, { ...m, kind: e.target.value }) })}>
                <option value="">Choose</option>{MATERIAL_KINDS.map((v) => <option key={v} value={v}>{label(v)}</option>)}
              </select>
            </label>
            <label className={`${field} sm:col-span-5`}>Citation<Input aria-label={`Material ${k + 1} citation`} value={m.citation} onChange={(e) => set({ materials: replaceAt(c.materials, k, { ...m, citation: e.target.value }) })} /></label>
            <label className={`${field} sm:col-span-2`}>ISBN<Input aria-label={`Material ${k + 1} ISBN`} value={m.isbn} onChange={(e) => set({ materials: replaceAt(c.materials, k, { ...m, isbn: e.target.value }) })} /></label>
            <label className={`${field} sm:col-span-1`}>Year<Num ariaLabel={`Material ${k + 1} year`} value={m.year} onChange={(v) => set({ materials: replaceAt(c.materials, k, { ...m, year: v }) })} /></label>
            <div className="flex items-end sm:col-span-1"><Button type="button" variant="ghost" aria-label={`Remove material ${k + 1}`} onClick={() => set({ materials: removeAt(c.materials, k) })}>Remove</Button></div>
          </div>
        ))}
        <Button type="button" variant="outline" onClick={() => set({ materials: [...c.materials, { kind: c.materials.length ? 'recommended' : 'textbook', citation: '', isbn: '', year: null }] })}>+ Material</Button>
      </Section>
    ),
    methodology: (
      <Section id="methodology" title={title('methodology', 'Teaching methodology')} help={hint('methodology')} issues={of('methodology')}>
        <textarea aria-label="Teaching methodology" rows={4} className={area} value={c.methodology} onChange={(e) => set({ methodology: e.target.value })} />
      </Section>
    ),
    assessments: (
      <Section id="assessments" title={title('assessments', 'Assessments')} help="Each assessment with its type, week and weight; under it, the CLOs it assesses, the share of it each one carries and the rubric that scores it." rowsShowTheirs
        issues={[...of('assessments'), ...of('rubrics')].filter((x) => !x.ref || !fresh.has(x.ref))}>
        <AssessmentPlan content={c} onChange={onChange} scale={scale} templates={rubricTemplates} settings={settings} issues={[...of('assessments'), ...of('rubrics')]}
          fresh={fresh} onFresh={(id, on) => setFresh((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; })} />
        {!only && notes}
      </Section>
    ),
    // The rubrics are part of the assessments (above): the course's rubrics are listed and edited there.
    rubrics: null,
  };
  // Sections an admin added to the template (Settings, Organization, Courses) are free text, kept in the document under their key.
  const custom = (key: string, titleText: string, help: string) => (
    <section key={key} aria-label={titleText} data-section={key} className="space-y-2 rounded-lg border border-border p-4">
      <div><h3 className="text-base font-semibold">{titleText}</h3>{help && <p className="text-xs text-muted-foreground">{help}</p>}</div>
      <textarea aria-label={titleText} rows={4} className={area} value={c.custom[key] ?? ''} onChange={(e) => set({ custom: { ...c.custom, [key]: e.target.value } })} />
    </section>
  );

  const policies = (
    <div className="space-y-4">
      <section aria-label="Assessment policies" className="space-y-2 rounded-lg border border-border p-4">
        <div><h3 className="text-base font-semibold">Assessment policies</h3><p className="text-xs text-muted-foreground">The pass percentage, submission details and how assignments, quizzes and exams work.</p></div>
        {notes}
      </section>
      {template.sections.filter((s2) => s2.key.startsWith('custom:')).map((s2) => custom(s2.key, s2.title, s2.help))}
    </div>
  );
  if (only) {
    return <div className="space-y-4" data-testid="syllabus-editor">{only.map((k) => (k === 'policies' ? <div key={k}>{policies}</div> : blocks[k] ? <div key={k}>{blocks[k]}</div> : null))}</div>;
  }
  return (
    <div className="space-y-4" data-testid="syllabus-editor">
      {template.sections.map((s2) => (blocks[s2.key] ? <div key={s2.key}>{blocks[s2.key]}</div> : s2.key.startsWith('custom:') ? custom(s2.key, s2.title, s2.help) : null))}
    </div>
  );
}
