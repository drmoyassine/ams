// The syllabus editor (DEC-038): one block per section of the AIU template, with the rule checker's issues shown beside what they are about.
// It is a controlled component: the page holds the document, saves it, and runs the same shared checker live, so a coordinator sees an
// error as it appears. Nothing here blocks typing; only submitting for review waits for the errors to be fixed.
import { ASSESSMENT_CATEGORIES, BLOOM_LEVELS, COURSE_CATEGORIES, COURSE_LEVELS, COURSE_TYPES, LANGUAGES_OF_DELIVERY, MATERIAL_KINDS, SDGS, SUSTAINABILITY, cloWeights } from '@ams/shared';
import type { OutcomeLevel, SectionKey, SyllabusAssessment, SyllabusContent, SyllabusIssue, SyllabusPlo, SyllabusRubric, SyllabusSettings, SyllabusTemplate } from '@ams/shared';
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

function Section({ id, title, help, issues, children }: { id: SectionKey; title: string; help: string; issues: SyllabusIssue[]; children: React.ReactNode }) {
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
      {issues.length > 0 && (
        <ul aria-label={`Issues in ${title}`} className="space-y-0.5 text-xs">
          {issues.map((x, k) => <li key={k} className={x.severity === 'error' ? 'text-red-800' : 'text-amber-800'}>{x.severity === 'error' ? 'Error: ' : 'Warning: '}{x.message}</li>)}
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
}

export function SyllabusEditor({ content: c, onChange, plos, levels, courses, courseId, code, issues, settings, template }: SyllabusEditorProps) {
  const set = (patch: Partial<SyllabusContent>) => onChange({ ...c, ...patch });
  const setInfo = (p: Partial<SyllabusContent['info']>) => set({ info: { ...c.info, ...p } });
  const of = (s: SectionKey) => issues.filter((x) => x.section === s);
  const refIssues = (ref: string) => issues.filter((x) => x.ref === ref);
  const sec = (key: string) => template.sections.find((s) => s.key === key);
  const cloOptions = c.clos.map((x) => ({ id: x.id, text: x.code }));
  const recode = (clos: SyllabusContent['clos']) => clos.map((x, k) => ({ ...x, code: `CLO${k + 1}` }));
  const weights = cloWeights(c);
  const otherCourses = courses.filter((x) => x.id !== courseId);
  const programs = [...new Set(plos.map((p) => p.programName))];
  const hint = (key: string) => (sec(key)?.help ?? '');
  const title = (key: string, fallback: string) => sec(key)?.title ?? fallback;
  const Row = ({ about }: { about: string }) => <>{refIssues(about).map((x, k) => <p key={k} role="alert" className={`text-xs ${x.severity === 'error' ? 'text-red-800' : 'text-amber-800'}`}>{x.message}</p>)}</>;

  return (
    <div className="space-y-4" data-testid="syllabus-editor">
      <Section id="info" title={title('info', 'Basic course information')} help={hint('info')} issues={of('info')}>
        <div className="grid gap-3 sm:grid-cols-6">
          <div className={`${field} sm:col-span-1`}>Course code<Input aria-label="Course code" value={code} readOnly disabled /></div>
          <label className={`${field} sm:col-span-3`}>Course title (English)<Input aria-label="Course title (English)" value={c.info.titleEn} onChange={(e) => setInfo({ titleEn: e.target.value })} /></label>
          <label className={`${field} sm:col-span-2`}>Course title (Arabic)<Input aria-label="Course title (Arabic)" dir="auto" value={c.info.titleAr} onChange={(e) => setInfo({ titleAr: e.target.value })} /></label>
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
          <div className={`${field} sm:col-span-3`}>Prerequisite(s)<Chips ariaLabel="Prerequisites" options={otherCourses.map((x) => ({ id: x.id, text: x.code }))} value={c.info.prerequisiteIds} onChange={(v) => setInfo({ prerequisiteIds: v })} /></div>
          <div className={`${field} sm:col-span-3`}>Co-requisite(s)<Chips ariaLabel="Co-requisites" options={otherCourses.map((x) => ({ id: x.id, text: x.code }))} value={c.info.corequisiteIds} onChange={(v) => setInfo({ corequisiteIds: v })} /></div>
        </div>
      </Section>

      <Section id="description" title={title('description', 'Course description')} help={hint('description')} issues={of('description')}>
        <label className={field}>Description (English)<textarea aria-label="Description (English)" rows={5} className={area} value={c.description.en} onChange={(e) => set({ description: { ...c.description, en: e.target.value } })} /></label>
        <label className={field}>Description (Arabic)<textarea aria-label="Description (Arabic)" dir="auto" rows={3} className={area} value={c.description.ar} onChange={(e) => set({ description: { ...c.description, ar: e.target.value } })} /></label>
      </Section>

      <Section id="clos" title={title('clos', 'Course learning outcomes (CLOs)')} help={`${hint('clos')} Between ${settings.minClos} and ${settings.maxClos} CLOs, mapping to ${settings.minPlos} to ${settings.maxPlos} PLOs.`} issues={of('clos')}>
        {plos.length === 0 && <p className="text-xs text-amber-800">This course serves no program with PLOs yet: put it in a program (Settings, Organization, Courses) before mapping CLOs.</p>}
        <div className="space-y-3">
          {c.clos.map((x, k) => (
            <div key={x.id} className="space-y-1 rounded-md border border-border p-2" data-testid="clo-row">
              <div className="grid gap-2 sm:grid-cols-12">
                <div className="flex items-center text-sm font-semibold sm:col-span-1">{x.code}</div>
                <label className={`${field} sm:col-span-5`}>Outcome (English)<textarea aria-label={`${x.code} text`} rows={2} className={area} value={x.textEn} onChange={(e) => set({ clos: replaceAt(c.clos, k, { ...x, textEn: e.target.value }) })} /></label>
                <label className={`${field} sm:col-span-2`}>Bloom level
                  <select aria-label={`${x.code} Bloom level`} className={select} value={x.bloom} onChange={(e) => set({ clos: replaceAt(c.clos, k, { ...x, bloom: e.target.value }) })}>
                    <option value="">Choose</option>{BLOOM_LEVELS.map((v) => <option key={v} value={v}>{label(v)}</option>)}
                  </select>
                </label>
                <label className={`${field} sm:col-span-2`}>PLO
                  <select aria-label={`${x.code} PLO`} className={select} value={x.ploId} onChange={(e) => set({ clos: replaceAt(c.clos, k, { ...x, ploId: e.target.value }) })}>
                    <option value="">Choose</option>
                    {programs.map((pn) => <optgroup key={pn} label={pn}>{plos.filter((p) => p.programName === pn).map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</optgroup>)}
                  </select>
                </label>
                <label className={`${field} sm:col-span-2`}>Coverage
                  <select aria-label={`${x.code} coverage`} className={select} value={x.level} onChange={(e) => set({ clos: replaceAt(c.clos, k, { ...x, level: e.target.value }) })}>
                    <option value="">Choose</option>{levels.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                  </select>
                </label>
              </div>
              <div className="flex items-start justify-between gap-2"><div><Row about={x.id} /></div><Button type="button" variant="ghost" onClick={() => set({ clos: recode(removeAt(c.clos, k)) })} aria-label={`Remove ${x.code}`}>Remove</Button></div>
            </div>
          ))}
        </div>
        <Button type="button" variant="outline" onClick={() => set({ clos: recode([...c.clos, { id: newId(), code: '', textEn: '', textAr: '', bloom: '', ploId: '', level: '' }]) })}>+ CLO</Button>
      </Section>

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

      <Section id="methodology" title={title('methodology', 'Teaching methodology')} help={hint('methodology')} issues={of('methodology')}>
        <textarea aria-label="Teaching methodology" rows={4} className={area} value={c.methodology} onChange={(e) => set({ methodology: e.target.value })} />
      </Section>

      <Section id="assessments" title={title('assessments', 'Assessment plan')} help={hint('assessments')} issues={of('assessments')}>
        <div className="space-y-3">
          {c.assessments.map((a, k) => {
            const setA = (p: Partial<SyllabusAssessment>) => set({ assessments: replaceAt(c.assessments, k, { ...a, ...p }) });
            const assesses = (cloId: string) => a.clos.find((l) => l.cloId === cloId);
            return (
              <div key={a.id} className="space-y-2 rounded-md border border-border p-3" data-testid="assessment-row">
                <div className="grid gap-2 sm:grid-cols-12">
                  <label className={`${field} sm:col-span-4`}>Assessment<Input aria-label={`Assessment ${k + 1} name`} value={a.name} onChange={(e) => setA({ name: e.target.value })} /></label>
                  <label className={`${field} sm:col-span-3`}>Category
                    <select aria-label={`Assessment ${k + 1} category`} className={select} value={a.category} onChange={(e) => setA({ category: e.target.value })}>
                      <option value="">Choose</option>{ASSESSMENT_CATEGORIES.map((v) => <option key={v} value={v}>{label(v)}</option>)}
                    </select>
                  </label>
                  <label className={`${field} sm:col-span-2`}>% of grade<Num ariaLabel={`Assessment ${k + 1} weight`} value={a.weight} onChange={(v) => setA({ weight: v })} /></label>
                  <label className={`${field} sm:col-span-2`}>Due week<Num ariaLabel={`Assessment ${k + 1} due week`} value={a.dueWeek} onChange={(v) => setA({ dueWeek: v })} /></label>
                  <div className="flex items-end sm:col-span-1"><Button type="button" variant="ghost" aria-label={`Remove assessment ${k + 1}`} onClick={() => set({ assessments: removeAt(c.assessments, k), outline: c.outline.map((w) => (w.assessmentId === a.id ? { ...w, assessmentId: '' } : w)) })}>Remove</Button></div>
                </div>
                <label className={field}>Objective<Input aria-label={`Assessment ${k + 1} objective`} value={a.objective} onChange={(e) => setA({ objective: e.target.value })} /></label>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">CLOs it assesses, their share of this assessment, and the rubric for each</p>
                  {c.clos.length === 0 && <p className="text-xs text-muted-foreground">Add CLOs first.</p>}
                  {c.clos.map((x) => {
                    const l = assesses(x.id);
                    return (
                      <div key={x.id} className="grid items-center gap-2 sm:grid-cols-12">
                        <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" aria-label={`Assessment ${k + 1} assesses ${x.code}`} checked={!!l}
                          onChange={(e) => setA({ clos: e.target.checked ? [...a.clos, { cloId: x.id, share: null, rubricId: c.rubrics[0]?.id ?? '' }] : a.clos.filter((y) => y.cloId !== x.id) })} />{x.code}
                          <span className="text-xs text-muted-foreground">{Math.round((weights.get(x.id) ?? 0) * 10) / 10}% of grade</span></label>
                        {l && <label className="sm:col-span-3"><span className="sr-only">{`${x.code} share of assessment ${k + 1}`}</span><Num ariaLabel={`${x.code} share of assessment ${k + 1}`} value={l.share} onChange={(v) => setA({ clos: a.clos.map((y) => (y.cloId === x.id ? { ...y, share: v } : y)) })} /></label>}
                        {l && <label className="sm:col-span-6"><span className="sr-only">{`${x.code} rubric in assessment ${k + 1}`}</span>
                          <select aria-label={`${x.code} rubric in assessment ${k + 1}`} className={select} value={l.rubricId} onChange={(e) => setA({ clos: a.clos.map((y) => (y.cloId === x.id ? { ...y, rubricId: e.target.value } : y)) })}>
                            <option value="">No rubric</option>{c.rubrics.map((r) => <option key={r.id} value={r.id}>{r.title || 'Untitled rubric'}</option>)}
                          </select></label>}
                      </div>
                    );
                  })}
                  {a.clos.length > 0 && <Button type="button" variant="ghost" onClick={() => setA({ clos: a.clos.map((y) => ({ ...y, share: Math.round((10000 / a.clos.length)) / 100 })) })}>Split the shares evenly</Button>}
                </div>
                <Row about={a.id} />
              </div>
            );
          })}
        </div>
        <Button type="button" variant="outline" onClick={() => set({ assessments: [...c.assessments, { id: newId(), name: '', category: '', objective: '', weight: null, dueWeek: null, clos: [] }] })}>+ Assessment</Button>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field}>Pass percentage and submission details<textarea aria-label="Pass percentage and submission details" rows={2} className={area} value={c.assessmentNotes.passPercentage} onChange={(e) => set({ assessmentNotes: { ...c.assessmentNotes, passPercentage: e.target.value } })} /></label>
          <label className={field}>How assignments, quizzes and exams work<textarea aria-label="How assessments work" rows={2} className={area} value={c.assessmentNotes.howItWorks} onChange={(e) => set({ assessmentNotes: { ...c.assessmentNotes, howItWorks: e.target.value } })} /></label>
        </div>
      </Section>

      <Section id="rubrics" title={title('rubrics', 'Rubrics')} help={hint('rubrics')} issues={of('rubrics')}>
        <div className="space-y-3">
          {c.rubrics.map((r, k) => {
            const setR = (p: Partial<SyllabusRubric>) => set({ rubrics: replaceAt(c.rubrics, k, { ...r, ...p }) });
            const pad = (ds: string[]) => r.levels.map((_, j) => ds[j] ?? '');
            return (
              <div key={r.id} className="space-y-2 rounded-md border border-border p-3" data-testid="rubric-row">
                <div className="flex flex-wrap items-end gap-2">
                  <label className={`${field} grow`}>Rubric title<Input aria-label={`Rubric ${k + 1} title`} value={r.title} onChange={(e) => setR({ title: e.target.value })} /></label>
                  <Button type="button" variant="ghost" aria-label={`Remove rubric ${k + 1}`} onClick={() => set({ rubrics: removeAt(c.rubrics, k), assessments: c.assessments.map((a) => ({ ...a, clos: a.clos.map((l) => (l.rubricId === r.id ? { ...l, rubricId: '' } : l)) })) })}>Remove</Button>
                </div>
                <p className="text-xs font-medium text-muted-foreground">Performance levels</p>
                <div className="flex flex-wrap gap-2">
                  {r.levels.map((l, j) => (
                    <div key={j} className="flex items-center gap-1">
                      <Input aria-label={`Rubric ${k + 1} level ${j + 1} name`} className="w-32" value={l.name} onChange={(e) => setR({ levels: replaceAt(r.levels, j, { ...l, name: e.target.value }) })} />
                      <Num className="w-16" ariaLabel={`Rubric ${k + 1} level ${j + 1} from`} value={l.min} onChange={(v) => setR({ levels: replaceAt(r.levels, j, { ...l, min: v }) })} />
                      <Num className="w-16" ariaLabel={`Rubric ${k + 1} level ${j + 1} to`} value={l.max} onChange={(v) => setR({ levels: replaceAt(r.levels, j, { ...l, max: v }) })} />
                      <Button type="button" variant="ghost" aria-label={`Remove level ${j + 1} of rubric ${k + 1}`} onClick={() => setR({ levels: removeAt(r.levels, j), criteria: r.criteria.map((q) => ({ ...q, descriptions: removeAt(pad(q.descriptions), j) })) })}>✕</Button>
                    </div>
                  ))}
                  <Button type="button" variant="outline" onClick={() => setR({ levels: [...r.levels, { name: '', min: null, max: null }], criteria: r.criteria.map((q) => ({ ...q, descriptions: [...pad(q.descriptions), ''] })) })}>+ Level</Button>
                </div>
                <p className="text-xs font-medium text-muted-foreground">Criteria, with a description at every level</p>
                {r.criteria.map((q, j) => (
                  <div key={j} className="space-y-1 rounded border border-border/60 p-2">
                    <div className="flex items-end gap-2">
                      <label className={`${field} grow`}>Criterion<Input aria-label={`Rubric ${k + 1} criterion ${j + 1} name`} value={q.name} onChange={(e) => setR({ criteria: replaceAt(r.criteria, j, { ...q, name: e.target.value }) })} /></label>
                      <Button type="button" variant="ghost" aria-label={`Remove criterion ${j + 1} of rubric ${k + 1}`} onClick={() => setR({ criteria: removeAt(r.criteria, j) })}>Remove</Button>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      {r.levels.map((l, m) => (
                        <label key={m} className={field}>{l.name || `Level ${m + 1}`}
                          <textarea aria-label={`Rubric ${k + 1} criterion ${j + 1} at ${l.name || `level ${m + 1}`}`} rows={2} className={area} value={pad(q.descriptions)[m] ?? ''}
                            onChange={(e) => setR({ criteria: replaceAt(r.criteria, j, { ...q, descriptions: replaceAt(pad(q.descriptions), m, e.target.value) }) })} />
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <Button type="button" variant="outline" onClick={() => setR({ criteria: [...r.criteria, { name: '', descriptions: r.levels.map(() => '') }] })}>+ Criterion</Button>
                <Row about={r.id} />
              </div>
            );
          })}
        </div>
        <Button type="button" variant="outline" onClick={() => set({ rubrics: [...c.rubrics, { id: newId(), title: '', levels: [{ name: 'Exemplary', min: 90, max: 100 }, { name: 'Proficient', min: 70, max: 89 }, { name: 'Developing', min: 50, max: 69 }, { name: 'Beginning', min: 0, max: 49 }], criteria: [] }] })}>+ Rubric</Button>
      </Section>
    </div>
  );
}
