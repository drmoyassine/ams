// A course's assessments as tables (the owner, 2026-11-24): the assessments (type, name, week, weight); under each, the CLOs it assesses
// (each part of an assessment belongs to one CLO), the share of the assessment and the rubric that scores each; what each CLO is worth in
// the grade; and the rubrics the course uses. Rubrics are described at the institution's achievement scale and start from its templates
// (Settings, Outcomes & Syllabus); the limits come from the syllabus rules. A new row is not flagged until it is left.
import { useState } from 'react';
import {
  ASSESSMENT_CATEGORIES, LABEL, cloWeights, rubricFromTemplate, templateFor,
  type AchievementScale, type RubricTemplate, type SyllabusAssessment, type SyllabusAssessmentClo, type SyllabusContent, type SyllabusIssue, type SyllabusRubric, type SyllabusSettings,
} from '@ams/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog } from '../dialog';
import { RubricGrid } from './rubric-grid';

const newId = () => crypto.randomUUID();
const th = 'border-b border-border px-2 py-1.5 text-start text-xs font-medium text-muted-foreground';
const td = 'border-b border-border px-2 py-1.5 align-top';
const select = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm';
const pct = (n: number) => `${Math.round(n * 10) / 10}%`;
const num = (s: string): number | null => (s.trim() === '' || Number.isNaN(Number(s)) ? null : Number(s));

function NumCell({ value, onChange, label, className = 'w-16' }: { value: number | null; onChange: (v: number | null) => void; label: string; className?: string }) {
  return <Input aria-label={label} inputMode="decimal" className={className} value={value ?? ''} onChange={(e) => onChange(num(e.target.value))} />;
}

/** Even shares (two decimals, the last takes the rest so they add up to 100). */
function evenly(links: SyllabusAssessmentClo[]): SyllabusAssessmentClo[] {
  if (!links.length) return links;
  const each = Math.floor(10000 / links.length) / 100;
  return links.map((l, i) => ({ ...l, share: i === links.length - 1 ? Math.round((100 - each * (links.length - 1)) * 100) / 100 : each }));
}
/** The shares are still the even split (or empty): adding or removing a CLO splits them again. */
const isEven = (links: SyllabusAssessmentClo[]) => links.every((l) => l.share === null) || evenly(links).every((e, i) => Math.abs((e.share ?? 0) - (links[i]!.share ?? 0)) < 0.02);

export function AssessmentPlan({ content: c, onChange, scale, templates, settings, issues, fresh, onFresh }: {
  content: SyllabusContent; onChange: (c: SyllabusContent) => void; scale: AchievementScale; templates: RubricTemplate[]; settings: SyllabusSettings;
  issues: SyllabusIssue[];
  /** Rows just added: not flagged until the person leaves them. */
  fresh: ReadonlySet<string>; onFresh: (id: string, isFresh: boolean) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<SyllabusRubric | null>(null);
  const set = (patch: Partial<SyllabusContent>) => onChange({ ...c, ...patch });
  const levels = scale.levels.map((l) => l.name);
  const weights = cloWeights(c);
  const total = c.assessments.reduce((n, a) => n + (a.weight ?? 0), 0);
  const issuesOf = (ref: string) => (fresh.has(ref) ? [] : issues.filter((x) => x.ref === ref));
  const cloCode = (id: string) => c.clos.find((x) => x.id === id)?.code ?? '?';
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  /** The course rubric for a template: the copy the course already made, or a new copy (written against the scale). */
  const rubricFor = (t: RubricTemplate, rubrics: SyllabusRubric[]): [string, SyllabusRubric[]] => {
    const have = rubrics.find((r) => r.templateId === t.id);
    if (have) return [have.id, rubrics];
    const r = rubricFromTemplate(t, scale, newId());
    return [r.id, [...rubrics, r]];
  };
  const setAssessment = (k: number, a: SyllabusAssessment, rubrics = c.rubrics) => set({ assessments: c.assessments.map((x, i) => (i === k ? a : x)), rubrics });
  const addLink = (k: number, a: SyllabusAssessment, cloId: string) => {
    const t = templateFor(templates, a.category || 'other');
    const [rubricId, rubrics] = t ? rubricFor(t, c.rubrics) : ['', c.rubrics];
    const links = [...a.clos, { cloId, share: null, rubricId, part: '' }];
    setAssessment(k, { ...a, clos: isEven(a.clos) ? evenly(links) : links }, rubrics);
  };
  const removeLink = (k: number, a: SyllabusAssessment, j: number) => {
    const links = a.clos.filter((_, i) => i !== j);
    setAssessment(k, { ...a, clos: isEven(a.clos) ? evenly(links) : links });
  };
  const pickRubric = (k: number, a: SyllabusAssessment, j: number, value: string) => {
    let rubrics = c.rubrics;
    let rubricId = value;
    if (value.startsWith('tpl:')) {
      const t = templates.find((x) => x.id === value.slice(4));
      if (t) [rubricId, rubrics] = rubricFor(t, c.rubrics);
    } else if (value === 'new') {
      const r: SyllabusRubric = { id: newId(), title: `${a.name || LABEL[a.category] || 'Assessment'} rubric`, templateId: '', levels: scale.levels.map((l) => ({ ...l })), criteria: [{ name: '', descriptions: levels.map(() => '') }] };
      rubrics = [...rubrics, r]; rubricId = r.id;
      setEditing(r);
    }
    setAssessment(k, { ...a, clos: a.clos.map((l, i) => (i === j ? { ...l, rubricId } : l)) }, rubrics);
  };
  const openRubric = (r: SyllabusRubric) => setEditing({
    ...r, levels: scale.levels.map((l) => ({ ...l })),
    criteria: r.criteria.map((k) => ({ ...k, descriptions: levels.map((_, j) => k.descriptions[j] ?? '') })),
  });
  const usedBy = (id: string) => c.assessments.flatMap((a) => a.clos.filter((l) => l.rubricId === id).map((l) => `${a.name || 'Unnamed'} · ${cloCode(l.cloId)}`));

  return (
    <div className="space-y-6">
      {/* 1. The assessments */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] table-fixed border-collapse text-sm" aria-label="Assessments">
          <thead><tr><th className={`${th} w-9`} /><th className={`${th} w-32`}>Type</th><th className={th}>Assessment</th><th className={`${th} w-[4.5rem]`}>Week</th><th className={`${th} w-[4.5rem]`}>Weight %</th><th className={`${th} w-36`}>CLOs</th><th className={`${th} w-9`} /></tr></thead>
          {c.assessments.map((a, k) => {
            const isOpen = open.has(a.id) || fresh.has(a.id);
            const own = issuesOf(a.id);
            const setA = (p: Partial<SyllabusAssessment>) => setAssessment(k, { ...a, ...p });
            const free = c.clos.filter((x) => !a.clos.some((l) => l.cloId === x.id));
            return (
              <tbody key={a.id} data-testid="assessment-row"
                onBlur={(e) => { if (fresh.has(a.id) && !e.currentTarget.contains(e.relatedTarget as Node | null)) onFresh(a.id, false); }}>
                <tr className={own.some((x) => x.severity === 'error') ? 'bg-red-50/60' : ''}>
                  <td className={td}>
                    <button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} the CLOs of ${a.name || `assessment ${k + 1}`}`} className="rounded p-1 hover:bg-muted" onClick={() => toggle(a.id)}>
                      {isOpen ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4 rtl:rotate-180" aria-hidden="true" />}
                    </button>
                  </td>
                  <td className={td}>
                    <select aria-label={`Assessment ${k + 1} type`} className={select} value={a.category} onChange={(e) => setA({ category: e.target.value })}>
                      <option value="">Choose</option>{ASSESSMENT_CATEGORIES.map((v) => <option key={v} value={v}>{LABEL[v] ?? v}</option>)}
                    </select>
                  </td>
                  <td className={td}><Input aria-label={`Assessment ${k + 1} name`} value={a.name} placeholder="e.g. Midterm exam" onChange={(e) => setA({ name: e.target.value })} /></td>
                  <td className={td}><NumCell label={`Assessment ${k + 1} due week`} value={a.dueWeek} onChange={(v) => setA({ dueWeek: v })} /></td>
                  <td className={td}><NumCell label={`Assessment ${k + 1} weight`} value={a.weight} onChange={(v) => setA({ weight: v })} /></td>
                  <td className={td}>
                    {a.clos.length
                      ? <span className="flex flex-wrap gap-1">{a.clos.map((l) => <span key={l.cloId} className="rounded-full bg-muted px-2 py-0.5 text-xs">{cloCode(l.cloId)}</span>)}</span>
                      : <span className="text-xs text-muted-foreground">None yet</span>}
                    {!isOpen && own.length > 0 && (
                      <button type="button" className={`mt-1 block text-xs underline-offset-2 hover:underline ${own.some((x) => x.severity === 'error') ? 'text-red-800' : 'text-amber-800'}`} onClick={() => toggle(a.id)}>
                        {own.length} to fix
                      </button>
                    )}
                  </td>
                  <td className={`${td} text-center`}>
                    <button type="button" aria-label={`Remove assessment ${k + 1}`} className="rounded px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => set({ assessments: c.assessments.filter((_, i) => i !== k), outline: c.outline.map((w) => (w.assessmentId === a.id ? { ...w, assessmentId: '' } : w)) })}>✕</button>
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td className="border-b border-border" />
                    <td colSpan={6} className="border-b border-border bg-muted/30 px-2 py-2">
                      <table className="w-full table-fixed border-collapse text-sm" aria-label={`CLOs of ${a.name || `assessment ${k + 1}`}`}>
                        <thead><tr><th className={`${th} w-24`}>CLO</th><th className={`${th} w-36`}>Questions / part</th><th className={`${th} w-20`}>Share %</th><th className={th}>Rubric</th><th className={`${th} w-9`} /></tr></thead>
                        <tbody>
                          {a.clos.map((l, j) => {
                            const r = c.rubrics.find((x) => x.id === l.rubricId);
                            return (
                              <tr key={l.cloId} data-testid="assessment-clo">
                                <td className={td}>
                                  <select aria-label={`Assessment ${k + 1} CLO ${j + 1}`} className={select} value={l.cloId}
                                    onChange={(e) => setA({ clos: a.clos.map((y, i) => (i === j ? { ...y, cloId: e.target.value } : y)) })}>
                                    {[c.clos.find((x) => x.id === l.cloId), ...free].filter(Boolean).map((x) => <option key={x!.id} value={x!.id}>{x!.code}</option>)}
                                  </select>
                                </td>
                                <td className={td}><Input aria-label={`${cloCode(l.cloId)} part of assessment ${k + 1}`} placeholder="e.g. Q1–Q3" value={l.part ?? ''} onChange={(e) => setA({ clos: a.clos.map((y, i) => (i === j ? { ...y, part: e.target.value } : y)) })} /></td>
                                <td className={td}><NumCell label={`${cloCode(l.cloId)} share of assessment ${k + 1}`} value={l.share} onChange={(v) => setA({ clos: a.clos.map((y, i) => (i === j ? { ...y, share: v } : y)) })} /></td>
                                <td className={td}>
                                  <div className="flex min-w-0 gap-1">
                                    <select aria-label={`${cloCode(l.cloId)} rubric in assessment ${k + 1}`} className={`${select} min-w-0 flex-1`} value={l.rubricId} onChange={(e) => pickRubric(k, a, j, e.target.value)}>
                                      {!r && <option value="">Choose a rubric</option>}
                                      {c.rubrics.length > 0 && <optgroup label="This course's rubrics">{c.rubrics.map((x) => <option key={x.id} value={x.id}>{x.title || 'Untitled rubric'}</option>)}</optgroup>}
                                      <optgroup label="Start from a template">{templates.filter((t) => !c.rubrics.some((x) => x.templateId === t.id)).map((t) => <option key={t.id} value={`tpl:${t.id}`}>{t.title}</option>)}</optgroup>
                                      <option value="new">A new rubric…</option>
                                    </select>
                                    {r && <Button type="button" variant="outline" className="h-9 px-3" onClick={() => openRubric(r)}>Edit</Button>}
                                  </div>
                                </td>
                                <td className={`${td} text-center`}><button type="button" aria-label={`Remove ${cloCode(l.cloId)} from assessment ${k + 1}`} className="rounded px-1.5 text-muted-foreground hover:bg-muted" onClick={() => removeLink(k, a, j)}>✕</button></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {c.clos.length === 0 && <span className="text-xs text-muted-foreground">Add the course's CLOs first (CLOs tab).</span>}
                        {free.length > 0 && <Button type="button" variant="outline" className="h-8 px-3" onClick={() => addLink(k, a, free[0]!.id)}>+ CLO</Button>}
                        {a.clos.length > 1 && !isEven(a.clos) && <Button type="button" variant="ghost" className="h-8 px-3" onClick={() => setA({ clos: evenly(a.clos) })}>Split the shares evenly</Button>}
                        {a.clos.length > 0 && <span className="text-xs text-muted-foreground">Shares total {pct(a.clos.reduce((n, l) => n + (l.share ?? 0), 0))} of this assessment.</span>}
                      </div>
                      {own.length > 0 && <ul className="mt-2 space-y-0.5 text-xs" aria-label={`Issues of ${a.name || `assessment ${k + 1}`}`}>{own.map((x, i) => <li key={i} className={x.severity === 'error' ? 'text-red-800' : 'text-amber-800'}>{x.message}</li>)}</ul>}
                    </td>
                  </tr>
                )}
              </tbody>
            );
          })}
          <tfoot>
            <tr>
              <td colSpan={4} className="px-2 py-2">
                <Button type="button" variant="outline" onClick={() => { const id = newId(); onFresh(id, true); setOpen((o) => new Set(o).add(id)); set({ assessments: [...c.assessments, { id, name: '', category: '', weight: null, dueWeek: null, clos: [] }] }); }}>+ Assessment</Button>
              </td>
              <td className="px-2 py-2 text-sm font-semibold" data-testid="weight-total">
                <span className={Math.abs(total - 100) < 0.01 ? 'text-emerald-800' : c.assessments.length ? 'text-red-800' : 'text-muted-foreground'}>{pct(total)}{Math.abs(total - 100) < 0.01 ? ' ✓' : ''}</span>
              </td>
              <td colSpan={2} className="px-2 py-2 text-xs text-muted-foreground">{Math.abs(total - 100) < 0.01 ? 'The weights add up to 100%.' : 'The weights must add up to 100%.'}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 2. What each CLO is worth */}
      <div>
        <h4 className="mb-1 text-sm font-semibold">What each CLO is worth</h4>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse text-sm" aria-label="What each CLO is worth">
            <thead><tr><th className={`${th} w-24`}>CLO</th><th className={`${th} w-36`}>Share of the grade</th><th className={th}>Assessed by</th><th className={th} /></tr></thead>
            <tbody>
              {c.clos.map((x) => {
                const by = c.assessments.filter((a) => a.clos.some((l) => l.cloId === x.id));
                const w = weights.get(x.id) ?? 0;
                return (
                  <tr key={x.id} data-testid="clo-worth">
                    <td className={`${td} font-medium`}>{x.code}</td>
                    <td className={td}>{by.length ? pct(w) : '—'}</td>
                    <td className={td}>{by.length ? by.map((a) => a.name || 'Unnamed').join(', ') : '—'}</td>
                    <td className={`${td} text-xs`}>
                      {!by.length ? <span className="text-red-800">✕ Not assessed</span>
                        : w < settings.minCloWeightPct ? <span className="text-amber-800">⚠ Below the {settings.minCloWeightPct}% minimum (syllabus rules)</span> : <span className="text-emerald-800">✓</span>}
                    </td>
                  </tr>
                );
              })}
              {!c.clos.length && <tr><td colSpan={4} className={`${td} text-muted-foreground`}>No CLOs yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* 3. The course's rubrics */}
      <div>
        <h4 className="mb-1 text-sm font-semibold">Rubrics of this course</h4>
        <p className="mb-1 text-xs text-muted-foreground">Described at the institution's achievement scale ({levels.join(', ')}). Pick one for each CLO above; edit it here or there.</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse text-sm" aria-label="Rubrics of this course">
            <thead><tr><th className={th}>Rubric</th><th className={th}>Based on</th><th className={th}>Used by</th><th className={`${th} w-32`} /></tr></thead>
            <tbody>
              {c.rubrics.map((r) => {
                const uses = usedBy(r.id);
                const own = issuesOf(r.id);
                return (
                  <tr key={r.id} data-testid="course-rubric">
                    <td className={td}>
                      <span className="font-medium">{r.title || 'Untitled rubric'}</span>
                      {own.map((x, i) => <span key={i} className={`block text-xs ${x.severity === 'error' ? 'text-red-800' : 'text-amber-800'}`}>{x.message}</span>)}
                    </td>
                    <td className={`${td} text-xs`}>{templates.find((t) => t.id === r.templateId)?.title ?? (r.templateId ? 'A template' : 'Written for this course')}</td>
                    <td className={`${td} text-xs`}>{uses.length ? uses.join('; ') : <span className="text-muted-foreground">Not used</span>}</td>
                    <td className={`${td} whitespace-nowrap text-end`}>
                      <Button type="button" variant="ghost" className="h-8 px-2" onClick={() => openRubric(r)}>Edit</Button>
                      {!uses.length && <Button type="button" variant="ghost" className="h-8 px-2" onClick={() => set({ rubrics: c.rubrics.filter((x) => x.id !== r.id) })}>Remove</Button>}
                    </td>
                  </tr>
                );
              })}
              {!c.rubrics.length && <tr><td colSpan={4} className={`${td} text-muted-foreground`}>None yet: adding a CLO to an assessment brings the template for its type.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <RubricDialog rubric={editing} levels={levels} templates={templates} onClose={() => setEditing(null)}
          onSave={(r) => { set({ rubrics: c.rubrics.some((x) => x.id === r.id) ? c.rubrics.map((x) => (x.id === r.id ? r : x)) : [...c.rubrics, r] }); setEditing(null); }} />
      )}
    </div>
  );
}

function RubricDialog({ rubric, levels, templates, onClose, onSave }: {
  rubric: SyllabusRubric; levels: string[]; templates: RubricTemplate[]; onClose: () => void; onSave: (r: SyllabusRubric) => void;
}) {
  const [r, setR] = useState(rubric);
  const from = templates.find((t) => t.id === rubric.templateId);
  return (
    <Dialog labelledBy="rubric-title" onClose={onClose} size="wide">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 id="rubric-title" className="text-lg font-semibold">Rubric</h2>
          <p className="text-xs text-muted-foreground">{from ? `This course's copy of the template "${from.title}": changing it does not change the template.` : 'Written for this course.'} The levels are the institution's achievement scale.</p>
        </div>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <div className="space-y-3">
        <label className="flex flex-col gap-1 text-sm">Title<Input aria-label="Rubric title" value={r.title} onChange={(e) => setR({ ...r, title: e.target.value })} /></label>
        <RubricGrid label="Criteria of the rubric" levels={levels} criteria={r.criteria} onChange={(criteria) => setR({ ...r, criteria })} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={() => onSave(r)}>Save rubric</Button>
        </div>
      </div>
    </Dialog>
  );
}
