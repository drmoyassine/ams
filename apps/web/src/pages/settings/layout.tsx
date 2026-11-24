import { useQuery } from '@tanstack/react-query';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { Brain, Building2, ClipboardCheck, FileText, GraduationCap, KeyRound, Landmark, BookOpen, ListTree, Sparkles, Trash2, type LucideIcon } from 'lucide-react';
import { SidePanel } from '../../components/side-panel';
import { useTranslation } from '../../i18n';
import { can, useApi, useMe } from '../../lib/me';
import { defaultSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { defaultTrashApi, type TrashApi } from '../../lib/trash-api';

/** Detail pages that show their own breadcrumb (they know the name of what they show). */
const OWN_CRUMBS = [/^\/settings\/programs\/[^/]+/, /^\/settings\/courses\/[^/]+/, /^\/settings\/versions\/[^/]+/, /^\/settings\/quality-management\/[^/]+/];

/**
 * Settings: its own side panel beside the page (collapsible to icons, saved per person apart from the main menu). Everyone who can
 * read the organization sees it and can read every page that holds no secrets; editing controls show only to those who can edit.
 * Trash (editors) and AI (administrators) stay hidden from everyone else. Each section page shows Settings › its name; a detail
 * page (a program, a course, a version, a template) shows its own, longer breadcrumb.
 */
export function SettingsLayout({ api = defaultSettingsApi, trashApi = defaultTrashApi }: { api?: SettingsApi; trashApi?: TrashApi } = {}) {
  const { t } = useTranslation();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const me = useMe(api);
  const canTrash = can(me.data, 'framework:write');
  const trash = useQuery({ queryKey: ['trash', 'count'], queryFn: () => trashApi.count(), enabled: canTrash, staleTime: 15_000 });
  const items: { to: string; label: string; hint: string; icon: LucideIcon }[] = [
    { to: '/settings/organization', label: t('settings.organization'), hint: t('settings.organization.hint'), icon: Building2 },
    { to: '/settings/programs', label: t('settings.programs'), hint: t('settings.programs.hint'), icon: GraduationCap },
    { to: '/settings/courses', label: t('settings.courses'), hint: t('settings.courses.hint'), icon: BookOpen },
    { to: '/settings/quality-framework', label: t('settings.iqf'), hint: t('settings.iqf.hint'), icon: ListTree },
    { to: '/settings/external-standards', label: t('settings.external'), hint: t('settings.external.hint'), icon: Landmark },
    ...(can(me.data, 'org:read') ? [{ to: '/settings/quality-management', label: t('settings.qm'), hint: t('settings.qm.hint'), icon: ClipboardCheck }] : []),
    ...(can(me.data, 'org:read') ? [{ to: '/settings/documents', label: 'Documents', hint: 'Every uploaded document you can see, and where it is used', icon: FileText }] : []),
    ...(canTrash ? [{ to: '/settings/trash', label: t('settings.trash'), hint: t('settings.trash.hint'), icon: Trash2 }] : []),
    ...(can(me.data, 'org:read') ? [{ to: '/settings/assistant-memory', label: t('settings.memory'), hint: t('settings.memory.hint'), icon: Brain }] : []),
    ...(can(me.data, 'ai:manage') ? [{ to: '/settings/ai', label: t('settings.ai'), hint: t('settings.ai.hint'), icon: Sparkles }] : []),
    ...(can(me.data, 'institution:write') ? [{ to: '/settings/api-keys', label: t('settings.apiKeys'), hint: t('settings.apiKeys.hint'), icon: KeyRound }] : []),
  ];
  const trashCount = trash.data?.count ?? 0;
  // A version page belongs to the standard it shows: the IQF's or an external standard's.
  const versionId = /^\/settings\/versions\/([^/]+)/.exec(path)?.[1];
  const frameworks = useApi();
  const version = useQuery({ queryKey: ['version', versionId], queryFn: () => frameworks.version(versionId!), enabled: !!versionId, staleTime: 60_000 });
  const activeTo = versionId
    ? (version.data ? (version.data.internal ? '/settings/quality-framework' : '/settings/external-standards') : undefined)
    : items.find((i) => path === i.to || path.startsWith(`${i.to}/`))?.to;
  const current = items.find((i) => i.to === activeTo);
  const crumbs = current && !OWN_CRUMBS.some((r) => r.test(path)) ? [{ label: t('nav.settings'), href: '/settings' }, { label: current.label }] : undefined;
  return (
    <SidePanel panelKey="settings" title={t('nav.settings')} label={t('nav.settings')} api={api} breadcrumb={crumbs}
      items={items.map((i) => ({
        key: i.to, to: i.to, label: i.label, hint: i.hint, icon: i.icon, active: i.to === activeTo,
        ...(i.to === '/settings/trash' && trashCount > 0
          ? { badge: <span className="rounded-full bg-muted px-1.5 text-xs" aria-label={t('settings.trash.count', { count: trashCount })}>{trashCount}</span> } : {}),
      }))}>
      <Outlet />
    </SidePanel>
  );
}
