import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import { authClient } from '../lib/auth';

export function AppLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const nav = [
    { to: '/', label: t('nav.programs') },
    { to: '/standards', label: t('nav.frameworks', 'Standards') },
    { to: '/engagements', label: t('nav.engagements') },
    { to: '/evidence', label: t('nav.evidence') },
  ] as const;
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-e border-border bg-muted p-4">
        <p className="mb-6 text-lg font-semibold">{t('appName')}</p>
        <nav className="flex flex-col gap-1" aria-label="Main">
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className="rounded-md px-3 py-2 text-sm hover:bg-background [&.active]:bg-background [&.active]:font-medium">
              {n.label}
            </Link>
          ))}
        </nav>
        <Button
          variant="ghost" className="mt-6 w-full justify-start"
          onClick={async () => { await authClient.signOut(); await navigate({ to: '/login' }); }}
        >
          {t('signOut')}
        </Button>
      </aside>
      <main className="flex-1 p-8"><Outlet /></main>
    </div>
  );
}

export function ComingSoon({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <section>
      <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
      <p className="text-muted-foreground">{t('soon')}</p>
    </section>
  );
}
