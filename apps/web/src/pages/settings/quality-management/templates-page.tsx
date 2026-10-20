// Settings -> Quality Management: the institution's cycle templates (DEC-029, TASK-079). Everyone who can read the organization sees
// the list; people with cycle:manage can also add the shipped defaults, make a new template, duplicate, revise, retire and offer
// again, and delete a draft that was never published (every change can be undone). Opening a template shows the editor.
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CYCLE_TEMPLATE_STATUSES, DEFAULT_CYCLE_TEMPLATE_KEYS, fitsEvidenceCycle, type CycleTemplate, type CycleTemplateStatus } from '@ams/shared';
import { Dialog } from '../../../components/dialog';
import { ReadOnlyNote } from '../../../components/read-only-note';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { useTranslation } from '../../../i18n';
import { defaultCyclesApi, type CyclesApi } from '../../../lib/cycles-api';
import { can, useMe } from '../../../lib/me';
import { defaultSettingsApi, type SettingsApi } from '../../../lib/settings-api';
import { useAction } from '../../../lib/use-action';
import { slug, uniqueKey } from './editor-model';
import { anchorLabels, statusLabels, type T } from './labels';

const control = 'rounded-md border border-border bg-background px-3 py-2 text-sm';
const small = 'px-3 py-1';

export function QualityManagementSettingsPage({ api = defaultCyclesApi, settingsApi = defaultSettingsApi, onOpen }: {
  api?: CyclesApi; settingsApi?: SettingsApi; onOpen: (id: string) => void;
}) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const qc = useQueryClient();
  const me = useMe(settingsApi);
  const canManage = can(me.data, 'cycle:manage');
  const list = useQuery({ queryKey: ['cycle-templates'], queryFn: () => api.templates() });
  const [filter, setFilter] = useState<'' | CycleTemplateStatus>('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const act = useAction(setError);
  const statuses = statusLabels(t);
  const anchors = anchorLabels(t);

  const all = list.data ?? [];
  const rows = filter ? all.filter((x) => x.status === filter) : all;
  const haveKeys = new Set(all.map((x) => x.key));
  const missing = DEFAULT_CYCLE_TEMPLATE_KEYS.filter((k) => !haveKeys.has(k));
  const refresh = () => qc.invalidateQueries({ queryKey: ['cycle-templates'] });

  const run = async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setError(''); setMessage(''); setBusy(true);
    try { const r = await act(fn); await refresh(); return r; } finally { setBusy(false); }
  };
  const install = async (restore: boolean) => {
    const r = await run(() => api.installDefaultTemplates());
    if (r) setMessage(!r.installed.length ? t('qmt.defaults.none') : restore ? t('qmt.defaults.restored', { count: r.installed.length }) : t('qmt.defaults.added', { count: r.installed.length }));
  };
  const duplicate = async (src: CycleTemplate) => {
    const key = uniqueKey(slug(`${src.key}_copy`, 'template_copy'), all.map((x) => x.key));
    const made = await run(() => api.createTemplate({
      key, name: t('qmt.copyOf', { name: src.name }), ...(src.nameAr ? { nameAr: src.nameAr } : {}), ...(src.description ? { description: src.description } : {}),
      anchorKinds: src.anchorKinds, stages: src.stages,
    }));
    if (made) onOpen(made.id);
  };
  const revise = async (src: CycleTemplate) => { const r = await run(() => api.reviseTemplate(src.id)); if (r) onOpen(r.id); };

  return (
    <section className="space-y-4" aria-label={t('qmt.title')}>
      <div>
        <h2 className="text-xl font-semibold">{t('qmt.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('qmt.intro')}</p>
      </div>
      <ReadOnlyNote show={me.isSuccess && !canManage} />
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {message && <p role="status" className="text-sm text-green-800">{message}</p>}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('qmt.filter.status')}
          <select aria-label={t('qmt.filter.status')} className={control} value={filter} onChange={(e) => setFilter(e.target.value as '' | CycleTemplateStatus)}>
            <option value="">{t('qmt.filter.all')}</option>
            {CYCLE_TEMPLATE_STATUSES.map((s) => <option key={s} value={s}>{statuses[s]}</option>)}
          </select>
        </label>
        {canManage && <Button type="button" onClick={() => setCreating(true)}>{t('qmt.act.new')}</Button>}
        {canManage && all.length > 0 && missing.length > 0 && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void install(true)}>{t('qmt.act.restoreDefaults', { count: missing.length })}</Button>
        )}
      </div>

      {list.isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {list.isError && <p role="alert" className="text-sm text-red-700">{(list.error as Error).message}</p>}

      {list.isSuccess && all.length === 0 && (
        <div data-testid="no-templates" className="space-y-3 rounded-lg border border-dashed border-border p-5">
          <p className="font-medium">{t('qmt.empty.title')}</p>
          <p className="text-sm text-muted-foreground">{canManage ? t('qmt.empty.manage') : t('qmt.empty.view')}</p>
          {canManage && <Button type="button" disabled={busy} onClick={() => void install(false)}>{t('qmt.act.addDefaults')}</Button>}
        </div>
      )}
      {list.isSuccess && all.length > 0 && rows.length === 0 && <p className="text-sm text-muted-foreground">{t('qmt.empty.filtered')}</p>}

      <ul className="space-y-2" aria-label={t('qmt.list.label')}>
        {rows.map((x) => (
          <li key={x.id} data-testid="template-row" data-status={x.status} className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <button type="button" className="max-w-full break-words text-start text-base font-medium underline-offset-2 hover:underline" dir="auto"
                  aria-label={canManage && x.status === 'draft' ? t('qmt.act.editNamed', { name: x.name }) : t('qmt.act.viewNamed', { name: x.name })} onClick={() => onOpen(x.id)}>
                  {x.name}
                </button>
                {x.nameAr && <p className="break-words text-sm text-muted-foreground" dir="auto">{x.nameAr}</p>}
              </div>
              <span data-testid="template-status" className="rounded-full bg-muted px-2 py-0.5 text-xs">{statuses[x.status]}</span>
            </div>
            <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              <div className="flex gap-1"><dt>{t('qmt.col.version')}</dt><dd>{x.version > 0 ? x.version : t('qmt.notPublished')}</dd></div>
              <div className="flex gap-1"><dt>{t('qmt.col.stages')}</dt><dd>{x.stages.length}</dd></div>
              <div className="flex min-w-0 gap-1"><dt>{t('qmt.col.fits')}</dt><dd className="break-words">{x.anchorKinds.length ? x.anchorKinds.map((k) => anchors[k]).join(', ') : t('qmt.fits.any')}</dd></div>
              {x.cycleCount > 0 && <div className="flex gap-1"><dt>{t('qmt.col.cycles')}</dt><dd>{x.cycleCount}</dd></div>}
              {x.origin === 'default' && <div><dd>{t('qmt.origin.default')}</dd></div>}
              {!fitsEvidenceCycle(x.anchorKinds) && <div data-testid="qa-only"><dd className="rounded border border-border bg-muted px-1.5 py-0.5">{t('qmt.qaOnly')}</dd></div>}
            </dl>
            {canManage && (
              <div className="flex flex-wrap gap-1">
                <Button type="button" variant="outline" className={small} disabled={busy} aria-label={t('qmt.act.duplicateNamed', { name: x.name })} onClick={() => void duplicate(x)}>{t('qmt.act.duplicate')}</Button>
                {(x.status === 'published' || x.status === 'retired') && (
                  <Button type="button" variant="outline" className={small} disabled={busy} aria-label={t('qmt.act.reviseNamed', { name: x.name })} onClick={() => void revise(x)}>{t('qmt.act.revise')}</Button>
                )}
                {x.status === 'published' && (
                  <Button type="button" variant="outline" className={small} disabled={busy} aria-label={t('qmt.act.retireNamed', { name: x.name })} onClick={() => void run(() => api.retireTemplate(x.id))}>{t('qmt.act.retire')}</Button>
                )}
                {x.status === 'retired' && (
                  <Button type="button" variant="outline" className={small} disabled={busy} aria-label={t('qmt.act.reinstateNamed', { name: x.name })} onClick={() => void run(() => api.reinstateTemplate(x.id))}>{t('qmt.act.reinstate')}</Button>
                )}
                {x.status === 'draft' && x.version === 0 && (
                  <Button type="button" variant="ghost" className={`${small} text-red-700`} disabled={busy} aria-label={t('qmt.act.deleteNamed', { name: x.name })} onClick={() => void run(() => api.deleteTemplate(x.id))}>{t('common.delete')}</Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {creating && (
        <NewTemplateDialog existing={all.map((x) => x.key)} api={api} onClose={() => setCreating(false)}
          onCreated={async (made) => { setCreating(false); await refresh(); onOpen(made.id); }} />
      )}
    </section>
  );
}

function NewTemplateDialog({ existing, api, onClose, onCreated }: { existing: string[]; api: CyclesApi; onClose: () => void; onCreated: (t: CycleTemplate) => void | Promise<void> }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = useAction(setError);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError(''); setBusy(true);
    try {
      const made = await act(() => api.createTemplate({ key: uniqueKey(slug(name, 'template'), existing), name: name.trim(), ...(nameAr.trim() ? { nameAr: nameAr.trim() } : {}) }));
      if (made) await onCreated(made);
    } finally { setBusy(false); }
  };
  return (
    <Dialog labelledBy="new-template-title" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="new-template-title" className="min-w-0 pt-1 text-lg font-semibold">{t('qmt.new.title')}</h2>
        <Button type="button" variant="ghost" aria-label={t('common.close')} onClick={onClose}>✕</Button>
      </div>
      <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label={t('qmt.new.title')}>
        <p className="text-sm text-muted-foreground">{t('qmt.new.hint')}</p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('qmt.f.nameEn')}
          <Input aria-label={t('qmt.f.templateName')} dir="auto" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('qmt.f.nameAr')}
          <Input aria-label={t('qmt.f.templateNameAr')} dir="auto" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
        </label>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={!name.trim() || busy}>{t('qmt.new.create')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
