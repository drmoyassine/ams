// The IQF and external standards in the institution's secondary language (TASK-071), on the version page:
//   - VersionTranslations: loads the version's translations once and hands them to whatever shows requirement text;
//   - ContentSwitcher: English | secondary language (useContentLanguage); the translation is shown where there is one and
//     English is the fallback; the English is never replaced in storage, and a standard's translation is labelled
//     "Unofficial translation" wherever it appears (DEC-028);
//   - TranslationBar: the switcher, the note, how much is translated, the Translate action with progress / cancel / resume,
//     and the review dialog (filters, edit, mark reviewed, mark all, re-translate out-of-date).
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACTIVE_TRANSLATION_STATUSES, RESUMABLE_TRANSLATION_STATUSES, contentTranslationKey, directionOf, languageInfo,
  type ContentTranslationEntry, type ContentTranslationField, type ContentTranslationKind, type ContentTranslationRow, type TranslationRun,
} from '@ams/shared';
import { Dialog } from '../../components/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useTranslation } from '../../i18n';
import type { FrameworkApi, Version } from '../../lib/framework-api';
import { useContentLanguage } from '../../lib/content-language';
import { formatNumber } from '../../lib/intl';
import { can, useMe } from '../../lib/me';
import { useAction } from '../../lib/use-action';

interface TranslationsValue {
  /** The secondary language, or null when the institution has none (then nothing here shows). */
  language: string | null;
  kind: ContentTranslationKind;
  /** The person chose the secondary language in the switcher. */
  showing: boolean;
  entry: (entityId: string, field: ContentTranslationField) => ContentTranslationEntry | null;
}
const NONE: TranslationsValue = { language: null, kind: 'standard', showing: false, entry: () => null };
const Context = createContext<TranslationsValue>(NONE);
export const useVersionTranslations = () => useContext(Context);

/** Loads the translations of a version and shares them with the cards and rows below. */
export function VersionTranslations({ api, version, children }: { api: FrameworkApi; version: Version; children: ReactNode }) {
  const me = useMe(api);
  const language = me.data?.language?.secondaryLanguage ?? null;
  const { mode } = useContentLanguage();
  const map = useQuery({
    queryKey: ['content-translations', version.id, 'map'], queryFn: () => api.contentTranslationMap(version.id), enabled: !!language, staleTime: 30_000,
  });
  const value = useMemo<TranslationsValue>(() => {
    const byKey = new Map((map.data?.entries ?? []).map((e) => [contentTranslationKey(e.entityId, e.field), e]));
    return { language, kind: version.internal ? 'iqf' : 'standard', showing: !!language && mode === 'secondary', entry: (id, field) => byKey.get(contentTranslationKey(id, field)) ?? null };
  }, [language, mode, map.data, version.internal]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The text to show for a title or similar in a list: the translation when the secondary language is chosen and there is one, else the English. */
export function useShownText(entityId: string, field: ContentTranslationField, english: string): string {
  const { showing, entry } = useVersionTranslations();
  const e = showing ? entry(entityId, field) : null;
  return e ? e.text : english;
}

function stateLabel(t: (k: string) => string, e: Pick<ContentTranslationEntry, 'origin' | 'reviewed'>): string {
  if (e.origin === 'person') return t('ct.label.person');
  return e.reviewed ? t('ct.label.reviewed') : t('ct.label.ai');
}

/**
 * The translation of one text, shown beside the English, with its label: "Unofficial translation" for an external standard, then
 * how far it has been reviewed, and "Out of date" when the English has changed. Nothing when the English view is chosen; the
 * fallback sentence when there is no translation yet.
 */
export function TranslationBlock({ entityId, field, className = '' }: { entityId: string; field: ContentTranslationField; className?: string }) {
  const { t } = useTranslation();
  const { language, kind, showing, entry } = useVersionTranslations();
  if (!showing || !language) return null;
  const e = entry(entityId, field);
  if (!e) return <p className={`text-xs text-muted-foreground ${className}`} data-testid="translation-missing">{t('ct.fallback')}</p>;
  const chip = 'rounded border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground';
  return (
    <div className={`space-y-1 rounded-md border border-dashed border-border p-2 ${className}`} data-testid="content-translation">
      <div className="flex flex-wrap items-center gap-1">
        {kind === 'standard' && <span className={`${chip} font-medium text-foreground`} data-testid="unofficial-label">{t('ct.label.unofficial')}</span>}
        <span className={chip}>{stateLabel(t, e)}</span>
        {e.stale && <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900">{t('ct.label.stale')}</span>}
      </div>
      <p className="whitespace-pre-line text-sm" dir="auto" lang={language}>{e.text}</p>
    </div>
  );
}

/** English | the secondary language. Shown only when the institution has a secondary language. */
export function ContentSwitcher({ language }: { language: string }) {
  const { t } = useTranslation();
  const { mode, setMode } = useContentLanguage();
  const info = languageInfo(language);
  const on = mode === 'secondary';
  const cls = (active: boolean) => `px-3 py-1 text-sm ${active ? 'bg-primary text-primary-foreground' : 'bg-background text-foreground'}`;
  return (
    <div role="group" aria-label={t('ct.switch.label')} className="inline-flex overflow-hidden rounded-md border border-border">
      <button type="button" aria-pressed={!on} className={cls(!on)} onClick={() => setMode('en')}>{t('ct.switch.en')}</button>
      <button type="button" aria-pressed={on} lang={language} dir={directionOf(language)} className={cls(on)} onClick={() => setMode('secondary')}>{info?.nativeName ?? language}</button>
    </div>
  );
}

// ---- Review dialog ------------------------------------------------------------------------------------------------------------

type Filter = 'all' | 'missing' | 'needs_review' | 'reviewed' | 'stale';
const PAGE = 25;
const selectCls = 'rounded-md border border-border bg-background px-2 py-1 text-sm';

function ReviewRow({ row, api, versionId, canWrite, language, onChange }: { row: ContentTranslationRow; api: FrameworkApi; versionId: string; canWrite: boolean; language: string; onChange: () => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(row.text ?? '');
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const dir = directionOf(language);
  const state = row.text === null ? t('languages.review.none') : stateLabel(t, { origin: row.origin ?? 'ai', reviewed: row.reviewed });
  const field = t(`ct.field.${row.field}`);
  return (
    <tr className="border-b border-border align-top" data-testid="review-row">
      <td className="px-2 py-1 text-xs" dir="auto"><span className="font-mono">{row.code}</span><br /><span className="text-muted-foreground">{field}</span></td>
      <td className="px-2 py-1 whitespace-pre-line" dir="auto">{row.english}</td>
      <td className="px-2 py-1 whitespace-pre-line" dir={dir} lang={language}>
        {editing ? (
          <div className="space-y-1">
            <textarea aria-label={t('ct.review.editLabel', { code: row.code, field })} dir={dir} rows={3} value={text} onChange={(e) => setText(e.target.value)} className="w-full rounded-md border border-border bg-background p-1 text-sm" />
            <div className="flex gap-2">
              <Button type="button" disabled={!text.trim()} onClick={() => void act(() => api.saveContentTranslation(versionId, { entityId: row.entityId, field: row.field, text })).then((r) => { if (r) { setEditing(false); onChange(); } })}>{t('common.save')}</Button>
              <Button type="button" variant="ghost" onClick={() => { setEditing(false); setText(row.text ?? ''); setError(null); }}>{t('common.cancel')}</Button>
            </div>
            {error && <p role="alert" className="text-xs text-red-700" dir="ltr">{error}</p>}
          </div>
        ) : (row.text ?? <span className="text-muted-foreground">—</span>)}
      </td>
      <td className="px-2 py-1 text-xs text-muted-foreground">
        {state}{row.stale && <span className="ms-1 rounded bg-amber-50 px-1 text-amber-900">{t('ct.label.stale')}</span>}
      </td>
      <td className="px-2 py-1">
        {canWrite && !editing && (
          <div className="flex flex-wrap gap-1">
            <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => { setText(row.text ?? row.english); setEditing(true); }}>{t('languages.review.edit')}</Button>
            {row.text !== null && !row.reviewed && (
              <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => void act(() => api.markContentReviewed(versionId, [{ entityId: row.entityId, field: row.field }])).then(onChange)}>{t('languages.review.markReviewed')}</Button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function ReviewDialog({ api, version, language, kind, canWrite, staleCount, canRetranslate, onRetranslate, onChange, onClose }: {
  api: FrameworkApi; version: Version; language: string; kind: ContentTranslationKind; canWrite: boolean; staleCount: number; canRetranslate: boolean;
  onRetranslate: () => void; onChange: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['content-translations', version.id, 'items', filter, q, limit], queryFn: () => api.contentTranslationItems(version.id, { filter, q, limit }), placeholderData: (p) => p });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['content-translations', version.id] }); onChange(); };
  const languageName = languageInfo(language)?.nameEn ?? language;
  return (
    <Dialog labelledBy="content-review-title" onClose={onClose} size="lg">
      <h2 id="content-review-title" className="mb-1 min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">{t('ct.review.title', { language: languageName })}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('ct.review.intro')}{kind === 'standard' && <> {t('ct.label.unofficial')}.</>}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">{t('languages.review.filter')}
          <select aria-label={t('languages.review.filter')} className={selectCls} value={filter} onChange={(e) => { setFilter(e.target.value as Filter); setLimit(PAGE); }}>
            <option value="all">{t('languages.review.all')}</option>
            <option value="missing">{t('languages.review.missing')}</option>
            <option value="needs_review">{t('languages.review.needs')}</option>
            <option value="reviewed">{t('languages.review.reviewed')}</option>
            <option value="stale">{t('languages.review.stale')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">{t('common.search')}
          <Input aria-label={t('languages.review.search')} value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} className="w-48" />
        </label>
        {canWrite && <Button type="button" variant="outline" onClick={() => void act(() => api.markContentReviewed(version.id)).then(refresh)}>{t('languages.review.markAll')}</Button>}
        {canRetranslate && staleCount > 0 && <Button type="button" variant="outline" onClick={onRetranslate}>{t('ct.retranslateStale')}</Button>}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      <div className="mt-3 overflow-x-auto" data-testid="content-review-table">
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <thead className="bg-muted">
            <tr>{[t('ct.review.code'), t('languages.review.english'), t('languages.review.translation'), t('languages.review.state'), t('languages.review.actions')].map((c) => <th key={c} scope="col" className="px-2 py-1 text-start font-medium">{c}</th>)}</tr>
          </thead>
          <tbody>
            {(list.data?.rows ?? []).map((r) => <ReviewRow key={`${r.entityId}:${r.field}:${r.text}:${r.reviewed}`} row={r} api={api} versionId={version.id} canWrite={canWrite} language={language} onChange={refresh} />)}
          </tbody>
        </table>
      </div>
      {list.data && list.data.rows.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t('languages.review.empty')}</p>}
      {list.data && list.data.total > limit && <Button type="button" variant="outline" className="mt-2" onClick={() => setLimit(limit + PAGE)}>{t('languages.review.more')}</Button>}
      <div className="mt-4 flex justify-end"><Button type="button" variant="ghost" onClick={onClose}>{t('common.close')}</Button></div>
    </Dialog>
  );
}

// ---- The bar ------------------------------------------------------------------------------------------------------------------

function RunLine({ run, canWrite, onCancel, onResume }: { run: TranslationRun; canWrite: boolean; onCancel: () => void; onResume: () => void }) {
  const { t } = useTranslation();
  const status = {
    queued: t('languages.run.status.queued'), running: t('languages.run.status.running'), succeeded: t('languages.run.status.succeeded'),
    failed: t('languages.run.status.failed'), cancelled: t('languages.run.status.cancelled'), stopped: t('languages.run.status.stopped'),
  }[run.status];
  const active = (ACTIVE_TRANSLATION_STATUSES as readonly string[]).includes(run.status);
  const resumable = (RESUMABLE_TRANSLATION_STATUSES as readonly string[]).includes(run.status);
  const pct = run.progress.total > 0 ? Math.round((run.progress.done / run.progress.total) * 100) : 0;
  return (
    <div className="space-y-1 text-sm" data-testid="translation-run">
      <p><span data-testid="run-status">{status}</span>: {t('languages.run.progress', { done: formatNumber(run.progress.done), total: formatNumber(run.progress.total), flagged: formatNumber(run.progress.flagged) })}</p>
      {active && <progress className="block h-2 w-full max-w-xs" max={100} value={pct} aria-label={status} />}
      {run.error && !active && <p role="status" className="text-muted-foreground" dir="auto">{run.error}</p>}
      {canWrite && (active || resumable) && (
        <div className="flex gap-2">
          {active && <Button type="button" variant="outline" onClick={onCancel}>{t('languages.cancelRun')}</Button>}
          {resumable && <Button type="button" variant="outline" onClick={onResume}>{t('languages.resumeRun')}</Button>}
        </div>
      )}
    </div>
  );
}

/** Above a version's requirements: the content switcher, the label note, the counts and the Translate / Review actions. */
export function TranslationBar({ api, version }: { api: FrameworkApi; version: Version }) {
  const { t } = useTranslation();
  const me = useMe(api);
  const qc = useQueryClient();
  const { mode } = useContentLanguage();
  const language = me.data?.language?.secondaryLanguage ?? null;
  const canWrite = can(me.data, 'framework:write');
  const [reviewing, setReviewing] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const status = useQuery({
    queryKey: ['content-translations', version.id, 'status'], queryFn: () => api.contentTranslationStatus(version.id), enabled: !!language,
    // While a run is going, look again every two seconds; the map follows when it ends.
    refetchInterval: (q) => ((ACTIVE_TRANSLATION_STATUSES as readonly string[]).includes(q.state.data?.run?.status ?? '') ? 2000 : false),
  });
  const run = status.data?.run ?? null;
  const progressKey = `${run?.id}:${run?.status}:${run?.progress.done}`;
  // The translations shown on the cards follow the run: refetched whenever it makes progress or ends.
  useEffect(() => { void qc.invalidateQueries({ queryKey: ['content-translations', version.id, 'map'] }); }, [qc, version.id, progressKey]);
  if (!language) return null;
  const s = status.data;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['content-translations', version.id] }); };
  const running = !!run && (ACTIVE_TRANSLATION_STATUSES as readonly string[]).includes(run.status);
  const languageName = languageInfo(language)?.nameEn ?? language;
  const kind: ContentTranslationKind = version.internal ? 'iqf' : 'standard';
  const start = (retranslateStale: boolean) => void act(() => api.startContentTranslation(version.id, retranslateStale)).then(refresh);
  const canTranslate = canWrite && !running && s?.readiness?.ok === true;
  return (
    <section aria-label={t('ct.panel.title', { language: languageName })} className="space-y-2 rounded-md border border-border p-3" data-testid="translation-bar">
      <div className="flex flex-wrap items-center gap-3">
        <ContentSwitcher language={language} />
        <Button type="button" variant="outline" onClick={() => setReviewing(true)}>{t('ct.review.open')}</Button>
        {mode === 'secondary' && <p className="min-w-0 flex-1 text-xs text-muted-foreground" data-testid="content-note">{kind === 'standard' ? t('ct.note.standard') : t('ct.note.iqf')}</p>}
      </div>
      {s && (
        <div className="space-y-1 text-sm">
          <p data-testid="content-counts">{t('ct.panel.title', { language: languageName })}: {t('ct.panel.counts', { translated: formatNumber(s.translated), total: formatNumber(s.total), reviewed: formatNumber(s.reviewed) })}
            {s.stale > 0 && <> · <span className="text-amber-900">{t('ct.panel.stale', { count: formatNumber(s.stale) })}</span></>}
          </p>
          {version.status !== 'draft' && version.status !== 'in_review' && <p className="text-xs text-muted-foreground">{t('ct.panel.published')}</p>}
          {canWrite && (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" disabled={!canTranslate || s.total === 0} onClick={() => start(stale)}>{t('ct.translate')}</Button>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stale} onChange={(e) => setStale(e.target.checked)} />{t('ct.translateStale')}</label>
              {s.readiness && !s.readiness.ok && <span role="status" className="text-sm text-muted-foreground">{t('ct.notReady', { reason: s.readiness.reason ?? '' })}</span>}
            </div>
          )}
          {run && <RunLine run={run} canWrite={canWrite} onCancel={() => void act(() => api.cancelContentTranslation(version.id, run.id)).then(refresh)} onResume={() => void act(() => api.resumeContentTranslation(version.id, run.id)).then(refresh)} />}
        </div>
      )}
      {status.isError && <p role="alert" className="text-sm text-red-700">{t('ct.loadFailed')}</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {reviewing && (
        <ReviewDialog api={api} version={version} language={language} kind={kind} canWrite={canWrite} staleCount={s?.stale ?? 0} canRetranslate={canTranslate} onRetranslate={() => start(true)} onChange={refresh} onClose={() => setReviewing(false)} />
      )}
    </section>
  );
}
