import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReviewFinding, ReviewRubric } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useAction } from '../../lib/use-action';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
// Colours by position on the scale; "pending" is grey. The words are the rubric's own (configuration).
const TONE: Record<string, string> = {
  not_evident: 'bg-red-100 text-red-900', emerging: 'bg-orange-100 text-orange-900', developing: 'bg-amber-100 text-amber-900',
  established: 'bg-emerald-100 text-emerald-900', pending: 'bg-muted text-muted-foreground',
};
const tone = (code: string | undefined) => (code ? TONE[code] ?? 'bg-sky-100 text-sky-900' : 'text-muted-foreground');
const levelName = (r: ReviewRubric, code: string | undefined) => r.levels.find((l) => l.code === code)?.name ?? code ?? '—';

/** Programs x criteria: the latest level of each (TASK-118). A row opens the program. */
export function ReviewHeatmap({ api: override, onOpen }: { api?: OutcomesApi; onOpen: (programId: string) => void }) {
  const api = useOutcomesApi(override);
  const data = useQuery({ queryKey: ['program-reviews'], queryFn: () => api.reviewSummary() });
  const v = data.data;
  if (!v) return <p className="text-sm text-muted-foreground">{data.isError ? 'Could not load the review.' : 'Loading…'}</p>;
  const schools = [...new Set(v.programs.map((p) => p.school ?? 'No unit'))];
  return (
    <section aria-label="Program review" className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold">{v.rubric.name}</h3>
        <p className="text-sm text-muted-foreground">The latest finding per program and criterion. Levels are internal maturity, not an accreditation judgement. Open a program for the findings and their history.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="text-sm" aria-label="Review by program and criterion">
          <thead>
            <tr>
              <th className="sticky start-0 bg-background px-2 py-1 text-start">Program</th>
              {v.rubric.criteria.map((c) => <th key={c.no} className="px-1 py-1 text-xs font-medium" title={c.questions}>{c.no}. {c.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {schools.map((s) => (
              <Fragment key={s}>
                <tr><th colSpan={v.rubric.criteria.length + 1} className="bg-muted/50 px-2 py-1 text-start text-xs font-semibold">{s}</th></tr>
                {v.programs.filter((p) => (p.school ?? 'No unit') === s).map((p) => (
                  <tr key={p.programId} className="border-t border-border">
                    <th scope="row" className="sticky start-0 bg-background px-2 py-1 text-start font-normal">
                      <button type="button" className="text-start underline-offset-2 hover:underline" onClick={() => onOpen(p.programId)}><ContentText>{p.name}</ContentText></button>
                    </th>
                    {v.rubric.criteria.map((c) => {
                      const code = p.levels[String(c.no)];
                      return <td key={c.no} className="px-0.5 py-0.5"><span className={`block rounded px-1.5 py-0.5 text-center text-xs ${tone(code)}`} aria-label={`${p.name}, ${c.name}: ${levelName(v.rubric, code)}`}>{code ? levelName(v.rubric, code) : '—'}</span></td>;
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{v.rubric.levels.map((l) => `${l.name}: ${l.description}`).join(' · ')}</p>
    </section>
  );
}

/** A program's review: per criterion the latest finding, its history, and "Add finding" (a new judgement; earlier ones stay). */
export function ProgramReviewCard({ programId, canWrite, api: override }: { programId: string; canWrite: boolean; api?: OutcomesApi }) {
  const api = useOutcomesApi(override);
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['program-review', programId], queryFn: () => api.programReview(programId) });
  const [adding, setAdding] = useState<number | null>(null);
  const [history, setHistory] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const add = useMutation({
    mutationFn: (f: { criterionNo: number; level: string; finding: string; evidence: string; gaps: string }) => { setError(null); return act(() => api.addFinding(programId, { ...f, evidence: f.evidence || null, gaps: f.gaps || null, basis: 'Entered in the AMS' })); },
    onSuccess: (r) => { if (r) { setAdding(null); void qc.invalidateQueries({ queryKey: ['program-review', programId] }); void qc.invalidateQueries({ queryKey: ['program-reviews'] }); } },
  });
  const v = data.data;
  return (
    <Card aria-label="Review">
      <h4 className="mb-2 font-semibold">Review{v ? `: ${v.rubric.name}` : ''}</h4>
      {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
      {!v ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <ol className="space-y-3">
          {v.rubric.criteria.map((c) => {
            const mine = v.findings.filter((f) => f.criterionNo === c.no);
            const cur = mine[0];
            return (
              <li key={c.no} className="space-y-1" aria-label={`${c.no}. ${c.name}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.no}. {c.name}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${tone(cur?.level)}`}>{cur ? levelName(v.rubric, cur.level) : 'Not reviewed'}</span>
                  {cur && <span className="text-xs text-muted-foreground">{cur.auditDate} · pass {cur.pass}{cur.basis ? ` · ${cur.basis}` : ''}</span>}
                  {mine.length > 1 && <button type="button" className="text-xs underline" aria-expanded={history === c.no} onClick={() => setHistory(history === c.no ? null : c.no)}>{mine.length - 1} earlier</button>}
                  {canWrite && adding !== c.no && <Button type="button" variant="ghost" className="px-2 py-0.5 text-xs" onClick={() => setAdding(c.no)}>Add finding</Button>}
                </div>
                {cur && <FindingText f={cur} />}
                {history === c.no && <ul className="ms-3 space-y-1 border-s border-border ps-3">{mine.slice(1).map((f) => <li key={f.id}><span className={`me-2 rounded px-1 text-xs ${tone(f.level)}`}>{levelName(v.rubric, f.level)}</span><span className="text-xs text-muted-foreground">{f.auditDate} · pass {f.pass}</span><FindingText f={f} /></li>)}</ul>}
                {adding === c.no && <FindingForm rubric={v.rubric} criterionNo={c.no} hint={c.questions} onCancel={() => setAdding(null)} onSubmit={(f) => add.mutate(f)} />}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function FindingText({ f }: { f: ReviewFinding }) {
  return (
    <div className="text-sm">
      <ContentText className="block">{f.finding}</ContentText>
      {f.evidence && <p className="text-xs text-muted-foreground">Evidence: <ContentText>{f.evidence}</ContentText></p>}
      {f.gaps && <p className="text-xs text-muted-foreground">Gaps: <ContentText>{f.gaps}</ContentText></p>}
    </div>
  );
}

function FindingForm({ rubric, criterionNo, hint, onSubmit, onCancel }: { rubric: ReviewRubric; criterionNo: number; hint: string; onSubmit: (f: { criterionNo: number; level: string; finding: string; evidence: string; gaps: string }) => void; onCancel: () => void }) {
  const [f, setF] = useState({ level: rubric.levels[0]?.code ?? '', finding: '', evidence: '', gaps: '' });
  return (
    <form className="grid gap-2 rounded border border-border p-2 sm:grid-cols-4" aria-label={`Add finding on criterion ${criterionNo}`} onSubmit={(e) => { e.preventDefault(); if (f.finding.trim()) onSubmit({ criterionNo, ...f }); }}>
      <p className="text-xs text-muted-foreground sm:col-span-4">{hint}</p>
      <select aria-label="Level" className={select} value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}>
        {rubric.levels.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
      </select>
      <Input aria-label="Finding" className="sm:col-span-3" value={f.finding} onChange={(e) => setF({ ...f, finding: e.target.value })} placeholder="What exists and the main gap" required />
      <Input aria-label="Evidence seen" className="sm:col-span-2" value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} placeholder="Document, page or section" />
      <Input aria-label="Gaps" className="sm:col-span-2" value={f.gaps} onChange={(e) => setF({ ...f, gaps: e.target.value })} placeholder="What to request" />
      <div className="flex gap-2 sm:col-span-4"><Button type="submit" disabled={!f.finding.trim()}>Add finding</Button><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}
