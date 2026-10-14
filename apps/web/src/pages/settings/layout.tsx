import { useEffect, useRef } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../i18n';
import { can, useMe } from '../../lib/me';
import { defaultSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { defaultTrashApi, type TrashApi } from '../../lib/trash-api';


/**
 * Below `lg` the items sit in one row that scrolls sideways, the active one underlined like a tab; from `lg` up they
 * are a column beside the page.
 */
const item = [
  'shrink-0 whitespace-nowrap px-3 py-2 text-sm',
  'border-b-2 border-transparent [&.active]:border-primary [&.active]:font-medium',
  'lg:whitespace-normal lg:rounded-md lg:border-b-0 lg:hover:bg-muted lg:[&.active]:bg-muted',
].join(' ');

/**
 * Settings: its own sub-menu beside the page. Everyone who can read the organization sees it and can read every page that
 * holds no secrets; editing controls show only to those who can edit. Trash (editors) and AI (administrators) stay hidden
 * from everyone else. Items still to come are listed, not linked.
 */
export function SettingsLayout({ api = defaultSettingsApi, trashApi = defaultTrashApi }: { api?: SettingsApi; trashApi?: TrashApi } = {}) {
  const { t } = useTranslation();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const nav = useRef<HTMLElement>(null);
  const me = useMe(api);
  const canTrash = can(me.data, 'framework:write');
  const trash = useQuery({ queryKey: ['trash', 'count'], queryFn: () => trashApi.count(), enabled: canTrash, staleTime: 15_000 });
  const items = [
    { to: '/settings/organization', label: t('settings.organization'), hint: t('settings.organization.hint') },
    { to: '/settings/quality-framework', label: t('settings.iqf'), hint: t('settings.iqf.hint') },
    { to: '/settings/external-standards', label: t('settings.external'), hint: t('settings.external.hint') },
    ...(can(me.data, 'org:read') ? [{ to: '/settings/documents', label: 'Documents', hint: 'Every uploaded document you can see, and where it is used' }] : []),
    ...(canTrash ? [{ to: '/settings/trash', label: t('settings.trash'), hint: t('settings.trash.hint') }] : []),
    ...(can(me.data, 'org:read') ? [{ to: '/settings/assistant-memory', label: t('settings.memory'), hint: t('settings.memory.hint') }] : []),
    ...(can(me.data, 'ai:manage') ? [{ to: '/settings/ai', label: t('settings.ai'), hint: t('settings.ai.hint') }] : []),
  ] as const;
  const trashCount = trash.data?.count ?? 0;
  // In the sideways-scrolling row, bring the current item into view.
  useEffect(() => {
    const active = nav.current?.querySelector<HTMLElement>('a.active');
    if (active && nav.current && nav.current.scrollWidth > nav.current.clientWidth && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [path]);
  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold">{t('nav.settings')}</h1>
      <div className="flex flex-col gap-4 lg:flex-row lg:gap-6">
        <nav ref={nav} aria-label={t('nav.settings')} className="-mx-4 flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:w-56 lg:flex-col lg:overflow-visible lg:border-b-0 lg:px-0">
          {items.map((i) => (
            <Link key={i.to} to={i.to} title={i.hint} className={item}>
              {i.label}
              {i.to === '/settings/trash' && trashCount > 0 && <span className="ms-2 rounded-full bg-muted px-2 py-0.5 text-xs" aria-label={t('settings.trash.count', { count: trashCount })}>{trashCount}</span>}
            </Link>
          ))}
        </nav>
        <div className="min-w-0 flex-1"><Outlet /></div>
      </div>
    </section>
  );
}
