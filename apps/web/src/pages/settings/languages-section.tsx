// Settings -> Organization -> Institution -> Languages (TASK-070): the secondary language, the default interface language, the
// status of the secondary language's interface catalogue, the translate job and a review table. Everyone who can read the
// organization sees it; only an administrator changes it.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACTIVE_TRANSLATION_STATUSES, RESUMABLE_TRANSLATION_STATUSES, SECONDARY_CHOICES, directionOf, languageInfo, type TranslationRun, type UiTranslationRow } from '@ams/shared';
import { useConfirm } from '../../components/confirm-dialog';
import { ReadOnlyNote } from '../../components/read-only-note';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useTranslation } from '../../i18n';
import { formatNumber } from '../../lib/intl';
import type { SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
type Filter = 'all' | 'missing' | 'needs_review' | 'reviewed' | 'stale';
const PAGE = 25;

function RunSummary({ run, api, canEdit, onChange }: { run: TranslationRun; api: SettingsApi; canEdit: boolean; onChange: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const status = {
    queued: t('languages.run.status.queued'), running: t('languages.run.status.running'), succeeded: t('languages.run.status.succeeded'),
    failed: t('languages.run.status.failed'), cancelled: t('languages.run.status.cancelled'), stopped: t('languages.run.status.stopped'),
  }[run.status];
  const active = (ACTIVE_TRANSLATION_STATUSES as readonly string[]).includes(run.status);
  const resumable = (RESUMABLE_TRANSLATION_STATUSES as readonly string[]).includes(run.status);
  return (
    <div className="space-y-1 rounded-md border border-border p-3 text-sm" data-testid="translation-run">
      <p><span className="font-medium">{t('languages.run.last')}:</span> <span data-testid="run-status">{status}</span></p>
      <p>{t('languages.run.progress', { done: formatNumber(run.progress.done), total: formatNumber(run.progress.total), flagged: formatNumber(run.progress.flagged) })}</p>
      <p className="text-muted-foreground">{t('languages.run.usage', { tokens: formatNumber(run.usage.inputTokens + run.usage.outputTokens), calls: formatNumber(run.usage.calls) })}</p>
      {run.error && !active && <p role="status" className="text-muted-foreground" dir="auto">{run.error}</p>}
      {run.flagged.length > 0 && (
        <div>
          <p>{t('languages.run.flagged')}</p>
          <ul className="list-disc ps-5 text-xs text-muted-foreground">{run.flagged.map((f) => <li key={f.id}><code>{f.id}</code>: {f.reason}</li>)}</ul>
        </div>
      )}
      {canEdit && (active || resumable) && (
        <div className="flex gap-2 pt-1">
          {active && <Button type="button" variant="outline" onClick={() => void act(() => api.cancelTranslation(run.id)).then(onChange)}>{t('languages.cancelRun')}</Button>}
          {resumable && <Button type="button" variant="outline" onClick={() => void act(() => api.resumeTranslation(run.id)).then(onChange)}>{t('languages.resumeRun')}</Button>}
        </div>
      )}
      {error && <p role="alert" className="text-red-700">{error}</p>}
    </div>
  );
}

function ReviewRow({ row, api, canEdit, onChange, direction }: { row: UiTranslationRow; api: SettingsApi; canEdit: boolean; onChange: () => void; direction: 'ltr' | 'rtl' }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(row.text ?? '');
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const state = row.text === null ? t('languages.review.none') : row.origin === 'person' ? t('languages.review.person') : row.reviewed ? t('languages.review.aiReviewed') : t('languages.review.ai');
  return (
    <tr className="border-b border-border align-top" data-testid="review-row">
      <td className="px-2 py-1 font-mono text-xs break-all" dir="ltr">{row.key}</td>
      <td className="px-2 py-1" dir="ltr">{row.english}</td>
      <td className="px-2 py-1" dir={direction}>
        {editing ? (
          <div className="space-y-1">
            <textarea aria-label={t('languages.review.editLabel', { key: row.key })} dir={direction} rows={2} value={text} onChange={(e) => setText(e.target.value)} className="w-full rounded-md border border-border bg-background p-1 text-sm" />
            <div className="flex gap-2">
              <Button type="button" disabled={!text.trim()} onClick={() => void act(() => api.saveUiTranslation({ key: row.key, text })).then((r) => { if (r) { setEditing(false); onChange(); } })}>{t('common.save')}</Button>
              <Button type="button" variant="ghost" onClick={() => { setEditing(false); setText(row.text ?? ''); setError(null); }}>{t('common.cancel')}</Button>
            </div>
            {error && <p role="alert" className="text-xs text-red-700" dir="ltr">{error}</p>}
          </div>
        ) : (row.text ?? <span className="text-muted-foreground">—</span>)}
      </td>
      <td className="px-2 py-1 text-xs text-muted-foreground">
        {state}{row.stale && <span className="ms-1 rounded bg-amber-50 px-1 text-amber-900">{t('languages.review.outOfDate')}</span>}
      </td>
      <td className="px-2 py-1">
        {canEdit && !editing && (
          <div className="flex flex-wrap gap-1">
            <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => { setText(row.text ?? row.english); setEditing(true); }}>{t('languages.review.edit')}</Button>
            {row.text !== null && !row.reviewed && <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => void act(() => api.markUiReviewed([row.key])).then(onChange)}>{t('languages.review.markReviewed')}</Button>}
          </div>
        )}
      </td>
    </tr>
  );
}

function ReviewTable({ api, canEdit, language, onChange }: { api: SettingsApi; canEdit: boolean; language: string; onChange: () => void }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['languages', 'translations', filter, q, limit], queryFn: () => api.uiTranslations({ filter, q, limit }), placeholderData: (p) => p });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['languages'] }); void qc.invalidateQueries({ queryKey: ['i18n-bundle'] }); onChange(); };
  const dir = directionOf(language);
  return (
    <div className="space-y-2" data-testid="review-table">
      <h4 className="font-medium">{t('languages.review.title')}</h4>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">{t('languages.review.filter')}
          <select aria-label={t('languages.review.filter')} className={select} value={filter} onChange={(e) => { setFilter(e.target.value as Filter); setLimit(PAGE); }}>
            <option value="all">{t('languages.review.all')}</option>
            <option value="missing">{t('languages.review.missing')}</option>
            <option value="needs_review">{t('languages.review.needs')}</option>
            <option value="reviewed">{t('languages.review.reviewed')}</option>
            <option value="stale">{t('languages.review.stale')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">{t('common.search')}
          <Input aria-label={t('languages.review.search')} value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} className="w-56" />
        </label>
        {canEdit && <Button type="button" variant="outline" onClick={() => void act(() => api.markUiReviewed()).then(refresh)}>{t('languages.review.markAll')}</Button>}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <thead className="bg-muted">
            <tr>{[t('languages.review.key'), t('languages.review.english'), t('languages.review.translation'), t('languages.review.state'), t('languages.review.actions')].map((c) => <th key={c} scope="col" className="px-2 py-1 text-start font-medium">{c}</th>)}</tr>
          </thead>
          <tbody>
            {(list.data?.rows ?? []).map((r) => <ReviewRow key={`${r.key}:${r.text}:${r.reviewed}`} row={r} api={api} canEdit={canEdit} onChange={refresh} direction={dir} />)}
          </tbody>
        </table>
      </div>
      {list.data && list.data.rows.length === 0 && <p className="text-sm text-muted-foreground">{t('languages.review.empty')}</p>}
      {list.data && list.data.total > limit && <Button type="button" variant="outline" onClick={() => setLimit(limit + PAGE)}>{t('languages.review.more')}</Button>}
    </div>
  );
}

export function LanguagesSection({ api, canEdit }: { api: SettingsApi; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const [stale, setStale] = useState(false);
  const state = useQuery({
    queryKey: ['languages'], queryFn: () => api.languagesSettings(),
    // While a run is going, look again every two seconds.
    refetchInterval: (q) => ((ACTIVE_TRANSLATION_STATUSES as readonly string[]).includes(q.state.data?.run?.status ?? '') ? 2000 : false),
  });
  const data = state.data;
  const [secondary, setSecondary] = useState<string | null | undefined>(undefined);
  const [def, setDef] = useState<string | undefined>(undefined);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['languages'] }); void qc.invalidateQueries({ queryKey: ['institution'] }); void qc.invalidateQueries({ queryKey: ['me'] }); void qc.invalidateQueries({ queryKey: ['i18n-bundle'] }); };
  const save = useMutation({
    mutationFn: async () => {
      if (!data) return;
      const nextSecondary = secondary === undefined ? data.secondaryLanguage : secondary;
      const nextDefault = def ?? (nextSecondary === data.secondaryLanguage ? data.defaultLocale : 'en');
      if (data.secondaryLanguage && nextSecondary !== data.secondaryLanguage) {
        const old = languageInfo(data.secondaryLanguage)?.nameEn ?? data.secondaryLanguage;
        const next = nextSecondary ? languageInfo(nextSecondary)?.nameEn ?? nextSecondary : '';
        const ok = await confirm({
          title: t('languages.confirm.title'), message: nextSecondary ? t('languages.confirm.message', { old, new: next }) : t('languages.confirm.messageNone', { old }), confirmLabel: t('languages.confirm.ok'),
        });
        if (!ok) return;
      }
      setError(null);
      const r = await act(() => api.updateInstitution({ secondaryLanguage: nextSecondary, defaultLocale: nextDefault }));
      if (r) { setSecondary(undefined); setDef(undefined); refresh(); }
    },
  });
  if (state.isError) return <Card><h3 className="mb-1 text-lg font-semibold">{t('languages.title')}</h3><p role="alert" className="text-sm text-red-700">{t('languages.loadFailed')}</p></Card>;
  if (!data) return <Card><h3 className="mb-1 text-lg font-semibold">{t('languages.title')}</h3><p className="text-sm text-muted-foreground">{t('common.loading')}</p></Card>;

  const shownSecondary = secondary === undefined ? data.secondaryLanguage : secondary;
  const shownDefault = def ?? (shownSecondary === data.secondaryLanguage ? data.defaultLocale : 'en');
  const dirty = shownSecondary !== data.secondaryLanguage || shownDefault !== data.defaultLocale;
  const run = data.run;
  const running = !!run && (ACTIVE_TRANSLATION_STATUSES as readonly string[]).includes(run.status);
  const cat = data.catalogue;
  const info = languageInfo(data.secondaryLanguage);
  const canTranslate = canEdit && !!data.secondaryLanguage && !running && data.readiness?.ok === true && !dirty;
  return (
    <Card>
      <h3 className="mb-1 text-lg font-semibold">{t('languages.title')}</h3>
      <p className="mb-3 text-sm text-muted-foreground">{t('languages.intro')}</p>
      <ReadOnlyNote show={!canEdit} className="mb-3" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1 text-sm"><span>{t('languages.primary')}</span><span className="py-1 font-medium">{t('languages.primaryValue')}</span></div>
        <label className="flex flex-col gap-1 text-sm">{t('languages.secondary')}
          <select aria-label={t('languages.secondary')} className={select} disabled={!canEdit} value={shownSecondary ?? ''} onChange={(e) => { setSecondary(e.target.value || null); setDef(undefined); }}>
            <option value="">{t('languages.none')}</option>
            {SECONDARY_CHOICES.map((l) => <option key={l.code} value={l.code}>{l.nativeName} ({l.nameEn})</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">{t('languages.default')}
          <select aria-label={t('languages.default')} className={select} disabled={!canEdit || !shownSecondary} value={shownDefault} onChange={(e) => setDef(e.target.value)}>
            <option value="en">{languageInfo('en')?.nativeName}</option>
            {shownSecondary && <option value={shownSecondary}>{languageInfo(shownSecondary)?.nativeName ?? shownSecondary}</option>}
          </select>
          <span className="text-xs text-muted-foreground">{t('languages.defaultHint')}</span>
        </label>
      </div>
      {canEdit && (
        <div className="mt-3 flex items-center gap-3">
          <Button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{t('languages.save')}</Button>
          {error && <span role="alert" className="text-sm text-red-700">{error}</span>}
        </div>
      )}

      {cat && info && (
        <div className="mt-5 space-y-3" data-testid="catalogue-status">
          <h4 className="font-medium">{t('languages.catalogue')} · <span lang={info.code} dir={info.dir}>{info.nativeName}</span></h4>
          <p className="text-sm" data-testid="catalogue-counts">{t('languages.catalogue.counts', { translated: formatNumber(cat.translated), total: formatNumber(cat.total), reviewed: formatNumber(cat.reviewed) })}</p>
          <p className="text-xs text-muted-foreground">
            {t('languages.catalogue.byAi', { count: formatNumber(cat.byAi) })} · {t('languages.catalogue.byPerson', { count: formatNumber(cat.byPerson) })}
            {cat.stale > 0 && <> · <span className="text-amber-900">{t('languages.catalogue.stale', { count: formatNumber(cat.stale) })}</span></>}
          </p>
          {canEdit && (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" disabled={!canTranslate} onClick={() => void act(() => api.startTranslation(stale)).then(refresh)}>{t('languages.translate')}</Button>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stale} onChange={(e) => setStale(e.target.checked)} />{t('languages.translateStale')}</label>
              {data.readiness && !data.readiness.ok && <span role="status" className="text-sm text-muted-foreground">{t('languages.notReady', { reason: data.readiness.reason ?? '' })}</span>}
            </div>
          )}
          {run && <RunSummary run={run} api={api} canEdit={canEdit} onChange={refresh} />}
          <ReviewTable api={api} canEdit={canEdit} language={info.code} onChange={refresh} />
        </div>
      )}
    </Card>
  );
}
