import { useCallback, useEffect, useRef, useState } from 'react';
import { SyllabusAlertBar } from '../components/syllabus/syllabus-alert-bar';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Award, BarChart3, FolderOpen, Inbox, LogOut, MailQuestion, PanelLeftClose, PanelLeftOpen, Settings as SettingsIcon, ShieldCheck, type LucideIcon } from 'lucide-react';
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
import { useMyNotifications, useMyRuns, useMyWork } from './cycles/my-work';

const navLink = 'rounded-md px-3 py-2 text-sm hover:bg-background [&.active]:bg-background [&.active]:font-medium';
/** A navigation entry with its icon. Collapsed, only the icon shows and the label is a tooltip on hover and focus (and the accessible name). */
function NavLabel({ icon: Icon, label, collapsed }: { icon: LucideIcon; label: string; collapsed: boolean }) {
  return (
    <>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span className={collapsed ? 'sr-only' : 'min-w-0'}>{label}</span>
      {collapsed && <span role="tooltip" aria-hidden="true" className="pointer-events-none absolute start-full top-1/2 z-50 ms-2 hidden -translate-y-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background shadow group-hover:block group-focus-visible:block">{label}</span>}
    </>
  );
}
const itemClass = (collapsed: boolean) => `group relative flex items-center gap-2 ${navLink} ${collapsed ? 'justify-center px-0' : ''}`;
const NAV_KEY = 'ams.navCollapsed';
const storedCollapsed = () => { try { return localStorage.getItem(NAV_KEY) === '1'; } catch { return false; } };

/** "My requests (N)", only while someone has asked the signed-in person for evidence and it is still open. */
export function MyRequestsLink({ api: override, enabled, collapsed = false }: { api?: EvidenceApi; enabled: boolean; collapsed?: boolean }) {
  const { t } = useTranslation();
  const api = useEvidenceApi(override);
  const mine = useQuery({ queryKey: ['evidence-requests', 'mine'], queryFn: () => api.requests(true), enabled, staleTime: 30_000 });
  const open = (mine.data ?? []).filter((r) => r.status === 'open').length;
  if (!enabled || open === 0) return null;
  return <Link to="/requests" className={itemClass(collapsed)}><NavLabel icon={MailQuestion} label={t('nav.myRequests', { count: open })} collapsed={collapsed} /></Link>;
}

/** "My work (N)": the stages I own, the approvals waiting for me in running cycles, the runs due of plans I own, the evidence runs I owe and my unread notifications; shown only while there are some. */
export function MyWorkLink({ enabled, notify = false, api, evidence, collapsed = false }: { enabled: boolean; notify?: boolean; api?: CyclesApi; evidence?: EvidenceApi; collapsed?: boolean }) {
  const { t } = useTranslation();
  const mine = useMyWork(api ? { cycles: api } : {}, enabled);
  const notes = useMyNotifications(evidence ? { evidence } : {}, notify);
  // A notice about a run that is still open is not counted twice: the run itself is.
  const unread = (notes.data ?? []).filter((n) => !n.readAt && !(n.run && (n.run.status === 'pending' || n.run.status === 'late'))).length;
  const runs = useMyRuns(evidence ? { evidence } : {}, notify);
  const count = (mine.data?.stages.length ?? 0) + (mine.data?.approvals.length ?? 0) + (mine.data?.dueRuns?.length ?? 0) + unread + (runs.data?.length ?? 0);
  if ((!enabled && !notify) || count === 0) return null;
  return <Link to="/quality-management/legacy" search={{ tab: 'my-work' }} className={itemClass(collapsed)}><NavLabel icon={Inbox} label={t('nav.myWork', { count })} collapsed={collapsed} /></Link>;
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
    { to: '/quality-management', label: t('nav.quality'), icon: ShieldCheck },
    { to: '/engagements', label: t('nav.engagements'), icon: Award },
    { to: '/evidence', label: t('nav.evidence'), icon: FolderOpen },
    // Reports draw on the values of evidence (KPIs): a page of their own, listed right after Evidence.
    { to: '/reports', label: t('nav.reports'), icon: BarChart3 },
  ] as const;
  // The sidebar collapsed to icons: the person's own preference (saved on them, so it follows them across sessions and devices), kept
  // on this device too so the first paint does not jump before it has loaded.
  const qc = useQueryClient();
  const [ownCollapsed, setOwnCollapsed] = useState<boolean | null>(null);
  const collapsed = ownCollapsed ?? me.data?.language?.navCollapsed ?? storedCollapsed();
  const toggleCollapsed = () => {
    const next = !collapsed;
    setOwnCollapsed(next);
    try { localStorage.setItem(NAV_KEY, next ? '1' : '0'); } catch { /* the device keeps nothing; the account still does */ }
    void api.updateMyPreferences({ navCollapsed: next }).then(() => qc.invalidateQueries({ queryKey: ['me'] })).catch(() => undefined);
  };
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

  /** The navigation itself: the same in the sidebar and in the drawer (rendered in one of them at a time; the drawer is never collapsed). */
  const linksOf = (folded: boolean) => (
    <>
      <nav className="flex flex-col gap-1" aria-label={t('nav.main')}>
        {nav.map((n) => (
          <Link key={n.to} to={n.to} className={itemClass(folded)}><NavLabel icon={n.icon} label={n.label} collapsed={folded} /></Link>
        ))}
        <MyWorkLink collapsed={folded} enabled={can(me.data, 'cycle:read')} notify={can(me.data, 'evidence:read')} {...(evidence ? { evidence } : {})} {...(cycles ? { api: cycles } : {})} />
        <MyRequestsLink collapsed={folded} api={evidence} enabled={can(me.data, 'evidence:read')} />
      </nav>
      {canSettings && (
        <Link to="/settings" className={`mt-6 ${itemClass(folded)}`}><NavLabel icon={SettingsIcon} label={t('nav.settings')} collapsed={folded} /></Link>
      )}
      <Button
        variant="ghost" className={`${canSettings ? 'mt-1' : 'mt-6'} group relative w-full ${folded ? 'justify-center px-0' : 'justify-start gap-2 px-3'}`}
        onClick={async () => { close(); await authClient.signOut(); await navigate({ to: '/login' }); }}
      >
        <NavLabel icon={LogOut} label={t('signOut')} collapsed={folded} />
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
      <aside className={`print:hidden hidden shrink-0 border-e border-border bg-muted lg:block ${collapsed ? 'w-16 p-2' : 'w-56 p-4'}`} data-collapsed={collapsed ? 'true' : 'false'}>
        <div className={`mb-3 flex items-start gap-1 ${collapsed ? 'flex-col items-center' : ''}`}>
          {!collapsed && <p className="min-w-0 flex-1 break-words text-sm text-muted-foreground" data-testid="institution-name">{institutionName && <InstitutionMark name={institutionName} logoUrl={logoUrl} />}</p>}
          <button type="button" onClick={toggleCollapsed} aria-label={collapsed ? 'Expand the menu' : 'Collapse the menu'} aria-pressed={collapsed} title={collapsed ? 'Expand the menu' : 'Collapse the menu'}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground">
            {collapsed ? <PanelLeftOpen aria-hidden="true" className="size-4 rtl:rotate-180" /> : <PanelLeftClose aria-hidden="true" className="size-4 rtl:rotate-180" />}
          </button>
        </div>
        {!collapsed && <LanguageMenu api={api} className="mb-6" />}
        {!drawer && linksOf(collapsed)}
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
            {linksOf(false)}
          </div>
        </div>
      )}
      <main className="min-w-0 flex-1 print:p-0 p-4 sm:p-6 lg:p-8"><SyllabusAlertBar enabled={can(me.data, 'org:read')} /><Outlet /></main>
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
