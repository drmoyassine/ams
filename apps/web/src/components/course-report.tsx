// The Course Report (TASK-120): a report is not evidence. It draws on the values of KPIs. This one is generated for one course and
// one term from every KPI whose scope is course and whose rows carry the columns course, term and outcome: for each outcome, the
// share of students at or above the target (against its target) and the other measures the KPIs hold (survey mean, response rate).
// It never says "met": an outcome is "at or above target" or "below target".
import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { DataColumn, EvidenceItem } from '@ams/shared';
import type { EvidenceApi } from '../lib/evidence-api';
import { ContentText } from './content-text';
import { KpiTile } from './kpi-card';
import { Button } from './ui/button';

type Row = Record<string, string | number | boolean | null>;
interface Source { item: EvidenceItem; versionNo: number; columns: DataColumn[]; rows: Row[] }

const text = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
const select = 'h-9 rounded-md border border-border bg-background px-2 text-sm';

/** Outcomes that sort as people expect: SO2 before SO10. */
const byOutcome = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** The KPIs a course report can be made from, with their latest values. */
function useSources(api: EvidenceApi, items: EvidenceItem[]): { sources: Source[]; loading: boolean } {
  const kpis = items.filter((i) => i.kpi?.scope === 'course' && i.latest && i.latest.rowCount !== null && i.status === 'active');
  const results = useQueries({ queries: kpis.map((i) => ({ queryKey: ['evidence-version-data', i.latest!.id], queryFn: () => api.versionData(i.latest!.id) })) });
  const sources: Source[] = [];
  results.forEach((r, n) => {
    const item = kpis[n]!;
    if (!r.data) return;
    const keys = new Set(r.data.columns.map((c) => c.key));
    if (['course', 'term', 'outcome'].every((k) => keys.has(k))) sources.push({ item, versionNo: item.latest!.versionNo, columns: r.data.columns, rows: r.data.rows as Row[] });
  });
  return { sources, loading: results.some((r) => r.isLoading) };
}

export function CourseReport({ api, items }: { api: EvidenceApi; items: EvidenceItem[] }) {
  const { sources, loading } = useSources(api, items);
  const courses = useMemo(() => [...new Set(sources.flatMap((s) => s.rows.map((r) => text(r.course))))].filter(Boolean).sort(), [sources]);
  const [course, setCourse] = useState('');
  const [term, setTerm] = useState('');
  const chosenCourse = course || courses[0] || '';
  const terms = useMemo(() => [...new Set(sources.flatMap((s) => s.rows.filter((r) => text(r.course) === chosenCourse).map((r) => text(r.term))))].sort().reverse(), [sources, chosenCourse]);
  const chosenTerm = terms.includes(term) ? term : terms[0] ?? '';

  if (loading) return <p className="text-sm">Loading…</p>;
  if (!sources.length) {
    return <p className="text-sm text-muted-foreground">No course-scope KPI has values yet. A Course Report is made from KPIs whose scope is Course and whose values say the course, the term and the outcome.</p>;
  }
  const parts = sources.map((s) => ({ ...s, rows: s.rows.filter((r) => text(r.course) === chosenCourse && text(r.term) === chosenTerm) })).filter((s) => s.rows.length);
  const outcomes = [...new Set(parts.flatMap((p) => p.rows.map((r) => text(r.outcome))))].sort(byOutcome);

  return (
    <div className="space-y-4" data-testid="course-report">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">Course
          <select aria-label="Course" className={select} value={chosenCourse} onChange={(e) => { setCourse(e.target.value); setTerm(''); }}>
            {courses.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">Term
          <select aria-label="Term" className={select} value={chosenTerm} onChange={(e) => setTerm(e.target.value)}>
            {terms.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <Button type="button" variant="outline" className="ms-auto print:hidden" onClick={() => window.print()}>Print or save as PDF</Button>
      </div>

      <article className="space-y-4 rounded-lg border border-border p-4" aria-label="Course report">
        <header>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Course Report</p>
          <h2 className="text-lg font-semibold"><ContentText>{chosenCourse}</ContentText> · {chosenTerm}</h2>
          <p className="text-xs text-muted-foreground">Generated from {parts.length === 1 ? 'one KPI' : `${parts.length} KPIs`} of this course and term. Each figure is a value of the KPI named under the table; nothing is typed in here.</p>
        </header>

        {parts.map((p) => {
          const valueCol = p.columns.find((c) => c.type !== 'text' && c.key !== 'target');
          const target = p.columns.find((c) => c.key === 'target');
          const others = p.columns.filter((c) => !['course', 'term', 'outcome'].includes(c.key) && c.key !== valueCol?.key && c.key !== target?.key);
          const words = others.filter((c) => c.type === 'text');
          const figures = others.filter((c) => c.type !== 'text');
          return (
            <section key={p.item.id} aria-label={p.item.title} className="space-y-1">
              <h3 className="flex items-center gap-2 text-sm font-semibold">{p.item.kpi && <KpiTile card={p.item.kpi} />}<ContentText>{p.item.title}</ContentText></h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-sm">
                  <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-1 pe-2 font-medium">Outcome</th>
                    {words.map((c) => <th key={c.key} className="py-1 pe-2 font-medium">{c.label}</th>)}
                    {valueCol && <th className="py-1 pe-2 font-medium">{valueCol.label}</th>}
                    {target && <th className="py-1 pe-2 font-medium">{target.label}</th>}
                    {figures.map((c) => <th key={c.key} className="py-1 pe-2 font-medium">{c.label}</th>)}
                    {valueCol && target && <th className="py-1 font-medium">Against target</th>}
                  </tr></thead>
                  <tbody>
                    {[...p.rows].sort((a, b) => byOutcome(text(a.outcome), text(b.outcome))).map((r) => {
                      const v = valueCol ? num(r[valueCol.key]) : null;
                      const t = target ? num(r[target.key]) : null;
                      const ok = v !== null && t !== null ? v >= t : null;
                      return (
                        <tr key={text(r.outcome)} className="border-b border-border/60 last:border-0">
                          <td className="py-1 pe-2 font-medium"><ContentText>{text(r.outcome)}</ContentText></td>
                          {words.map((c) => <td key={c.key} className="py-1 pe-2 align-top"><ContentText>{text(r[c.key])}</ContentText></td>)}
                          {valueCol && <td className="py-1 pe-2">{v !== null ? `${v}${valueCol.unit === '%' ? '%' : ''}` : '—'}</td>}
                          {target && <td className="py-1 pe-2">{t !== null ? `${t}${target.unit === '%' ? '%' : ''}` : '—'}</td>}
                          {figures.map((c) => <td key={c.key} className="py-1 pe-2">{r[c.key] == null ? '—' : `${text(r[c.key])}${c.unit === '%' ? '%' : ''}`}</td>)}
                          {valueCol && target && (
                            <td className="py-1">{ok === null ? <span className="text-muted-foreground">—</span>
                              : ok ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-900">At or above target</span>
                                : <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">Below target</span>}</td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">KPI: {p.item.title}, version {p.versionNo}{p.item.kpi?.formula ? ` · ${p.item.kpi.formula}` : ''}</p>
            </section>
          );
        })}

        <p className="text-xs text-muted-foreground">{outcomes.length} outcome{outcomes.length === 1 ? '' : 's'} reported. Analysis, root causes and the action plan are written by the instructor in the course’s own report; this page shows the numbers they rest on.</p>
      </article>
    </div>
  );
}
