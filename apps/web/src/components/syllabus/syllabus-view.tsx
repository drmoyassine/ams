// The syllabus in the layout of the AIU Course Syllabus Template, read-only. It is also what is printed.
import { cloWeights, type OutcomeLevel, type SyllabusContent, type SyllabusPlo, type SyllabusTemplate } from '@ams/shared';
import { ContentText } from '../content-text';
import { label, LEVEL_NAME } from './labels';

const th = 'border border-border bg-muted/50 px-2 py-1 text-start text-xs font-medium';
const td = 'border border-border px-2 py-1 align-top text-sm';
const dash = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '—' : String(v));

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-2 break-inside-avoid" aria-label={title}><h3 className="text-sm font-semibold">{title}</h3>{children}</section>;
}
function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto"><table className="w-full border-collapse text-sm">
      <thead><tr>{head.map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={td}>{c}</td>)}</tr>)}</tbody>
    </table></div>
  );
}
function Facts({ rows }: { rows: [string, string][] }) {
  return <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">{rows.map(([k, v]) => <div key={k} className="flex gap-2 text-sm"><dt className="w-44 shrink-0 text-muted-foreground">{k}</dt><dd className="min-w-0 break-words"><ContentText>{v}</ContentText></dd></div>)}</dl>;
}

export function SyllabusView({ content: c, code, plos, levels, courses, template }: { content: SyllabusContent; code: string; plos: SyllabusPlo[]; levels: OutcomeLevel[]; courses: { id: string; code: string }[]; template?: SyllabusTemplate }) {
  const i = c.info;
  const courseCode = (id: string) => courses.find((x) => x.id === id)?.code ?? id;
  const plo = (id: string) => plos.find((p) => p.id === id);
  const cloCode = (id: string) => c.clos.find((x) => x.id === id)?.code ?? '?';
  const weights = cloWeights(c);
  const contact = (i.contactLecture ?? 0) + (i.contactLab ?? 0) + (i.contactOther ?? 0);
  return (
    <article className="space-y-6" aria-label="Syllabus" data-testid="syllabus-view">
      <Block title="Basic course information">
        <Facts rows={[
          ['Course code and title', `${code}  ${i.titleEn}${i.titleAr ? `  ·  ${i.titleAr}` : ''}`], ['Language of delivery', label(i.languageOfDelivery) || '—'],
          ['Credit hours', dash(i.credits)], ['Contact hours per week', `${contact}  (lecture ${dash(i.contactLecture)}, lab ${dash(i.contactLab)}, other ${dash(i.contactOther)})`],
          ['Prerequisite(s)', i.prerequisiteIds.map(courseCode).join(', ') || '—'], ['Co-requisite(s)', i.corequisiteIds.map(courseCode).join(', ') || '—'],
          ['Course type', label(i.courseType) || '—'], ['Course level', dash(i.courseLevel)], ['Course category', label(i.category) || '—'], ['Sustainability indicator', label(i.sustainability) || '—'],
        ]} />
      </Block>
      <Block title="Course description">
        <p className="whitespace-pre-line text-sm"><ContentText>{c.description.en || '—'}</ContentText></p>
        {c.description.ar && <p className="whitespace-pre-line text-sm" dir="auto"><ContentText>{c.description.ar}</ContentText></p>}
      </Block>
      <Block title="Course learning outcomes (CLOs) and the PLO each serves">
        <Table head={['CLO', 'Outcome', 'Bloom level', 'PLO', 'Coverage']} empty="No CLOs yet."
          rows={c.clos.map((x) => [x.code, <ContentText key="t">{x.textEn}</ContentText>, label(x.bloom) || '—', plo(x.ploId) ? `${plo(x.ploId)!.code} · ${plo(x.ploId)!.programName}` : '—', x.level ? LEVEL_NAME(levels, x.level) : '—'])} />
      </Block>
      <Block title="Course outline">
        <Table head={['Week', 'Topic (and reading)', 'Lab / other', 'CLOs', 'SDGs', 'Assessment']} empty="No weeks yet."
          rows={[...c.outline].sort((a, b) => (a.week ?? 0) - (b.week ?? 0)).map((w) => [dash(w.week), <span key="t"><ContentText>{w.topic}</ContentText>{w.reading && <span className="block text-xs text-muted-foreground">Reading: {w.reading}</span>}</span>, dash(w.lab), w.cloIds.map(cloCode).join(', ') || '—', w.sdgs.join(', ') || '—', c.assessments.find((a) => a.id === w.assessmentId)?.name ?? '—'])} />
      </Block>
      <Block title="Textbooks, materials and software">
        <Table head={['Kind', 'Citation', 'ISBN', 'Year']} empty="None yet." rows={c.materials.map((m) => [label(m.kind), <ContentText key="c">{m.citation}</ContentText>, dash(m.isbn), dash(m.year)])} />
      </Block>
      <Block title="Teaching methodology"><p className="whitespace-pre-line text-sm"><ContentText>{c.methodology || '—'}</ContentText></p></Block>
      <Block title="Assessment plan and evaluation methods">
        <Table head={['Assessment', 'Category', 'CLOs assessed (share, rubric)', '% of grade', 'Due']} empty="No assessments yet."
          rows={c.assessments.map((a) => [<ContentText key="n">{a.name}</ContentText>, label(a.category), a.clos.map((l) => `${cloCode(l.cloId)} ${dash(l.share)}% · ${c.rubrics.find((r) => r.id === l.rubricId)?.title ?? 'no rubric'}`).join('; ') || '—', dash(a.weight), a.dueWeek ? `Week ${a.dueWeek}` : '—'])} />
        {c.assessments.length > 0 && <p className="text-xs text-muted-foreground">Total {c.assessments.reduce((s, a) => s + (a.weight ?? 0), 0)}%. Share of the grade by CLO: {c.clos.map((x) => `${x.code} ${Math.round((weights.get(x.id) ?? 0) * 10) / 10}%`).join(', ')}.</p>}
        {(c.assessmentNotes.passPercentage || c.assessmentNotes.howItWorks) && <p className="whitespace-pre-line text-sm"><ContentText>{[c.assessmentNotes.passPercentage, c.assessmentNotes.howItWorks].filter(Boolean).join('\n')}</ContentText></p>}
      </Block>
      {(template?.sections ?? []).filter((x) => x.key.startsWith('custom:') && c.custom[x.key]?.trim()).map((x) => (
        <Block key={x.key} title={x.title}><p className="whitespace-pre-line text-sm"><ContentText>{c.custom[x.key]!}</ContentText></p></Block>
      ))}
      {c.rubrics.length > 0 && (
        <Block title="Rubrics">
          {c.rubrics.map((r) => (
            <div key={r.id} className="space-y-1">
              <p className="text-sm font-medium"><ContentText>{r.title}</ContentText></p>
              <Table head={['Criterion', ...r.levels.map((l) => `${l.name}${l.min !== null || l.max !== null ? ` (${dash(l.min)}-${dash(l.max)})` : ''}`)]} empty="No criteria." rows={r.criteria.map((k) => [<ContentText key="k">{k.name}</ContentText>, ...r.levels.map((_, j) => k.descriptions[j] ?? '')])} />
            </div>
          ))}
        </Block>
      )}
    </article>
  );
}
