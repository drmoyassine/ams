// A program's requirements (DEC-046): its concentrations, the credits asked of each block (General education, College, Major, Concentration;
// core and elective), its study plan with each course's block and concentration, its elective slots, and what the checks flag.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BLOCK_LABEL, REQUIREMENT_BLOCKS, type ProgramRequirements, type RequirementBlock, type StudyPlanCourse } from '@ams/shared';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useCatalogApi, type CatalogApi } from '../../lib/catalog-api';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useAction } from '../../lib/use-action';

const select = 'h-8 rounded-md border border-border bg-background px-2 text-sm';
const num = (s: string) => (s.trim() === '' ? null : Number(s));
const fmt = (n: number | null) => (n === null ? '—' : String(Math.round(n * 10) / 10));
const ROLE_LABEL = { core: 'Core', elective: 'Elective', service: 'Service' } as const;

/** Credits asked of a block (core, elective), saved when the cell loses focus. */
function CreditCell({ label, value, disabled, onSave }: { label: string; value: number | null; disabled: boolean; onSave: (v: number | null) => void }) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  return (
    <Input aria-label={label} inputMode="decimal" className="h-8 w-20" disabled={disabled} value={draft} onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { const n = num(draft); if (n === value || (n !== null && Number.isNaN(n))) { setDraft(value === null ? '' : String(value)); return; } onSave(n); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
  );
}

export function RequirementsSection({ programId, canWrite, catalog: catalogOverride, outcomes: outcomesOverride }: { programId: string; canWrite: boolean; catalog?: CatalogApi; outcomes?: OutcomesApi }) {
  const api = useCatalogApi(catalogOverride);
  const oapi = useOutcomesApi(outcomesOverride);
  const qc = useQueryClient();
  const key = ['requirements', programId];
  const q = useQuery({ queryKey: key, queryFn: () => api.requirements(programId) });
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); },
    onError: (e) => setError(e instanceof Error ? e.message : 'Something went wrong'),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['courses'] }); void qc.invalidateQueries({ queryKey: ['programs'] }); },
  });
  const [conc, setConc] = useState({ code: '', nameEn: '' });
  const [slot, setSlot] = useState({ block: 'major' as RequirementBlock, concentrationId: '', name: '', rule: '', credits: '3', year: '', term: '', areaId: '' });
  const r = q.data;
  if (q.isError) return <p role="alert" className="text-sm text-red-700">Could not load the requirements.</p>;
  if (!r) return <p className="text-sm text-muted-foreground">Loading the requirements…</p>;
  const minor = r.programType === 'minor';
  const concName = new Map(r.concentrations.map((c) => [c.id, c.nameEn]));
  const target = (concentrationId: string | null, block: RequirementBlock, requirement: 'core' | 'elective') => r.blocks.find((b) => (b.concentrationId ?? null) === concentrationId && b.block === block && b.requirement === requirement)?.credits ?? null;
  const planned = (concentrationId: string | null, block: RequirementBlock, requirement: 'core' | 'elective') => r.totals.find((t) => (t.concentrationId ?? null) === concentrationId && t.block === block && t.requirement === requirement)?.planned ?? 0;
  const setBlock = (concentrationId: string | null, block: RequirementBlock, requirement: 'core' | 'elective', credits: number | null) =>
    run.mutate(() => api.setBlock({ programId, block, requirement, credits, ...(concentrationId ? { concentrationId } : {}) }));
  const rows: { concentrationId: string | null; block: RequirementBlock; label: string }[] = [
    ...(['general_education', 'college', 'major'] as const).filter((b) => !(minor && b === 'general_education')).map((b) => ({ concentrationId: null, block: b, label: BLOCK_LABEL[b] })),
    ...r.concentrations.filter((c) => c.active).map((c) => ({ concentrationId: c.id, block: 'concentration' as const, label: `${BLOCK_LABEL.concentration}: ${c.nameEn}` })),
  ];
  const plan = (c: StudyPlanCourse) => (
    <tr key={c.courseId} className="border-t border-border align-top" data-testid="plan-course">
      <td className="px-2 py-1 font-mono">{c.code}</td><td className="px-2 py-1">{c.titleEn}</td><td className="px-2 py-1 text-end">{fmt(c.credits)}</td>
      <td className="px-2 py-1">
        <select aria-label={`Block of ${c.code}`} className={select} disabled={!canWrite} value={c.block ?? ''}
          onChange={(e) => { const v = e.target.value; run.mutate(() => oapi.setCourseProgram(c.courseId, programId, { role: c.role, year: c.year, term: c.term, block: (v || null) as RequirementBlock | null, ...(v !== 'concentration' ? { concentrationId: null } : {}) })); }}>
          <option value="">No block</option>{REQUIREMENT_BLOCKS.map((b) => <option key={b} value={b}>{BLOCK_LABEL[b]}</option>)}
        </select>
      </td>
      <td className="px-2 py-1">
        {r.concentrations.length > 0 && (
          <select aria-label={`Concentration of ${c.code}`} className={select} disabled={!canWrite} value={c.concentrationId ?? ''}
            onChange={(e) => { const v = e.target.value; run.mutate(() => oapi.setCourseProgram(c.courseId, programId, { role: c.role, year: c.year, term: c.term, concentrationId: v || null })); }}>
            <option value="">All</option>{r.concentrations.map((k) => <option key={k.id} value={k.id}>{k.nameEn}</option>)}
          </select>
        )}
      </td>
      <td className="px-2 py-1">{ROLE_LABEL[c.role]}</td><td className="px-2 py-1 whitespace-nowrap">{c.year ? `Y${c.year}` : ''}{c.term ? ` T${c.term}` : ''}</td>
    </tr>
  );
  return (
    <Card>
      <section aria-label="Requirements" className="space-y-4">
        <div>
          <h3 className="text-base font-semibold">Requirements{minor ? ' (minor)' : ''}</h3>
          <p className="text-xs text-muted-foreground">What the degree is made of: General education (the institution&apos;s, set by Academic Affairs), College, Major and a Concentration, each with core and elective credits. The checks flag what does not add up; they never block a save.</p>
        </div>
        {r.issues.length > 0
          ? <ul aria-label="To look at" className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">{r.issues.map((i, n) => <li key={n}>{i.message}</li>)}</ul>
          : r.courses.length + r.slots.length > 0 && <p role="status" className="text-sm text-emerald-800">The credits add up.</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Credits by block</h4>
          <div className="overflow-x-auto">
            <table aria-label="Credits by block" className="w-full text-sm">
              <thead className="text-xs text-muted-foreground"><tr><th className="px-2 py-1 text-start">Block</th><th className="px-2 py-1 text-start">Core asked</th><th className="px-2 py-1 text-end">Core planned</th><th className="px-2 py-1 text-start">Elective asked</th><th className="px-2 py-1 text-end">Elective planned</th></tr></thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={`${b.concentrationId}${b.block}`} className="border-t border-border">
                    <td className="px-2 py-1">{b.label}</td>
                    <td className="px-2 py-1"><CreditCell key={`c${target(b.concentrationId, b.block, 'core')}`} label={`Core credits of ${b.label}`} value={target(b.concentrationId, b.block, 'core')} disabled={!canWrite} onSave={(v) => setBlock(b.concentrationId, b.block, 'core', v)} /></td>
                    <td className="px-2 py-1 text-end">{fmt(planned(b.concentrationId, b.block, 'core'))}</td>
                    <td className="px-2 py-1"><CreditCell key={`e${target(b.concentrationId, b.block, 'elective')}`} label={`Elective credits of ${b.label}`} value={target(b.concentrationId, b.block, 'elective')} disabled={!canWrite} onSave={(v) => setBlock(b.concentrationId, b.block, 'elective', v)} /></td>
                    <td className="px-2 py-1 text-end">{fmt(planned(b.concentrationId, b.block, 'elective'))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">Program credits: {fmt(r.credits)}.{!minor && r.genedCredits !== null ? ` General education: ${fmt(r.genedCredits)} for every degree.` : ''}</p>
          {!minor && r.areas.length > 0 && (
            <ul aria-label="General education areas" className="flex flex-wrap gap-2 text-xs">
              {r.areas.map((a) => <li key={a.id} className={`rounded border px-2 py-0.5 ${a.minCredits > 0 && a.planned < a.minCredits ? 'border-amber-400 bg-amber-50' : 'border-border'}`}>{a.nameEn}: {fmt(a.planned)}{a.minCredits > 0 ? ` of at least ${fmt(a.minCredits)}` : ''}</li>)}
            </ul>
          )}
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Concentrations</h4>
          {r.concentrations.length === 0 && <p className="text-sm text-muted-foreground">No concentrations: the degree is the common blocks. A student follows one concentration when there are several.</p>}
          <ul className="space-y-1 text-sm" aria-label="Concentrations">
            {r.concentrations.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{c.code}</span><span>{c.nameEn}</span>{!c.active && <span className="rounded border border-border px-1.5 text-xs">Inactive</span>}
                {canWrite && <Button type="button" variant="ghost" className="px-2 py-0.5 text-xs" aria-label={`${c.active ? 'Deactivate' : 'Reactivate'} ${c.nameEn}`} onClick={() => run.mutate(() => api.updateConcentration(c.id, { active: !c.active }))}>{c.active ? 'Deactivate' : 'Reactivate'}</Button>}
                {canWrite && <Button type="button" variant="ghost" className="px-2 py-0.5 text-xs" aria-label={`Delete ${c.nameEn}`} onClick={() => run.mutate(() => api.deleteConcentration(c.id))}>Delete</Button>}
              </li>
            ))}
          </ul>
          {canWrite && !minor && (
            <form aria-label="Add a concentration" className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (!conc.code.trim() || !conc.nameEn.trim()) return; run.mutate(() => api.createConcentration({ programId, code: conc.code.trim(), nameEn: conc.nameEn.trim() })); setConc({ code: '', nameEn: '' }); }}>
              <Input aria-label="Concentration code" className="h-8 w-28" placeholder="Code" value={conc.code} onChange={(e) => setConc({ ...conc, code: e.target.value })} />
              <Input aria-label="Concentration name" className="h-8 w-60" placeholder="Name (English)" value={conc.nameEn} onChange={(e) => setConc({ ...conc, nameEn: e.target.value })} />
              <Button type="submit" variant="outline" className="h-8 px-3 py-1" disabled={!conc.code.trim() || !conc.nameEn.trim()}>Add concentration</Button>
            </form>
          )}
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Study plan</h4>
          {r.courses.length === 0 && <p className="text-sm text-muted-foreground">No courses yet. Add the program on a course&apos;s page (its Study plan), then set its block here.</p>}
          {r.courses.length > 0 && (
            <div className="overflow-x-auto">
              <table aria-label="Study plan" className="w-full text-sm">
                <thead className="text-xs text-muted-foreground"><tr><th className="px-2 py-1 text-start">Code</th><th className="px-2 py-1 text-start">Title</th><th className="px-2 py-1 text-end">Credits</th><th className="px-2 py-1 text-start">Block</th><th className="px-2 py-1 text-start">Concentration</th><th className="px-2 py-1 text-start">Role</th><th className="px-2 py-1 text-start">When</th></tr></thead>
                <tbody>{r.courses.map(plan)}</tbody>
              </table>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Elective slots</h4>
          <p className="text-xs text-muted-foreground">A place in the plan for a course chosen later, for example &quot;Major elective, 3 credits, year 4 term 1&quot;, with the rule that fills it.</p>
          <ul aria-label="Elective slots" className="space-y-1 text-sm">
            {r.slots.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2" data-testid="slot">
                <span className="font-medium">{s.name}</span><span className="text-xs text-muted-foreground">{BLOCK_LABEL[s.block]}{s.concentrationId ? ` · ${concName.get(s.concentrationId)}` : ''} · {fmt(s.credits)} credits{s.year ? ` · Y${s.year}` : ''}{s.term ? ` T${s.term}` : ''}{s.rule ? ` · ${s.rule}` : ''}</span>
                {canWrite && <Button type="button" variant="ghost" className="px-2 py-0.5 text-xs" aria-label={`Remove slot ${s.name}`} onClick={() => run.mutate(() => api.deleteSlot(s.id))}>Remove</Button>}
              </li>
            ))}
          </ul>
          {canWrite && (
            <form aria-label="Add an elective slot" className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
              e.preventDefault();
              if (!slot.name.trim() || !num(slot.credits)) return;
              run.mutate(() => api.createSlot({ programId, block: slot.block, requirement: 'elective', name: slot.name.trim(), credits: Number(slot.credits), ...(slot.rule.trim() ? { rule: slot.rule.trim() } : {}),
                ...(slot.concentrationId ? { concentrationId: slot.concentrationId } : {}), ...(slot.areaId ? { areaId: slot.areaId } : {}), ...(num(slot.year) ? { year: num(slot.year) } : {}), ...(num(slot.term) ? { term: num(slot.term) } : {}) }));
              setSlot({ ...slot, name: '', rule: '' });
            }}>
              <select aria-label="Slot block" className={select} value={slot.block} onChange={(e) => setSlot({ ...slot, block: e.target.value as RequirementBlock })}>{REQUIREMENT_BLOCKS.map((b) => <option key={b} value={b}>{BLOCK_LABEL[b]}</option>)}</select>
              {r.concentrations.length > 0 && <select aria-label="Slot concentration" className={select} value={slot.concentrationId} onChange={(e) => setSlot({ ...slot, concentrationId: e.target.value })}><option value="">All</option>{r.concentrations.map((k) => <option key={k.id} value={k.id}>{k.nameEn}</option>)}</select>}
              {slot.block === 'general_education' && r.areas.length > 0 && <select aria-label="Slot area" className={select} value={slot.areaId} onChange={(e) => setSlot({ ...slot, areaId: e.target.value })}><option value="">No area</option>{r.areas.map((a) => <option key={a.id} value={a.id}>{a.nameEn}</option>)}</select>}
              <Input aria-label="Slot name" className="h-8 w-48" placeholder="Major elective" value={slot.name} onChange={(e) => setSlot({ ...slot, name: e.target.value })} />
              <Input aria-label="Slot rule" className="h-8 w-48" placeholder="Rule, e.g. Any MCE 4xx" value={slot.rule} onChange={(e) => setSlot({ ...slot, rule: e.target.value })} />
              <Input aria-label="Slot credits" className="h-8 w-20" placeholder="Credits" inputMode="decimal" value={slot.credits} onChange={(e) => setSlot({ ...slot, credits: e.target.value })} />
              <Input aria-label="Slot year" className="h-8 w-16" placeholder="Year" value={slot.year} onChange={(e) => setSlot({ ...slot, year: e.target.value })} />
              <Input aria-label="Slot term" className="h-8 w-16" placeholder="Term" value={slot.term} onChange={(e) => setSlot({ ...slot, term: e.target.value })} />
              <Button type="submit" variant="outline" className="h-8 px-3 py-1" disabled={!slot.name.trim() || !num(slot.credits)}>Add slot</Button>
            </form>
          )}
        </div>
      </section>
    </Card>
  );
}

export type { ProgramRequirements };
