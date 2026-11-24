import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from 'lucide-react';
import { useMe } from '../lib/me';
import { useSettingsApi, type SettingsApi } from '../lib/settings-api';
import { Breadcrumb } from './breadcrumb';

/**
 * A navigation entry's icon and label. Collapsed, only the icon shows and the label is a tooltip on hover and focus (and stays the
 * accessible name). The item it sits in carries the `group relative` classes.
 */
export function NavLabel({ icon: Icon, iconNode, label, collapsed, badge }: { icon?: LucideIcon; iconNode?: ReactNode; label: ReactNode; collapsed: boolean; badge?: ReactNode }) {
  return (
    <>
      {iconNode ?? (Icon ? <Icon aria-hidden="true" className="size-4 shrink-0" /> : null)}
      <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 break-words'}>{label}</span>
      {badge && <span className={collapsed ? 'absolute end-1 top-0.5' : 'shrink-0'}>{badge}</span>}
      {collapsed && <span role="tooltip" aria-hidden="true" className="pointer-events-none absolute start-full top-1/2 z-50 ms-2 hidden max-w-72 -translate-y-1/2 rounded-md bg-foreground px-2 py-1 text-xs whitespace-nowrap text-background shadow group-hover:block group-focus-visible:block">{label}</span>}
    </>
  );
}

/** Whether the window is at least `lg` wide (the side column); without matchMedia (tests) it is. */
export function useWide(): boolean {
  const query = '(min-width: 64rem)';
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true);
  const [wide, setWide] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const m = window.matchMedia(query);
    const on = (e: MediaQueryListEvent) => setWide(e.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return wide;
}

/**
 * Whether a side panel is collapsed to icons: the person's own choice, saved on them per panel (so it follows them across sessions
 * and devices, independent of the main menu and of the other panels) and kept on this device for the first paint.
 */
export function usePanelCollapsed(key: string, override?: SettingsApi): [boolean, () => void] {
  const api = useSettingsApi(override);
  const me = useMe(api);
  const qc = useQueryClient();
  const local = `ams.panel.${key}`;
  const [own, setOwn] = useState<boolean | null>(null);
  const stored = () => { try { return localStorage.getItem(local) === '1'; } catch { return false; } };
  const collapsed = own ?? me.data?.language?.panelsCollapsed?.[key] ?? stored();
  const toggle = () => {
    const next = !collapsed;
    setOwn(next);
    try { localStorage.setItem(local, next ? '1' : '0'); } catch { /* the device keeps nothing; the account still does */ }
    void api.updateMyPreferences({ panelsCollapsed: { [key]: next } }).then(() => qc.invalidateQueries({ queryKey: ['me'] })).catch(() => undefined);
  };
  return [collapsed, toggle];
}

export type PanelItem = {
  key: string; label: string; hint?: string | undefined; icon?: LucideIcon; iconNode?: ReactNode; badge?: ReactNode; active: boolean;
} & ({ to: string; search?: Record<string, string>; onSelect?: never } | { onSelect: () => void; to?: never; search?: never });

/**
 * A page's own menu beside it (Settings, Quality Management). From `lg` up it is a column flush against the main menu, a shade lighter,
 * that collapses to icons with tooltips; the active item takes the page's colour and runs into the page, the way the main menu's
 * active item runs into this column. Below `lg` the items are one row that scrolls sideways, the active one underlined.
 * `tabs` makes it a vertical tab list (buttons with role="tab") instead of links.
 */
export function SidePanel({ panelKey, title, label, items, tabs = false, breadcrumb, children, api }: {
  panelKey: string; title: string; label: string; items: PanelItem[]; tabs?: boolean;
  breadcrumb?: { label: string; href?: string }[] | undefined; children: ReactNode; api?: SettingsApi;
}) {
  const [collapsed, toggle] = usePanelCollapsed(panelKey, api);
  const wide = useWide();
  const row = useRef<HTMLElement>(null);
  const activeKey = items.find((i) => i.active)?.key;
  // In the sideways-scrolling row, bring the current item into view.
  useEffect(() => {
    const el = row.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (el && row.current && row.current.scrollWidth > row.current.clientWidth && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeKey]);
  const entry = (i: PanelItem, mode: 'column' | 'row') => {
    const column = mode === 'column';
    const cls = column
      ? `group relative flex w-full items-center gap-2 rounded-s-md py-2 text-start text-sm ${collapsed ? 'justify-center px-0' : 'px-3'} ${i.active ? 'bg-background font-medium text-foreground' : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'}`
      : `flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${i.active ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`;
    const inner = column
      ? <NavLabel icon={i.icon} iconNode={i.iconNode} label={i.label} collapsed={collapsed} badge={i.badge} />
      : <>{i.iconNode ?? (i.icon ? <i.icon aria-hidden="true" className="size-4 shrink-0" /> : null)}<span>{i.label}</span>{i.badge}</>;
    const common = { className: cls, 'data-active': i.active ? 'true' : 'false', title: collapsed && column ? undefined : i.hint } as const;
    if (i.onSelect) {
      return <button key={i.key} type="button" {...common} {...(tabs ? { role: 'tab', 'aria-selected': i.active } : { 'aria-current': i.active ? 'page' as const : undefined })} onClick={i.onSelect}>{inner}</button>;
    }
    return <Link key={i.key} to={i.to} {...(i.search ? { search: i.search as never } : {})} {...common} aria-current={i.active ? 'page' : undefined} activeOptions={{ exact: false }}>{inner}</Link>;
  };
  const listProps = tabs ? { role: 'tablist', 'aria-label': label, 'aria-orientation': 'vertical' as const } : {};
  return (
    <div className="lg:flex lg:min-h-[100dvh]" data-panel={panelKey}>
      {wide ? <aside aria-label={label} data-collapsed={collapsed ? 'true' : 'false'}
        className={`print:hidden sticky top-0 flex max-h-[100dvh] shrink-0 flex-col bg-panel py-4 ps-2 shadow-[inset_-1px_0_0_var(--border)] rtl:shadow-[inset_1px_0_0_var(--border)] ${collapsed ? 'w-14 overflow-visible' : 'w-60 overflow-y-auto'}`}>
        <div className={`mb-3 flex items-center gap-1 pe-2 ${collapsed ? 'justify-center' : ''}`}>
          <h1 className={collapsed ? 'sr-only' : 'min-w-0 flex-1 ps-1 text-lg font-semibold'}>{title}</h1>
          <button type="button" onClick={toggle} aria-pressed={collapsed} aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`} title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground">
            {collapsed ? <PanelLeftOpen aria-hidden="true" className="size-4 rtl:rotate-180" /> : <PanelLeftClose aria-hidden="true" className="size-4 rtl:rotate-180" />}
          </button>
        </div>
        <nav aria-label={label} className="flex flex-col gap-0.5" {...listProps}>{items.map((i) => entry(i, 'column'))}</nav>
      </aside> : (
        <div>
          <h1 className="mb-3 text-2xl font-semibold">{title}</h1>
          <nav ref={row} aria-label={label} className="-mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-border px-4 sm:-mx-6 sm:px-6" {...listProps}>{items.map((i) => entry(i, 'row'))}</nav>
        </div>
      )}
      <div className="min-w-0 flex-1 lg:p-8">
        {breadcrumb && breadcrumb.length > 1 && <div className="mb-3"><Breadcrumb items={breadcrumb} /></div>}
        {children}
      </div>
    </div>
  );
}
