// "Set cycle plan…" (TASK-081), from the ⋯ menu of a standard (the institution's own or an external one): a template and a recurrence
// attached to the standard. The dialog shows the plans IN EFFECT on it and where each comes from ("From IQF 4"), with Back to
// inherited (removes its own) and Opt out (stops inheriting a template here and below); and a form to set its own plan: which
// template, how often (every term, every year, every N years or months, or when the previous one ends with the next date set by a
// decision), when the first run starts, who is responsible, and who it applies to (narrowing the standard's scope). A plan only PROPOSES
// runs; QA launches them from Quality Management -> Cycles -> Due to launch. Works on a published version: plans live outside it.
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEGREE_LEVELS, type AppliesTo, type CyclePlan, type CycleRecurrence, type EffectivePlan, type Me, type NodeAssignment, type PlanAnchorKind, type PlanTarget } from '@ams/shared';
import { useTranslation } from '../../i18n';
import { useAction } from '../../lib/use-action';
import { useCyclesApi } from '../../lib/cycles-api';
import { useEvidenceApi } from '../../lib/evidence-api';
import { useApi } from '../../lib/me';
import { usePlansApi } from '../../lib/plans-api';
import { useSettingsApi } from '../../lib/settings-api';
import { ContentText } from '../content-text';
import { useDirectory, type CycleApis } from '../cycles/directory';
import { Chip, day, fieldCls, selectCls } from '../cycles/labels';
import { planAnchorLabels, planSourceLabel, recurrenceText } from '../plans/labels';
import { Dialog } from '../dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import type { OpsTarget } from './scope-dialog';

type Pattern = 'term' | 'year' | 'month' | 'decision';
const today = () => new Date().toISOString().slice(0, 10);

/** What a plan form holds, and how it maps to and from a stored plan. */
interface Form { templateId: string; pattern: Pattern; every: number; first: string; unitId: string; ownerId: string; kinds: Set<string>; levels: Set<string>; types: Set<string>; ids: Set<string>; active: boolean }
const blank = (templateId = ''): Form => ({ templateId, pattern: 'term', every: 1, first: today(), unitId: '', ownerId: '', kinds: new Set(), levels: new Set(), types: new Set(), ids: new Set(), active: true });
function formOf(p: CyclePlan | EffectivePlan | undefined, templateId: string): Form {
  if (!p) return blank(templateId);
  const rec = p.recurrence;
  const base = blank(templateId);
  base.first = p.firstStart ?? base.first;
  if (rec) { if ('after' in rec) base.pattern = 'decision'; else { base.pattern = rec.unit; base.every = rec.every; } }
  if ('appliesTo' in p) {
    base.unitId = p.responsibleUnitId ?? ''; base.ownerId = p.ownerUserId ?? ''; base.active = p.active;
    base.kinds = new Set(p.appliesTo.kinds ?? []); base.levels = new Set(p.appliesTo.programLevels ?? []); base.types = new Set(p.appliesTo.unitTypes ?? []); base.ids = new Set(p.appliesTo.ids ?? []);
  }
  return base;
}
const recurrenceOf = (f: Form, keep: CycleRecurrence | null): CycleRecurrence => (f.pattern === 'decision'
  ? { after: 'previous_ends', setBy: 'decision', ...(keep && 'after' in keep && keep.dates ? { dates: keep.dates } : {}) }
  : { every: f.every, unit: f.pattern });
const appliesOf = (f: Form): AppliesTo => ({
  ...(f.kinds.size ? { kinds: [...f.kinds] as AppliesTo['kinds'] } : {}), ...(f.levels.size ? { programLevels: [...f.levels] } : {}),
  ...(f.types.size ? { unitTypes: [...f.types] } : {}), ...(f.ids.size ? { ids: [...f.ids] } : {}),
});

/** What a plan is attached to when it is not a requirement of a standard (those come from the ⋯ menu with a full OpsTarget). */
export interface PlanAnchor { kind: PlanAnchorKind; id?: string; frameworkId?: string; label: string; title: string }
const CHOOSABLE: PlanAnchorKind[] = ['framework', 'org_unit', 'program', 'evidence_item', 'institution'];

/**
 * `target`: a requirement of a standard (the ⋯ menu). `anchor`: something else, already chosen. With neither, the dialog starts by
 * asking what the plan is attached to (the Plans tab's "New plan"): the whole institution's standard, a unit, a program, an evidence
 * item or the institution.
 */
export function PlanDialog({ target, anchor, me, apis = {}, onClose }: { target?: OpsTarget; anchor?: PlanAnchor; me?: Me | undefined; assignment?: NodeAssignment | undefined; apis?: CycleApis; onClose: () => void }) {
  const { t } = useTranslation();
  const plans = usePlansApi(apis.plans);
  const cycles = useCyclesApi(apis.cycles);
  const settings = useSettingsApi(apis.settings);
  const framework = useApi(apis.framework);
  const evidence = useEvidenceApi(apis.evidence);
  const dir = useDirectory(apis);
  const qc = useQueryClient();
  const [pickKind, setPickKind] = useState<PlanAnchorKind>('framework');
  const [pickId, setPickId] = useState('');
  const chooser = !target && !anchor;
  const qf = useQuery({ queryKey: ['quality-framework'], queryFn: () => framework.qualityFramework(), enabled: chooser && pickKind === 'framework' });
  const evidenceList = useQuery({ queryKey: ['evidence-items-for-plans'], queryFn: () => evidence.list(), enabled: chooser && pickKind === 'evidence_item' });
  const anchorLabels = planAnchorLabels(t);
  const ready = !!target || !!anchor || (pickKind === 'institution' || pickKind === 'framework' ? (pickKind === 'framework' ? !!qf.data?.framework : true) : !!pickId);
  const plan: PlanTarget | null = target ? { anchorKind: 'requirement', frameworkId: target.frameworkId, code: target.code }
    : anchor ? { anchorKind: anchor.kind, ...(anchor.id ? { anchorId: anchor.id } : {}), ...(anchor.frameworkId ? { frameworkId: anchor.frameworkId } : {}) }
      : !ready ? null : pickKind === 'framework' ? { anchorKind: 'framework', frameworkId: qf.data!.framework!.id }
        : pickKind === 'institution' ? { anchorKind: 'institution', anchorId: me?.institutionId ?? '' } : { anchorKind: pickKind, anchorId: pickId };
  const heading = target?.label ?? anchor?.label ?? '';
  const subtitle = target?.title ?? anchor?.title ?? '';
  const internal = target?.internal ?? false;
  const requirement = plan?.anchorKind === 'requirement';
  const cycleKind = plan ? (plan.anchorKind === 'framework' ? 'framework_version' : plan.anchorKind) : 'requirement';
  const state = useQuery({ queryKey: ['cycle-plans', 'target', plan], queryFn: () => plans.target(plan!), enabled: !!plan });
  const templates = useQuery({ queryKey: ['cycle-templates', 'published', cycleKind], queryFn: () => cycles.templates({ status: 'published', anchorKind: cycleKind }), enabled: !!plan });
  const types = useQuery({ queryKey: ['org-unit-types'], queryFn: () => settings.orgUnitTypes() });
  const ownPlans = state.data?.own ?? [];
  // A requirement shows what it has in effect (with sources); anything else has only the plans set on it.
  const effective: EffectivePlan[] = requirement ? state.data?.effective ?? [] : ownPlans.map((p) => ({
    templateId: p.templateId, templateName: p.templateName, planId: p.id, recurrence: p.recurrence, firstStart: p.firstStart, source: { kind: 'own' as const, code: null }, sourceCodes: [], optedOut: p.mode === 'opt_out',
  }));
  const [form, setForm] = useState<Form>(() => blank());
  const [picked, setPicked] = useState(false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = useAction(setError);
  const fits = (templates.data ?? []).filter((x) => x.status === 'published');
  const templateName = (id: string) => fits.find((x) => x.id === id)?.name ?? effective.find((e) => e.templateId === id)?.templateName ?? ownPlans.find((p) => p.templateId === id)?.templateName ?? '';

  // Start from the first template; choosing another loads the plan this standard has for it, else what it inherits (to override from).
  useEffect(() => {
    if (picked || !plan || !state.data || !templates.data) return;
    const id = fits[0]?.id ?? '';
    setForm(formOf(ownPlans.find((p) => p.templateId === id && p.mode === 'own') ?? effective.find((e) => e.templateId === id && !e.optedOut), id));
    setPicked(true);
  }, [picked, plan, state.data, templates.data]);
  const choose = (id: string) => setForm(formOf(ownPlans.find((p) => p.templateId === id && p.mode === 'own') ?? effective.find((e) => e.templateId === id && !e.optedOut), id));
  const mine = ownPlans.find((p) => p.templateId === form.templateId);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['requirement-context'] }), qc.invalidateQueries({ queryKey: ['cycle-plans'] }), qc.invalidateQueries({ queryKey: ['due-runs'] })]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { const r = await act(fn); if (r !== undefined) { await refresh(); return true; } return false; } finally { setBusy(false); }
  };
  const save = async () => {
    if (!form.templateId || !plan) return;
    const ok = await run(() => plans.set({
      ...plan, templateId: form.templateId, mode: 'own', recurrence: recurrenceOf(form, mine?.recurrence ?? null), firstStart: form.first,
      responsibleUnitId: form.unitId || null, ownerUserId: form.ownerId || null, appliesTo: appliesOf(form), active: form.active,
    }));
    if (ok) setPicked(false);
  };
  const optOut = (templateId: string) => run(() => plans.set({ ...plan!, templateId, mode: 'opt_out' }));
  const back = (planId: string) => run(() => plans.clear(planId).then(() => true));
  const toggle = (key: 'kinds' | 'levels' | 'types' | 'ids', v: string) => setForm((f) => { const s = new Set(f[key]); if (s.has(v)) s.delete(v); else s.add(v); return { ...f, [key]: s }; });
  const list = useMemo(() => [...dir.units.map((u) => ({ ...u, group: 'unit' })), ...dir.programs.map((p) => ({ ...p, group: 'program' }))]
    .filter((i) => !filter || i.nameEn.toLowerCase().includes(filter.toLowerCase()) || (i.nameAr ?? '').includes(filter)), [dir.units, dir.programs, filter]);
  const ownOf = (templateId: string) => ownPlans.find((p) => p.templateId === templateId);
  const valid = !!form.templateId && !!form.first && form.every >= 1;

  return (
    <Dialog labelledBy="plan-dialog-title" size="lg" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="plan-dialog-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">{t('plans.dialog.title')}{heading && <span className="ms-2 text-base font-normal text-muted-foreground" dir="auto">{heading}</span>}</h2>
        <Button type="button" variant="ghost" aria-label={t('common.close')} onClick={onClose}>✕</Button>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{subtitle && <><ContentText>{subtitle}</ContentText>. </>}{t('plans.dialog.intro')}</p>

      {chooser && (
        <div className="mb-3 grid gap-3 sm:grid-cols-2" data-testid="plan-anchor-pick">
          <label className={fieldCls}>{t('plans.anchorKind')}
            <select aria-label={t('plans.anchorKind')} className={selectCls} value={pickKind} onChange={(e) => { setPickKind(e.target.value as PlanAnchorKind); setPickId(''); setPicked(false); }}>
              {CHOOSABLE.map((k) => <option key={k} value={k}>{anchorLabels[k]}</option>)}
            </select>
          </label>
          {(pickKind === 'org_unit' || pickKind === 'program' || pickKind === 'evidence_item') && (
            <label className={fieldCls}>{t('plans.anchorWhich')}
              <select aria-label={t('plans.anchorWhich')} className={selectCls} value={pickId} onChange={(e) => { setPickId(e.target.value); setPicked(false); }}>
                <option value="">{t('plans.anchorChoose')}</option>
                {pickKind === 'org_unit' && dir.units.map((u) => <option key={u.id} value={u.id}>{u.nameEn}</option>)}
                {pickKind === 'program' && dir.programs.map((p) => <option key={p.id} value={p.id}>{p.nameEn}{p.detail ? ` · ${p.detail}` : ''}</option>)}
                {pickKind === 'evidence_item' && (evidenceList.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
              </select>
            </label>
          )}
          {pickKind === 'framework' && qf.isSuccess && !qf.data.framework && <p className="text-sm text-muted-foreground sm:col-span-2" data-testid="no-framework">{t('quality.noFramework')}</p>}
        </div>
      )}

      <section aria-label={t('plans.dialog.inEffect')} className="mb-3 space-y-2 rounded-md border border-border p-2 text-sm" data-testid="plans-in-effect">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('plans.dialog.inEffect')}</p>
        {plan && state.isLoading && <p className="text-muted-foreground">{t('common.loading')}</p>}
        {!plan && <p className="text-muted-foreground">{t('plans.dialog.pickFirst')}</p>}
        {state.isSuccess && effective.length === 0 && <p className="text-muted-foreground" data-testid="plans-none">{t('plans.dialog.none')}</p>}
        <ul className="space-y-2">
          {effective.map((e) => {
            const own = ownOf(e.templateId);
            return (
              <li key={e.templateId} className="space-y-1 rounded border border-border p-2" data-testid="effective-plan" data-opted-out={e.optedOut}>
                <p className="min-w-0 break-words"><ContentText className="font-medium">{e.templateName}</ContentText>{' '}
                  {e.optedOut ? <Chip tone="warn" testId="opted-out">{t('plans.optedOut')}</Chip> : <span className="text-muted-foreground" data-testid="plan-recurrence">{recurrenceText(t, e.recurrence)}{e.firstStart ? ` · ${t('plans.first', { date: day(e.firstStart) })}` : ''}</span>}
                </p>
                <p className="text-xs text-muted-foreground" data-testid="plan-source">({planSourceLabel(t, e.source, e.sourceCodes, internal)})</p>
                <div className="flex flex-wrap gap-1">
                  {e.source.kind === 'own' && own && <Button type="button" variant="outline" className="px-3 py-1" disabled={busy} onClick={() => void back(own.id)}>{requirement ? t('ops.backToInherited') : t('plans.remove')}</Button>}
                  {requirement && e.source.kind !== 'own' && !e.optedOut && <Button type="button" variant="outline" className="px-3 py-1" disabled={busy} onClick={() => void optOut(e.templateId)}>{t('plans.optOut')}</Button>}
                  {requirement && e.source.kind !== 'own' && !e.optedOut && <Button type="button" variant="ghost" className="px-3 py-1" disabled={busy} onClick={() => { choose(e.templateId); }}>{t('plans.override')}</Button>}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <form className="space-y-3" onSubmit={(ev) => { ev.preventDefault(); void save(); }} aria-label={t('plans.dialog.form')}>
        <p className="text-sm font-medium">{mine ? t('plans.dialog.change') : t('plans.dialog.add')}</p>
        {plan && templates.isSuccess && fits.length === 0 && <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="no-templates">{t('plans.dialog.noTemplates')}</p>}
        <label className={fieldCls}>{t('plans.template')}
          <select aria-label={t('plans.template')} className={selectCls} value={form.templateId} onChange={(e) => choose(e.target.value)}>
            {fits.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            {form.templateId && !fits.some((x) => x.id === form.templateId) && <option value={form.templateId}>{templateName(form.templateId)}</option>}
          </select>
        </label>
        {mine?.mode === 'opt_out' && <p className="text-sm text-amber-900" data-testid="was-opted-out">{t('plans.dialog.wasOptedOut')}</p>}
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={fieldCls}>{t('plans.repeats')}
            <select aria-label={t('plans.repeats')} className={selectCls} value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value as Pattern })}>
              <option value="term">{t('plans.pattern.term')}</option>
              <option value="year">{t('plans.pattern.year')}</option>
              <option value="month">{t('plans.pattern.month')}</option>
              <option value="decision">{t('plans.pattern.decision')}</option>
            </select>
          </label>
          {form.pattern !== 'decision' && (
            <label className={fieldCls}>{t('plans.every')}
              <Input type="number" min={1} max={100} aria-label={t('plans.every')} value={form.every} onChange={(e) => setForm({ ...form, every: Math.max(1, Number(e.target.value) || 1) })} />
            </label>
          )}
          <label className={fieldCls}>{t('plans.firstStart')}<Input type="date" required aria-label={t('plans.firstStart')} value={form.first} onChange={(e) => setForm({ ...form, first: e.target.value })} /></label>
        </div>
        {form.pattern === 'decision' && <p className="text-xs text-muted-foreground">{t('plans.decisionHint')}</p>}
        {(form.pattern === 'term' || form.pattern === 'year') && <p className="text-xs text-muted-foreground">{t('plans.calendarHint')}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={fieldCls}>{t('plans.unit')}
            <select aria-label={t('plans.unit')} className={selectCls} value={form.unitId} onChange={(e) => setForm({ ...form, unitId: e.target.value })}>
              <option value="">{t('plans.unitFromSubject')}</option>
              {dir.units.map((u) => <option key={u.id} value={u.id}>{u.nameEn}</option>)}
            </select>
          </label>
          <label className={fieldCls}>{t('plans.owner')}
            <select aria-label={t('plans.owner')} className={selectCls} value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
              <option value="">{t('plans.ownerFromTemplate')}</option>
              {dir.people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
            </select>
          </label>
        </div>

        <fieldset className="space-y-2 rounded-md border border-border p-2">
          <legend className="px-1 text-sm">{t('plans.appliesTo')}</legend>
          <p className="text-xs text-muted-foreground">{t('plans.appliesHint')}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" role="group" aria-label={t('plans.kinds')}>
            {(['institution', 'org_unit', 'program'] as const).map((k) => (
              <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={form.kinds.has(k)} onChange={() => toggle('kinds', k)} />{k === 'institution' ? t('plans.kind.institution') : k === 'org_unit' ? t('plans.kind.org_unit') : t('plans.kind.program')}</label>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" role="group" aria-label={t('plans.programLevels')}>
            <span className="text-xs text-muted-foreground">{t('plans.programLevels')}</span>
            {DEGREE_LEVELS.map((l) => <label key={l} className="flex items-center gap-2"><input type="checkbox" checked={form.levels.has(l)} onChange={() => toggle('levels', l)} />{l}</label>)}
          </div>
          {(types.data ?? []).length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" role="group" aria-label={t('plans.unitTypes')}>
              <span className="text-xs text-muted-foreground">{t('plans.unitTypes')}</span>
              {(types.data ?? []).map((u) => <label key={u.key} className="flex items-center gap-2"><input type="checkbox" checked={form.types.has(u.key)} onChange={() => toggle('types', u.key)} /><ContentText>{u.labelEn}</ContentText></label>)}
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-sm">{t('plans.onlyThese', { count: form.ids.size })}</summary>
            <div className="mt-2 space-y-2">
              <Input aria-label={t('ops.scope.filter')} placeholder={t('ops.scope.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
              <ul className="max-h-48 space-y-1 overflow-y-auto" aria-label={t('plans.itemsList')}>
                {list.map((i) => (
                  <li key={`${i.group}:${i.id}`}>
                    <label className="flex items-start gap-2 text-sm">
                      <input type="checkbox" className="mt-1" checked={form.ids.has(i.id)} onChange={() => toggle('ids', i.id)} />
                      <span className="min-w-0"><ContentText>{i.nameEn}</ContentText>{i.nameAr && <> <ContentText className="text-muted-foreground">{i.nameAr}</ContentText></>}<span className="text-xs text-muted-foreground"> · {i.group === 'unit' ? t('plans.kind.org_unit') : t('plans.kind.program')}</span></span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        </fieldset>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />{t('plans.active')}</label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>{t('common.done')}</Button>
          <Button type="submit" disabled={!valid || !plan || busy}>{t('plans.save')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
