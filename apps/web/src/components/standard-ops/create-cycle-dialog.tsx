import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CycleDetail, Me, NodeAssignment } from '@ams/shared';
import { useTranslation } from '../../i18n';
import { useCyclesApi, type CyclesApi } from '../../lib/cycles-api';
import { useScopeApi, type ScopeApi } from '../../lib/scope-api';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';
import { ContentText } from '../content-text';
import { Dialog } from '../dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import type { OpsTarget } from './scope-dialog';

const select = 'w-full rounded-md border border-border bg-background px-2 py-2 text-sm';
const today = () => new Date().toISOString().slice(0, 10);
/** Where the cycles of Quality Management are listed; the cycle's own page comes with TASK-080. */
export const CYCLES_HREF = '/quality-management';

/**
 * Create cycle, from the ⋯ menu of a standard: the standard is the cycle's anchor. Pick a published template that fits (or none,
 * for a blank cycle to fill in by hand), who the cycle is about (a unit or a program), when it starts and who leads it. The cycle
 * is made as a draft (its stages resolved from the template's rules) and a short confirmation links to it. With no published
 * template the dialog says so and points to Settings -> Quality Management.
 */
export function CreateCycleDialog({ target, me, assignment, api: apiProp, scope: scopeProp, settings, onClose }: {
  target: OpsTarget & { anchorId: string }; me: Me | undefined; assignment: NodeAssignment | undefined; api?: CyclesApi; scope?: ScopeApi; settings?: SettingsApi; onClose: () => void;
}) {
  const { t } = useTranslation();
  const api = useCyclesApi(apiProp);
  const scopeApi = useScopeApi(scopeProp);
  const settingsApi = useSettingsApi(settings);
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['cycle-templates', 'published', 'requirement'], queryFn: () => api.templates({ status: 'published', anchorKind: 'requirement' }) });
  const items = useQuery({ queryKey: ['scope-items'], queryFn: () => scopeApi.items() });
  const people = useQuery({ queryKey: ['people'], queryFn: () => settingsApi.people() });
  const fits = (templates.data ?? []).filter((x) => x.status === 'published' && (x.anchorKinds.length === 0 || x.anchorKinds.includes('requirement')));
  // A scope that is one unit or program starts the choice for them.
  const only = (assignment?.scope.effective?.levels ?? []).flatMap((l) => (l.kind === 'org_unit' || l.kind === 'program') && !l.all && l.items.length === 1 ? [`${l.kind}:${l.items[0]!.id}`] : []);
  const [subject, setSubject] = useState(only.length === 1 ? only[0]! : '');
  const [templateId, setTemplateId] = useState('');
  const [startDate, setStartDate] = useState(today());
  const [lead, setLead] = useState(me?.userId ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<CycleDetail | null>(null);
  const act = useAction(setError);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const [kind, id] = subject.split(':') as ['org_unit' | 'program', string];
    setBusy(true); setError('');
    try {
      const r = await act(() => api.launch({
        anchorKind: 'requirement', anchorId: target.anchorId, subjectKind: kind, subjectId: id, startDate,
        ...(templateId ? { templateId } : {}), ...(lead ? { leadUserId: lead } : {}),
      }));
      if (r) { setMade(r); void qc.invalidateQueries({ queryKey: ['cycles'] }); }
    } finally { setBusy(false); }
  };

  const noTemplates = templates.data !== undefined && fits.length === 0;
  return (
    <Dialog labelledBy="cycle-dialog-title" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="cycle-dialog-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">{made ? t('ops.cycle.created') : t('ops.cycle.title')}<span className="ms-2 text-base font-normal text-muted-foreground" dir="auto">{target.label}</span></h2>
        <Button type="button" variant="ghost" aria-label={t('common.close')} onClick={onClose}>✕</Button>
      </div>

      {made ? (
        <div className="space-y-3" data-testid="cycle-confirmation">
          <p className="text-sm"><ContentText className="font-medium">{made.title}</ContentText> {t('ops.cycle.createdDraft')}</p>
          {made.unresolvedCount > 0 && <p className="text-xs text-muted-foreground">{t('ops.cycle.unresolved', { count: made.unresolvedCount })}</p>}
          <p className="text-sm"><a className="underline" href={CYCLES_HREF}>{t('ops.cycle.open')}</a></p>
          <div className="flex justify-end"><Button type="button" onClick={onClose}>{t('common.done')}</Button></div>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label={t('ops.cycle.title')}>
          <p className="text-sm text-muted-foreground"><ContentText>{target.title}</ContentText>. {t('ops.cycle.intro')}</p>
          {noTemplates && <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="no-templates">{t('ops.cycle.noTemplates')}</p>}
          <label className="flex flex-col text-sm">{t('ops.cycle.template')}
            <select aria-label={t('ops.cycle.template')} className={select} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">{t('ops.cycle.blank')}</option>
              {fits.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-sm">{t('ops.cycle.subject')}
            <select aria-label={t('ops.cycle.subject')} required className={select} value={subject} onChange={(e) => setSubject(e.target.value)}>
              <option value="">{t('ops.cycle.chooseSubject')}</option>
              <optgroup label={t('ops.cycle.units')}>{(items.data?.orgUnit ?? []).map((u) => <option key={u.id} value={`org_unit:${u.id}`}>{u.nameEn}</option>)}</optgroup>
              <optgroup label={t('ops.cycle.programs')}>{(items.data?.program ?? []).map((p) => <option key={p.id} value={`program:${p.id}`}>{p.nameEn}{p.detail ? ` · ${p.detail}` : ''}</option>)}</optgroup>
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col text-sm">{t('ops.cycle.start')}<Input type="date" required aria-label={t('ops.cycle.start')} value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
            <label className="flex flex-col text-sm">{t('ops.cycle.lead')}
              <select aria-label={t('ops.cycle.lead')} className={select} value={lead} onChange={(e) => setLead(e.target.value)}>
                {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
              </select>
            </label>
          </div>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={busy || !subject || !startDate}>{t('ops.cycle.create')}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
