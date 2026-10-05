import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { authClient } from '../lib/auth';

export function LoginPage({ signIn = authClient.signIn.email }: { signIn?: typeof authClient.signIn.email }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

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
