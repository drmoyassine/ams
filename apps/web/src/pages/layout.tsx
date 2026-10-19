import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { isReadableAccent } from '@ams/shared';
import { AssistantLauncher } from '../components/assistant/launcher';
import { ConfirmHost } from '../components/confirm-dialog';
import { InstitutionMark } from '../components/institution-mark';
import { UndoToaster } from '../components/undo-toaster';
import { Button } from '../components/ui/button';
import { useTranslation } from '../i18n';
import { authClient } from '../lib/auth';
import { LanguageMenu, LanguageSync } from '../lib/language';
import type { AssistantApi } from '../lib/assistant-api';
import type { CyclesApi } from '../lib/cycles-api';
import { useEvidenceApi, type EvidenceApi } from '../lib/evidence-api';
import { can, useMe } from '../lib/me';
import { useSettingsApi, type SettingsApi } from '../lib/settings-api';
import { useMyWork } from './cycles/my-work';

const navLink = 'rounded-md px-3 py-2 text-sm hover:bg-background [&.active]:bg-background [&.active]:font-medium';

/** "My requests (N)", only while someone has asked the signed-in person for evidence and it is still open. */
export function MyRequestsLink({ api: override, enabled }: { api?: EvidenceApi; enabled: boolean }) {
  const { t } = useTranslation();
  const api = useEvidenceApi(override);
  const mine = useQuery({ queryKey: ['evidence-requests', 'mine'], queryFn: () => api.requests(true), enabled, staleTime: 30_000 });
  const open = (mine.data ?? []).filter((r) => r.status === 'open').length;
  if (!enabled || open === 0) return null;
  return <Link to="/requests" className={navLink}>{t('nav.myRequests', { count: open })}</Link>;
}

/** "My work (N)": the stages I own and the approvals waiting for me in running cycles; shown only while there are some. */
export function MyWorkLink({ enabled, api }: { enabled: boolean; api?: CyclesApi }) {
  const { t } = useTranslation();
  const mine = useMyWork(api ? { cycles: api } : {}, enabled);
  const count = (mine.data?.stages.length ?? 0) + (mine.data?.approvals.length ?? 0);
  if (!enabled || count === 0) return null;
  return <Link to="/quality-management" search={{ tab: 'my-work' }} className={navLink}>{t('nav.myWork', { count })}</Link>;
}

/** Focusable elements inside the drawer, for keeping Tab inside it while it is open. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The shell. At `lg` and up the navigation is a sidebar; below it a slim top bar opens the same navigation in a
 * slide-in drawer. Settings is for everyone who can read the organization (the pages are read-only for people who cannot
 * edit, and each action is still checked); the institution's logo, when it has one, stands in for its name.
 */
export function AppLayout({ api: override, evidence, assistant, cycles }: { api?: SettingsApi; evidence?: EvidenceApi; assistant?: AssistantApi; cycles?: CyclesApi }) {
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
  const canSettings = can(me.data, 'org:read');
  const nav = [
    { to: '/quality-management', label: t('nav.quality') },
    { to: '/engagements', label: t('nav.engagements') },
    { to: '/evidence', label: t('nav.evidence') },
  ] as const;
  const inst = institution.data;
  const logoUrl = inst?.logoVersion ? api.institutionLogoUrl(inst.logoVersion) : null;
  // The Arabic name is shown to people using the Arabic interface (the institution's name is kept in English and Arabic only).
  const institutionName = inst ? (inst.nameAr && me.data?.language?.effectiveLocale === 'ar' ? inst.nameAr : inst.nameEn) : null;

  const [drawer, setDrawer] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const close = useCallback(() => setDrawer(false), []);
  useEffect(() => {
    if (!drawer) {
      // Focus goes back to the ☰ button when the drawer closes.
      if (wasOpen.current) { wasOpen.current = false; menuButton.current?.focus(); }
      return undefined;
    }
    wasOpen.current = true;
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setDrawer(false); return; }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0]; const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Widening the window to the sidebar breakpoint closes the drawer.
    const wide = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 64rem)') : null;
    const onWide = (e: MediaQueryListEvent) => { if (e.matches) setDrawer(false); };
    wide?.addEventListener('change', onWide);
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; wide?.removeEventListener('change', onWide); };
  }, [drawer]);

  /** The navigation itself: the same in the sidebar and in the drawer (rendered in one of them at a time). */
  const links = (
    <>
      <nav className="flex flex-col gap-1" aria-label={t('nav.main')}>
        {nav.map((n) => (
          <Link key={n.to} to={n.to} className={navLink}>
            {n.label}
          </Link>
        ))}
        <MyWorkLink enabled={can(me.data, 'cycle:read')} {...(cycles ? { api: cycles } : {})} />
        <MyRequestsLink api={evidence} enabled={can(me.data, 'evidence:read')} />
      </nav>
      {canSettings && (
        <Link to="/settings" className={`mt-6 block ${navLink}`}>{t('nav.settings')}</Link>
      )}
      <Button
        variant="ghost" className={`${canSettings ? 'mt-1' : 'mt-6'} w-full justify-start px-3`}
        onClick={async () => { close(); await authClient.signOut(); await navigate({ to: '/login' }); }}
      >
        {t('signOut')}
      </Button>
    </>
  );
  const iconButton = 'flex size-10 shrink-0 items-center justify-center rounded-md text-xl leading-none hover:bg-background';
  return (
    <div className="min-h-screen lg:flex">
      <LanguageSync api={api} />
      <header className="print:hidden sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-muted px-4 py-1.5 lg:hidden">
        <button
          ref={menuButton} type="button" aria-label={t('nav.openMenu')} aria-expanded={drawer} aria-controls="app-drawer"
          onClick={() => setDrawer(true)} className={`-ms-2 ${iconButton}`}
        ><span aria-hidden="true">☰</span></button>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          {institutionName && <p className="flex min-w-0 items-center text-sm text-muted-foreground"><InstitutionMark name={institutionName} logoUrl={logoUrl} imgClassName="max-h-7 max-w-40" textClassName="truncate" /></p>}
        </div>
        <LanguageMenu api={api} className="shrink-0" />
      </header>
      <aside className="print:hidden hidden w-56 shrink-0 border-e border-border bg-muted p-4 lg:block">
        <p className="mb-3 break-words text-sm text-muted-foreground" data-testid="institution-name">{institutionName && <InstitutionMark name={institutionName} logoUrl={logoUrl} />}</p>
        <LanguageMenu api={api} className="mb-6" />
        {!drawer && links}
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" aria-hidden="true" data-testid="drawer-backdrop" onClick={close} />
          <div
            ref={panel} id="app-drawer" role="dialog" aria-modal="true" aria-label={t('nav.menu')}
            className="drawer-in absolute inset-y-0 start-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-e border-border bg-muted p-4 shadow-xl"
            onClick={(e) => { if ((e.target as Element).closest('a')) close(); }}
          >
            <div className="mb-6 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {institutionName && <p className="break-words text-sm text-muted-foreground"><InstitutionMark name={institutionName} logoUrl={logoUrl} imgClassName="max-h-12 max-w-full" /></p>}
              </div>
              <button type="button" aria-label={t('nav.closeMenu')} onClick={close} className={`-me-2 ${iconButton}`}><span aria-hidden="true">✕</span></button>
            </div>
            {links}
          </div>
        </div>
      )}
      <main className="min-w-0 flex-1 print:p-0 p-4 sm:p-6 lg:p-8"><Outlet /></main>
      <ConfirmHost />
      <UndoToaster />
      {can(me.data, 'org:read') && <AssistantLauncher canManageAi={can(me.data, 'ai:manage')} {...(assistant ? { api: assistant } : {})} />}
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
