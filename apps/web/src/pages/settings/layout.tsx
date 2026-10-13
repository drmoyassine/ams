import { useEffect, useRef } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { can, useMe } from '../../lib/me';
import { defaultSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { defaultTrashApi, type TrashApi } from '../../lib/trash-api';

const ITEMS = [
  { to: '/settings/organization', label: 'Organization', hint: 'Institution details, logo and org chart; programs' },
  { to: '/settings/quality-framework', label: 'Internal Quality Framework', hint: 'The institution\'s own standards and terms' },
  { to: '/settings/external-standards', label: 'External Standards', hint: 'Accreditors\' standards: browse them; add, import, edit and publish if you can edit' },
] as const;
const TRASH_ITEM = { to: '/settings/trash', label: 'Trash', hint: 'Deleted items, kept for 30 days: restore or remove them (editors only)' } as const;
const AI_ITEM = { to: '/settings/ai', label: 'AI', hint: 'Model, key and spend limits for document analysis (administrators only)' } as const;
const MEMORY_ITEM = { to: '/settings/assistant-memory', label: 'Assistant memory', hint: 'What the assistant remembers: yours and the team\'s' } as const;
const COMING = [] as readonly { label: string; hint: string }[];

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
  const path = useRouterState({ select: (s) => s.location.pathname });
  const nav = useRef<HTMLElement>(null);
  const me = useMe(api);
  const canTrash = can(me.data, 'framework:write');
  const trash = useQuery({ queryKey: ['trash', 'count'], queryFn: () => trashApi.count(), enabled: canTrash, staleTime: 15_000 });
  const items = [...ITEMS, ...(canTrash ? [TRASH_ITEM] : []), ...(can(me.data, 'org:read') ? [MEMORY_ITEM] : []), ...(can(me.data, 'ai:manage') ? [AI_ITEM] : [])];
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
      <h1 className="mb-4 text-2xl font-semibold">Settings</h1>
      <div className="flex flex-col gap-4 lg:flex-row lg:gap-6">
        <nav ref={nav} aria-label="Settings" className="-mx-4 flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:w-56 lg:flex-col lg:overflow-visible lg:border-b-0 lg:px-0">
          {items.map((i) => (
            <Link key={i.to} to={i.to} title={i.hint} className={item}>
              {i.label}
              {i.to === '/settings/trash' && trashCount > 0 && <span className="ms-2 rounded-full bg-muted px-2 py-0.5 text-xs" aria-label={`${trashCount} in the Trash`}>{trashCount}</span>}
            </Link>
          ))}
          {COMING.map((i) => (
            <span key={i.label} title={i.hint} aria-disabled="true" className={`${item} text-muted-foreground`}>{i.label} <span className="text-xs">· coming soon</span></span>
          ))}
        </nav>
        <div className="min-w-0 flex-1"><Outlet /></div>
      </div>
    </section>
  );
}
