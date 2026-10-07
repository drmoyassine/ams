import { useEffect } from 'react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { isReadableAccent } from '@ams/shared';
import { useTranslation } from 'react-i18next';
import { ContentText } from '../components/content-text';
import { Button } from '../components/ui/button';
import { authClient } from '../lib/auth';
import { can, useMe } from '../lib/me';
import { useSettingsApi, type SettingsApi } from '../lib/settings-api';

/** Settings is for people who can manage something there; the pages themselves also check each action. */
export function AppLayout({ api: override }: { api?: SettingsApi }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const api = useSettingsApi(override);
  const me = useMe(api);
  const institution = useQuery({ queryKey: ['institution'], queryFn: () => api.institution(), staleTime: 60_000 });
  const accent = institution.data?.accentColor;
  // The institution's accent colour themes buttons and highlights (the API only stores colours white text can be read on).
  useEffect(() => {
    const root = document.documentElement;
    if (accent && isReadableAccent(accent)) root.style.setProperty('--primary', accent); else root.style.removeProperty('--primary');
    return () => { root.style.removeProperty('--primary'); };
  }, [accent]);
  const canSettings = can(me.data, 'org:write') || can(me.data, 'program:write') || can(me.data, 'institution:write') || can(me.data, 'framework:write') || can(me.data, 'framework:review');
  const nav = [
    { to: '/engagements', label: t('nav.engagements') },
    { to: '/evidence', label: t('nav.evidence') },
    { to: '/requests', label: t('nav.requests', 'Requests') },
  ] as const;
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-e border-border bg-muted p-4">
        <p className="text-lg font-semibold">{t('appName')}</p>
        <p className="mb-6 text-sm text-muted-foreground" data-testid="institution-name">{institution.data && <ContentText>{institution.data.nameAr && institution.data.defaultLocale === 'ar' ? institution.data.nameAr : institution.data.nameEn}</ContentText>}</p>
        <nav className="flex flex-col gap-1" aria-label="Main">
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className="rounded-md px-3 py-2 text-sm hover:bg-background [&.active]:bg-background [&.active]:font-medium">
              {n.label}
            </Link>
          ))}
        </nav>
        {canSettings && (
          <Link to="/settings" className="mt-6 block rounded-md px-3 py-2 text-sm hover:bg-background [&.active]:bg-background [&.active]:font-medium">{t('nav.settings', 'Settings')}</Link>
        )}
        <Button
          variant="ghost" className={`${canSettings ? 'mt-1' : 'mt-6'} w-full justify-start`}
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
