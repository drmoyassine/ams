import { useEffect, useRef } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';

const ITEMS = [
  { to: '/settings/organization', label: 'Organization', hint: 'Names, branding and org chart' },
  { to: '/settings/programs', label: 'Programs', hint: 'Add and edit programs' },
  { to: '/settings/quality-framework', label: 'Internal Quality Framework', hint: 'The institution\'s own standards and terms' },
  { to: '/settings/external-standards', label: 'External Standards', hint: 'Accreditors\' standards: add, import, edit and publish' },
] as const;
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

/** Settings: its own sub-menu beside the page. Items still to come are listed, not linked. */
export function SettingsLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const nav = useRef<HTMLElement>(null);
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
          {ITEMS.map((i) => (
            <Link key={i.to} to={i.to} title={i.hint} className={item}>{i.label}</Link>
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
