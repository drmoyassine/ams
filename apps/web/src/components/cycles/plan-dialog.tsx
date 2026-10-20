// "Collect this regularly" (TASK-081, simplified by DEC-030): the plan of one evidence item. A plan is a template, how often it repeats (every
// term, every year, every N years or months), when the first run is due and who owns it. A plan only PROPOSES runs: the one that falls due
// appears in Quality Management -> Cycles -> Due to launch and, for its owner, in My work; nothing starts by itself. Opened from the
// evidence item's card, and from the Plans tab's "New plan" (which first asks which evidence item). Plans on anything else (a unit, a
// program, the institution) are Quality Assurance / report cycles: the engine keeps them, but no screen offers them.
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fitsEvidenceCycle, type CyclePlan, type CycleRecurrence, type Me } from '@ams/shared';
import { useTranslation } from '../../i18n';
import { useAction } from '../../lib/use-action';
import { useCyclesApi } from '../../lib/cycles-api';
import { useEvidenceApi } from '../../lib/evidence-api';
import { usePlansApi } from '../../lib/plans-api';
import { ContentText } from '../content-text';
import { Dialog } from '../dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useDirectory, type CycleApis } from './directory';
import { fieldCls, selectCls } from './labels';

type Pattern = 'term' | 'year' | 'month' | 'decision';
const today = () => new Date().toISOString().slice(0, 10);
const DEFAULT_TEMPLATE_KEY = 'evidence_collection';

/** The evidence item a plan is for: its id and title, and its owner (the default owner of the plan). */
export interface PlanEvidence { id: string; title: string; ownerUserId: string | null }

interface Form { templateId: string; pattern: Pattern; every: number; first: string; ownerId: string }
const patternOf = (r: CycleRecurrence | null | undefined): { pattern: Pattern; every: number } => (!r ? { pattern: 'year', every: 1 } : 'after' in r ? { pattern: 'decision', every: 1 } : { pattern: r.unit, every: r.every });
const recurrenceOf = (f: Form, keep: CycleRecurrence | null): CycleRecurrence => (f.pattern === 'decision'
  ? { after: 'previous_ends', setBy: 'decision', ...(keep && 'after' in keep && keep.dates ? { dates: keep.dates } : {}) }
  : { every: f.every, unit: f.pattern });

/**
 * `evidence`: the item the plan is for (its card). Without it the dialog starts by asking which evidence item (the Plans tab).
 * `plan`: a plan being changed (its template is then fixed). `me`: the person opening it, the owner when nothing else says.
 */
export function PlanDialog({ evidence, plan, me, apis = {}, onClose, onSaved }: { evidence?: PlanEvidence; plan?: CyclePlan; me?: Me | undefined; apis?: CycleApis; onClose: () => void; onSaved?: (plan: CyclePlan) => void }) {
  const { t } = useTranslation();
  const plans = usePlansApi(apis.plans);
  const cycles = useCyclesApi(apis.cycles);
  const evidenceApi = useEvidenceApi(apis.evidence);
  const dir = useDirectory(apis);
  const qc = useQueryClient();
  const [itemPick, setItemPick] = useState('');
  const [templatePick, setTemplatePick] = useState(plan?.templateId ?? '');
  const [patternPick, setPatternPick] = useState<Pattern | null>(null);
  const [everyPick, setEveryPick] = useState<number | null>(null);
  const [firstPick, setFirstPick] = useState<string | null>(null);
  const [ownerPick, setOwnerPick] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = useAction(setError);

  const items = useQuery({ queryKey: ['evidence-items-for-cycles'], queryFn: () => evidenceApi.list(), enabled: !evidence && !plan });
  const chosen = evidence ?? (plan?.anchorId ? { id: plan.anchorId, title: plan.anchorName ?? '', ownerUserId: null } : (items.data ?? []).find((e) => e.id === itemPick));
  const templates = useQuery({ queryKey: ['cycle-templates', 'published', 'evidence_item'], queryFn: () => cycles.templates({ status: 'published', anchorKind: 'evidence_item' }) });
  const fits = (templates.data ?? []).filter((x) => x.status === 'published' && fitsEvidenceCycle(x.anchorKinds));
  const templateId = plan?.templateId ?? (fits.some((x) => x.id === templatePick) ? templatePick : (fits.find((x) => x.key === DEFAULT_TEMPLATE_KEY) ?? fits[0])?.id ?? '');
  // What is already set for this evidence item (one plan per template), so choosing a template that has a plan shows its values.
  const state = useQuery({ queryKey: ['cycle-plans', 'target', 'evidence_item', chosen?.id], queryFn: () => plans.target({ anchorKind: 'evidence_item', anchorId: chosen!.id }), enabled: !!chosen });
  const mine = plan ?? (state.data?.own ?? []).find((p) => p.templateId === templateId && p.mode === 'own');
  const base = patternOf(mine?.recurrence);
  const form: Form = {
    templateId, pattern: patternPick ?? base.pattern, every: everyPick ?? base.every, first: firstPick ?? mine?.firstStart ?? today(),
    ownerId: ownerPick ?? mine?.ownerUserId ?? chosen?.ownerUserId ?? me?.userId ?? '',
  };
  const valid = !!chosen && !!form.templateId && !!form.first && form.every >= 1 && !!form.ownerId;
  const noTemplates = templates.isSuccess && fits.length === 0;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !chosen) return;
    setBusy(true); setError('');
    try {
      const r = await act(() => plans.set({
        anchorKind: 'evidence_item', anchorId: chosen.id, templateId: form.templateId, mode: 'own', recurrence: recurrenceOf(form, mine?.recurrence ?? null), firstStart: form.first,
        ownerUserId: form.ownerId, responsibleUnitId: mine?.responsibleUnitId ?? null, appliesTo: mine?.appliesTo ?? {}, active: true,
      }));
      if (r) {
        await Promise.all([qc.invalidateQueries({ queryKey: ['cycle-plans'] }), qc.invalidateQueries({ queryKey: ['due-runs'] }), qc.invalidateQueries({ queryKey: ['my-work'] })]);
        onSaved?.(r); onClose();
      }
    } finally { setBusy(false); }
  };

  return (
    <Dialog labelledBy="plan-dialog-title" size="lg" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="plan-dialog-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">{t('evc.dialog.title')}{chosen?.title && <span className="ms-2 text-base font-normal text-muted-foreground" dir="auto">{chosen.title}</span>}</h2>
        <Button type="button" variant="ghost" aria-label={t('common.close')} onClick={onClose}>✕</Button>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{t('evc.dialog.intro')}</p>
      <form className="space-y-3" onSubmit={(ev) => void save(ev)} aria-label={t('evc.dialog.form')}>
        {!evidence && !plan && (
          <label className={fieldCls} data-testid="plan-anchor-pick">{t('qmc.new.evidence')}
            <select aria-label={t('qmc.new.evidence')} className={selectCls} value={itemPick} required onChange={(e) => { setItemPick(e.target.value); setOwnerPick(null); }}>
              <option value="">{t('qmc.new.chooseEvidence')}</option>
              {(items.data ?? []).filter((x) => x.status === 'active').map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
          </label>
        )}
        {noTemplates && <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="no-templates">{t('qmc.new.noTemplates')}</p>}
        <label className={fieldCls}>{t('plans.template')}
          <select aria-label={t('plans.template')} className={selectCls} value={form.templateId} disabled={!!plan} onChange={(e) => { setTemplatePick(e.target.value); setPatternPick(null); setEveryPick(null); setFirstPick(null); setOwnerPick(null); }}>
            {fits.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            {plan && !fits.some((x) => x.id === plan.templateId) && <option value={plan.templateId}>{plan.templateName}</option>}
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={fieldCls}>{t('plans.repeats')}
            <select aria-label={t('plans.repeats')} className={selectCls} value={form.pattern} onChange={(e) => setPatternPick(e.target.value as Pattern)}>
              <option value="term">{t('plans.pattern.term')}</option>
              <option value="year">{t('plans.pattern.year')}</option>
              <option value="month">{t('plans.pattern.month')}</option>
              {(form.pattern === 'decision' || base.pattern === 'decision') && <option value="decision">{t('plans.pattern.decision')}</option>}
            </select>
          </label>
          {form.pattern !== 'decision' && (
            <label className={fieldCls}>{t('plans.every')}
              <Input type="number" min={1} max={100} aria-label={t('plans.every')} value={form.every} onChange={(e) => setEveryPick(Math.max(1, Number(e.target.value) || 1))} />
            </label>
          )}
          <label className={fieldCls}>{t('evc.firstDue')}<Input type="date" required aria-label={t('evc.firstDue')} value={form.first} onChange={(e) => setFirstPick(e.target.value)} /></label>
        </div>
        {(form.pattern === 'term' || form.pattern === 'year') && <p className="text-xs text-muted-foreground">{t('plans.calendarHint')}</p>}
        {form.pattern === 'decision' && <p className="text-xs text-muted-foreground">{t('plans.decisionHint')}</p>}
        <label className={fieldCls}>{t('qmc.new.owner')}
          <select aria-label={t('qmc.new.owner')} className={selectCls} value={form.ownerId} onChange={(e) => setOwnerPick(e.target.value)}>
            {dir.people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </select>
        </label>
        <p className="text-xs text-muted-foreground"><ContentText>{chosen?.title ?? ''}</ContentText>{chosen ? ' · ' : ''}{t('evc.dialog.proposes')}</p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={!valid || busy}>{t('plans.save')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
