import { Link, Outlet } from '@tanstack/react-router';

const ITEMS = [
  { to: '/settings/organization', label: 'Organization', hint: 'Names, branding and org chart' },
  { to: '/settings/programs', label: 'Programs', hint: 'Add and edit programs' },
] as const;
const COMING = [
  { label: 'Quality framework', hint: 'The institution\'s own standards' },
  { label: 'Glossary', hint: 'Internal terms and their external names' },
] as const;

/** Settings: its own sub-menu beside the page. Items still to come are listed, not linked. */
export function SettingsLayout() {
  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold">Settings</h1>
      <div className="flex flex-col gap-6 md:flex-row">
        <nav aria-label="Settings" className="flex shrink-0 flex-col gap-1 md:w-56">
          {ITEMS.map((i) => (
            <Link key={i.to} to={i.to} title={i.hint} className="rounded-md px-3 py-2 text-sm hover:bg-muted [&.active]:bg-muted [&.active]:font-medium">{i.label}</Link>
          ))}
          {COMING.map((i) => (
            <span key={i.label} title={i.hint} aria-disabled="true" className="rounded-md px-3 py-2 text-sm text-muted-foreground">{i.label} <span className="text-xs">· coming soon</span></span>
          ))}
        </nav>
        <div className="min-w-0 flex-1"><Outlet /></div>
      </div>
    </section>
  );
}
