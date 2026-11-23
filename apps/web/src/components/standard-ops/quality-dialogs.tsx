// A standard's frequency and approval steps (DEC-048), from its ⋯ menu in Settings -> Internal Quality Framework. Both are inherited
// down the tree; a sub-standard may set its own (or opt out of the frequency); "Back to inherited" removes its own.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { describeFrequency, type ApprovalStep, type FrequencyRule, type RequirementQuality } from '@ams/shared';
import { useAction } from '../../lib/use-action';
import { useQualityApi, type QualityApi } from '../../lib/quality-api';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { Dialog } from '../dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import type { OpsTarget } from './scope-dialog';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const NTH = [[1, 'first'], [2, 'second'], [3, 'third'], [4, 'fourth'], [-1, 'last']] as const;
const select = 'h-9 rounded-md border border-border bg-background px-2 text-sm';
const field = 'flex flex-col gap-1 text-xs';
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

function useQuality(api: QualityApi, target: OpsTarget) {
  return useQuery({ queryKey: ['requirement-quality', target.versionId], queryFn: () => api.requirements(target.versionId, target.frameworkId) });
}
const sourceText = (s: RequirementQuality['frequency']['source']) => (!s ? '' : s.kind === 'own' ? 'its own' : `from ${s.code}`);

type Every = FrequencyRule['every'] | 'none' | 'opt_out';
/** The rule being edited, field by field (the form keeps whatever the chosen kind does not use). */
interface Draft { every: Every; weekday: number; dayMode: 'day' | 'nth'; day: number; nth: number; month: number; week: number; endOfWeek: boolean; startDate: string; timezone: string }
function draftOf(r: FrequencyRule | null, optOut: boolean): Draft {
  const d: Draft = { every: optOut ? 'opt_out' : r?.every ?? 'none', weekday: 1, dayMode: 'nth', day: 1, nth: -1, month: 8, week: 12, endOfWeek: true, startDate: new Date().toISOString().slice(0, 10), timezone: zone() };
  if (!r) return d;
  d.startDate = r.startDate; d.timezone = r.timezone;
  if (r.every === 'week') d.weekday = r.weekday;
  if (r.every === 'semester') { d.week = r.week; d.endOfWeek = r.weekday === undefined; if (r.weekday !== undefined) d.weekday = r.weekday; }
  if (r.every === 'month' || r.every === 'year') {
    if ('day' in r.on) { d.dayMode = 'day'; d.day = r.on.day; } else { d.dayMode = 'nth'; d.nth = r.on.nth; d.weekday = r.on.weekday; }
    if (r.every === 'year') d.month = r.month;
  }
  return d;
}
function ruleOf(d: Draft): FrequencyRule | null {
  const common = { timezone: d.timezone, startDate: d.startDate };
  const on = d.dayMode === 'day' ? { day: d.day } : { nth: d.nth as 1 | 2 | 3 | 4 | -1, weekday: d.weekday };
  switch (d.every) {
    case 'day': return { every: 'day', ...common };
    case 'week': return { every: 'week', weekday: d.weekday, ...common };
    case 'month': return { every: 'month', on, ...common };
    case 'semester': return { every: 'semester', week: d.week, ...(d.endOfWeek ? {} : { weekday: d.weekday }), ...common };
    case 'year': return { every: 'year', month: d.month, on, ...common };
    default: return null;
  }
}

export function FrequencyDialog({ target, api: override, onClose }: { target: OpsTarget; api?: QualityApi; onClose: () => void }) {
  const api = useQualityApi(override);
  const qc = useQueryClient();
  const q = useQuality(api, target);
  const mine = q.data?.find((x) => x.code === target.code);
  const [d, setD] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  if (!mine) return <Dialog labelledBy="freq-title" onClose={onClose}><h2 id="freq-title" className="text-lg font-semibold">Frequency</h2><p className="text-sm text-muted-foreground">{q.isError ? 'Could not load it.' : 'Loading…'}</p></Dialog>;
  const draft = d ?? draftOf(mine.frequency.own, mine.frequency.optOut);
  const set = (p: Partial<Draft>) => setD({ ...draft, ...p });
  const rule = ruleOf(draft);
  const save = async (body: { rule: FrequencyRule | null; optOut: boolean }) => {
    const ok = await act(() => api.setFrequency({ frameworkId: target.frameworkId, code: target.code, ...body }));
    if (ok !== undefined) { await qc.invalidateQueries({ queryKey: ['requirement-quality'] }); await qc.invalidateQueries({ queryKey: ['quality-tabs'] }); onClose(); }
  };
  const dayPicker = (
    <div className="flex flex-wrap items-end gap-2">
      <label className={field}>On
        <select aria-label="Day or weekday" className={select} value={draft.dayMode} onChange={(e) => set({ dayMode: e.target.value as Draft['dayMode'] })}><option value="nth">a weekday</option><option value="day">a day of the month</option></select>
      </label>
      {draft.dayMode === 'day'
        ? <label className={field}>Day<Input aria-label="Day of the month" className="h-9 w-20" inputMode="numeric" value={String(draft.day)} onChange={(e) => set({ day: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })} /></label>
        : (<>
          <label className={field}>Which<select aria-label="Which weekday of the month" className={select} value={draft.nth} onChange={(e) => set({ nth: Number(e.target.value) })}>{NTH.map(([n, l]) => <option key={n} value={n}>{l}</option>)}</select></label>
          <label className={field}>Weekday<select aria-label="Weekday" className={select} value={draft.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>{WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}</select></label>
        </>)}
    </div>
  );
  return (
    <Dialog labelledBy="freq-title" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="freq-title" className="text-lg font-semibold">Frequency <span className="text-base font-normal text-muted-foreground">{target.label}</span></h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">How often the people this standard is scoped to submit its evidence. Its sub-standards inherit it unless they set their own or opt out.</p>
      <p className="mb-3 rounded-md border border-border p-2 text-sm" data-testid="frequency-current">
        Now: {mine.frequency.effective ? `${mine.frequency.text} (${sourceText(mine.frequency.source)})` : mine.frequency.optOut ? 'Opted out: no submissions here' : 'None'}
      </p>
      <div className="space-y-3">
        <label className={field}>Every
          <select aria-label="Every" className={select} value={draft.every} onChange={(e) => set({ every: e.target.value as Every })}>
            <option value="none">Inherit (no own frequency)</option><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
            <option value="semester">Semester (a term of the academic calendar)</option><option value="year">Year</option><option value="opt_out">Opt out of the inherited frequency</option>
          </select>
        </label>
        {draft.every === 'week' && <label className={field}>On<select aria-label="Weekday" className={select} value={draft.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>{WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}</select></label>}
        {draft.every === 'month' && dayPicker}
        {draft.every === 'year' && (<>
          <label className={field}>Month<select aria-label="Month" className={select} value={draft.month} onChange={(e) => set({ month: Number(e.target.value) })}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></label>
          {dayPicker}
        </>)}
        {draft.every === 'semester' && (
          <div className="flex flex-wrap items-end gap-2">
            <label className={field}>Week of the term<Input aria-label="Week of the term" className="h-9 w-20" inputMode="numeric" value={String(draft.week)} onChange={(e) => set({ week: Math.min(30, Math.max(1, Number(e.target.value) || 1)) })} /></label>
            <label className={field}>Due<select aria-label="Due on" className={select} value={draft.endOfWeek ? 'end' : String(draft.weekday)} onChange={(e) => (e.target.value === 'end' ? set({ endOfWeek: true }) : set({ endOfWeek: false, weekday: Number(e.target.value) }))}>
              <option value="end">at the end of that week</option>{WEEKDAYS.map((w, i) => <option key={w} value={i}>on {w}</option>)}
            </select></label>
          </div>
        )}
        {rule && (
          <div className="flex flex-wrap items-end gap-2">
            <label className={field}>From<Input aria-label="From" type="date" className="h-9" value={draft.startDate} onChange={(e) => set({ startDate: e.target.value })} /></label>
            <label className={field}>Time zone<Input aria-label="Time zone" className="h-9 w-44" value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })} /></label>
          </div>
        )}
        {rule && <p className="text-sm" data-testid="frequency-preview">{describeFrequency(rule)}</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void save({ rule, optOut: draft.every === 'opt_out' })}>{draft.every === 'none' ? 'Back to inherited' : 'Save frequency'}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Dialog>
  );
}

const STEP_LABEL = (s: ApprovalStep, people: { id: string; fullName: string }[]) =>
  s.label ?? (s.kind === 'program_coordinator' ? 'Program coordinator' : s.kind === 'unit_head' ? `Head of the ${s.unitType}` : people.find((p) => p.id === s.userId)?.fullName ?? 'A person');

export function ApprovalDialog({ target, api: override, settings: settingsOverride, onClose }: { target: OpsTarget; api?: QualityApi; settings?: SettingsApi; onClose: () => void }) {
  const api = useQualityApi(override);
  const sapi = useSettingsApi(settingsOverride);
  const qc = useQueryClient();
  const q = useQuality(api, target);
  const people = useQuery({ queryKey: ['people'], queryFn: () => sapi.people(), staleTime: 60_000 });
  const types = useQuery({ queryKey: ['org-unit-types'], queryFn: () => sapi.orgUnitTypes() });
  const mine = q.data?.find((x) => x.code === target.code);
  const [steps, setSteps] = useState<ApprovalStep[] | null>(null);
  const [add, setAdd] = useState<{ kind: ApprovalStep['kind']; unitType: string; userId: string; label: string }>({ kind: 'program_coordinator', unitType: '', userId: '', label: '' });
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  if (!mine) return <Dialog labelledBy="appr-title" onClose={onClose}><h2 id="appr-title" className="text-lg font-semibold">Approval steps</h2><p className="text-sm text-muted-foreground">{q.isError ? 'Could not load them.' : 'Loading…'}</p></Dialog>;
  const list = steps ?? mine.approval.own ?? mine.approval.effective;
  const ppl = people.data ?? [];
  const save = async (value: ApprovalStep[] | null) => {
    const ok = await act(() => api.setApproval({ frameworkId: target.frameworkId, code: target.code, steps: value }));
    if (ok !== undefined) { await qc.invalidateQueries({ queryKey: ['requirement-quality'] }); onClose(); }
  };
  const move = (i: number, by: number) => { const n = [...list]; const [x] = n.splice(i, 1); n.splice(i + by, 0, x!); setSteps(n); };
  const canAdd = add.kind === 'program_coordinator' || (add.kind === 'unit_head' && add.unitType) || (add.kind === 'person' && add.userId);
  return (
    <Dialog labelledBy="appr-title" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="appr-title" className="text-lg font-semibold">Approval steps <span className="text-base font-normal text-muted-foreground">{target.label}</span></h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">Who signs off a submission, in order. The QA office and then the standard&apos;s champion always come last. Sub-standards inherit these steps unless they set their own.</p>
      {!mine.approval.own && mine.approval.source && <p className="mb-2 text-xs text-muted-foreground">Inherited from {mine.approval.source.code}.</p>}
      <ol className="space-y-1" aria-label="Steps">
        {list.map((s, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 text-sm" data-testid="approval-step-setting">
            <span className="w-5 text-xs text-muted-foreground">{i + 1}.</span><span className="font-medium">{STEP_LABEL(s, ppl)}</span>
            <span className="ms-auto flex gap-1">
              <Button type="button" variant="ghost" className="px-2 py-0.5 text-xs" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
              <Button type="button" variant="ghost" className="px-2 py-0.5 text-xs" aria-label={`Move step ${i + 1} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</Button>
              <Button type="button" variant="ghost" className="px-2 py-0.5 text-xs" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps(list.filter((_, k) => k !== i))}>Remove</Button>
            </span>
          </li>
        ))}
        <li className="flex items-center gap-2 text-sm text-muted-foreground"><span className="w-5 text-xs">{list.length + 1}.</span>QA office</li>
        <li className="flex items-center gap-2 text-sm text-muted-foreground"><span className="w-5 text-xs">{list.length + 2}.</span>Champion</li>
      </ol>
      <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-border p-2" role="group" aria-label="Add a step">
        <label className={field}>Step<select aria-label="Step kind" className={select} value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value as ApprovalStep['kind'] })}>
          <option value="program_coordinator">Program coordinator (of the course&apos;s program)</option><option value="unit_head">Head of a unit type (the dean: College)</option><option value="person">A named person</option>
        </select></label>
        {add.kind === 'unit_head' && <label className={field}>Unit type<select aria-label="Unit type" className={select} value={add.unitType} onChange={(e) => setAdd({ ...add, unitType: e.target.value })}><option value="">Choose</option>{(types.data ?? []).map((t) => <option key={t.key} value={t.key}>{t.labelEn}</option>)}</select></label>}
        {add.kind === 'person' && <label className={field}>Person<select aria-label="Person" className={select} value={add.userId} onChange={(e) => setAdd({ ...add, userId: e.target.value })}><option value="">Choose</option>{ppl.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}</select></label>}
        <label className={field}>Label (optional)<Input aria-label="Step label" className="h-9 w-36" placeholder={add.kind === 'unit_head' ? 'Dean' : ''} value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} /></label>
        <Button type="button" variant="outline" className="h-9" disabled={!canAdd} onClick={() => {
          const label = add.label.trim() ? { label: add.label.trim() } : {};
          const s: ApprovalStep = add.kind === 'program_coordinator' ? { kind: 'program_coordinator', ...label } : add.kind === 'unit_head' ? { kind: 'unit_head', unitType: add.unitType, ...label } : { kind: 'person', userId: add.userId, ...label };
          setSteps([...list, s]); setAdd({ ...add, label: '' });
        }}>Add step</Button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" onClick={() => void save(list)}>Save steps</Button>
        {mine.approval.own && <Button type="button" variant="outline" onClick={() => void save(null)}>Back to inherited</Button>}
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>
  );
}
