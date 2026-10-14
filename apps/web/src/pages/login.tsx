import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { directionOf, effectiveLocale, isReadableAccent, languageInfo, PRIMARY_LANGUAGE, type PublicBranding, type PublicI18n } from '@ams/shared';
import { InstitutionMark } from '../components/institution-mark';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { useTranslation } from '../i18n';
import { authClient } from '../lib/auth';
import { activateLocale, readLocaleHint } from '../lib/language';
import { defaultSettingsApi } from '../lib/settings-api';

/**
 * The sign-in page. Before anyone is authenticated it may show the institution's display name, accent colour and logo
 * (the one public read, `/api/public/branding`), and it speaks the institution's default language, or the one this browser
 * used last, from the only strings served without signing in (`/api/public/i18n`: the sign-in page's own text and nothing
 * else). If those are not available the plain English page is shown.
 */
export function LoginPage({ signIn = authClient.signIn.email, branding: loadBranding = () => defaultSettingsApi.publicBranding(), languages: loadLanguages = () => defaultSettingsApi.publicI18n() }: {
  signIn?: typeof authClient.signIn.email; branding?: () => Promise<PublicBranding>; languages?: () => Promise<PublicI18n>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [branding, setBranding] = useState<PublicBranding | null>(null);
  const [languages, setLanguages] = useState<PublicI18n | null>(null);
  const [locale, setLocale] = useState(PRIMARY_LANGUAGE);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(loadBranding).then((b) => { if (live) setBranding(b); }).catch(() => undefined);
    void Promise.resolve().then(loadLanguages).then((p) => {
      if (!live) return;
      setLanguages(p);
      // This browser's last language if still valid, else the institution's default.
      const chosen = effectiveLocale(readLocaleHint(), p.defaultLocale, p.secondaryLanguage);
      setLocale(chosen);
      activateLocale(chosen, p.strings);
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const accent = branding?.accentColor;
  useEffect(() => {
    const root = document.documentElement;
    if (accent && isReadableAccent(accent)) root.style.setProperty('--primary', accent); else root.style.removeProperty('--primary');
    return () => { root.style.removeProperty('--primary'); };
  }, [accent]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(false);
    const res = await signIn({ email: String(form.get('email')), password: String(form.get('password')) });
    setBusy(false);
    if (res.error) setError(true);
    else await navigate({ to: '/' });
  }

  const secondary = languages?.secondaryLanguage ?? null;
  const choose = (code: string) => { setLocale(code); activateLocale(code, languages?.strings); };
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        {branding?.name && (
          <div className="mb-4 flex flex-col items-center gap-2 text-center" data-testid="login-institution">
            <InstitutionMark name={branding.name} logoUrl={branding.logoUrl} imgClassName="max-h-20 max-w-full" textClassName="text-lg font-medium" />
          </div>
        )}
        <h1 className="mb-4 text-xl font-semibold">{t('login.title')}</h1>
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block text-sm">
            {t('login.email')}
            <Input name="email" type="email" autoComplete="username" required />
          </label>
          <label className="block text-sm">
            {t('login.password')}
            <Input name="password" type="password" autoComplete="current-password" required />
          </label>
          {error && <p role="alert" className="text-sm text-red-700">{t('login.failed')}</p>}
          <Button type="submit" disabled={busy} className="w-full">{t('login.submit')}</Button>
        </form>
        {secondary && (
          <div role="group" aria-label={t('language.menu')} className="mt-4 flex justify-center gap-1 text-sm" data-testid="login-language">
            {[{ code: PRIMARY_LANGUAGE, label: 'English' }, { code: secondary, label: languageInfo(secondary)?.nativeName ?? secondary }].map((o) => (
              <button key={o.code} type="button" lang={o.code} dir={directionOf(o.code)} aria-pressed={locale === o.code} onClick={() => choose(o.code)}
                className="min-h-9 rounded-md border border-border px-2.5 py-1 hover:bg-muted aria-pressed:border-primary aria-pressed:font-medium">{o.label}</button>
            ))}
          </div>
        )}
      </Card>
    </main>
  );
}
