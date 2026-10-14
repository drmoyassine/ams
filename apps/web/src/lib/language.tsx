// The interface language (TASK-070). The server decides which language applies to a signed-in person (their own choice, else
// the institution's default, else English: `me.language.effectiveLocale`); this module applies it: it loads the secondary
// language's catalogue, merges it over English (i18next falls back to English for anything missing), and sets <html lang>,
// <html dir> and the script that picks the font stack. The browser remembers only the last language applied, as a hint so the
// first paint has the right direction; the server's answer always overrides it.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { directionOf, languageInfo, scriptOf, PRIMARY_LANGUAGE, type I18nBundle, type Me } from '@ams/shared';
import i18n, { useTranslation } from '../i18n';
import { useMe } from './me';
import type { SettingsApi } from './settings-api';

const HINT_KEY = 'ams.locale';

export function readLocaleHint(): string | null {
  try { return window.localStorage.getItem(HINT_KEY); } catch { return null; }
}
function writeLocaleHint(locale: string) {
  try { window.localStorage.setItem(HINT_KEY, locale); } catch { /* private window or blocked storage: the hint is optional */ }
}

/** <html lang>, <html dir> and the script (font stack) for a language. */
export function applyDocumentLocale(locale: string) {
  const root = document.documentElement;
  root.lang = locale;
  root.dir = directionOf(locale);
  root.dataset.script = scriptOf(locale);
}

let current = PRIMARY_LANGUAGE;

/** Puts a language in force: its strings (if any), then the language itself, then the document attributes. */
export function activateLocale(locale: string, strings?: Record<string, string>) {
  if (locale !== PRIMARY_LANGUAGE && strings) i18n.addResourceBundle(locale, 'translation', strings, true, true);
  current = locale;
  void i18n.changeLanguage(locale);
  applyDocumentLocale(locale);
  writeLocaleHint(locale);
}

/** The locale new Intl formatters should use right now (the interface language, English until one is chosen). */
export const activeLocale = (): string => current;

/**
 * Mounted once in the app layout. Applies the person's effective language; the catalogue is fetched with the browser's HTTP
 * cache in front (ETag), and kept for five minutes.
 */
export function LanguageSync({ api }: { api: Pick<SettingsApi, 'me' | 'i18nBundle'> }) {
  const me = useMe(api);
  const locale = me.data?.language?.effectiveLocale ?? null;
  const bundle = useQuery({
    queryKey: ['i18n-bundle', locale],
    queryFn: (): Promise<I18nBundle | null> => api.i18nBundle(locale!),
    enabled: !!locale && locale !== PRIMARY_LANGUAGE,
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    if (!locale) return;
    activateLocale(locale, bundle.data?.strings);
  }, [locale, bundle.data]);
  return null;
}

/**
 * The language menu in the header: English and the institution's secondary language, by their own names. Shown only when
 * the institution has a secondary language. Choosing applies at once and is saved on the person (PATCH /api/me/preferences);
 * if the save fails the previous language comes back.
 */
export function LanguageMenu({ api, className = '' }: { api: Pick<SettingsApi, 'me' | 'updateMyPreferences'>; className?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe(api);
  const [error, setError] = useState(false);
  const save = useMutation({
    mutationFn: (uiLocale: string) => api.updateMyPreferences({ uiLocale }),
    onMutate: async (uiLocale) => {
      setError(false);
      await qc.cancelQueries({ queryKey: ['me'] });
      const before = qc.getQueryData<Me>(['me']);
      if (before?.language) qc.setQueryData<Me>(['me'], { ...before, language: { ...before.language, uiLocale, effectiveLocale: uiLocale } });
      return { before };
    },
    onError: (_e, _v, ctx) => { setError(true); if (ctx?.before) qc.setQueryData(['me'], ctx.before); },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['me'] }); },
  });
  const lang = me.data?.language;
  if (!lang?.secondaryLanguage) return null;
  const secondary = languageInfo(lang.secondaryLanguage);
  const options = [{ code: PRIMARY_LANGUAGE, label: 'English' }, { code: lang.secondaryLanguage, label: secondary?.nativeName ?? lang.secondaryLanguage }];
  return (
    <div role="group" aria-label={t('language.menu')} className={`inline-flex items-center gap-1 text-sm ${className}`} data-testid="language-menu">
      {options.map((o) => (
        <button
          key={o.code} type="button" lang={o.code} dir={directionOf(o.code)} aria-pressed={lang.effectiveLocale === o.code} disabled={save.isPending}
          onClick={() => { if (lang.effectiveLocale !== o.code) save.mutate(o.code); }}
          className="min-h-9 rounded-md border border-border px-2.5 py-1 hover:bg-background aria-pressed:border-primary aria-pressed:bg-background aria-pressed:font-medium"
        >{o.label}</button>
      ))}
      {error && <span role="alert" className="text-xs text-red-700">{t('language.saveFailed')}</span>}
    </div>
  );
}
