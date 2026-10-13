import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { isReadableAccent, type PublicBranding } from '@ams/shared';
import { useTranslation } from 'react-i18next';
import { InstitutionMark } from '../components/institution-mark';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { authClient } from '../lib/auth';
import { defaultSettingsApi } from '../lib/settings-api';

/**
 * The sign-in page. Before anyone is authenticated it may show the institution's display name, accent colour and logo
 * (the one public read, `/api/public/branding`); if that is not available the plain page is shown.
 */
export function LoginPage({ signIn = authClient.signIn.email, branding: loadBranding = () => defaultSettingsApi.publicBranding() }: {
  signIn?: typeof authClient.signIn.email; branding?: () => Promise<PublicBranding>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [branding, setBranding] = useState<PublicBranding | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(loadBranding).then((b) => { if (live) setBranding(b); }).catch(() => undefined);
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
      </Card>
    </main>
  );
}
