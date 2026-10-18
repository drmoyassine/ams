import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ContentText } from './content-text';

/** A small shaded label, e.g. "Standard 1.1" or "Description". */
export const Shaded = ({ children }: { children: string }) => <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{children}</span>;

/** Calls `onClose` on Escape. */
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

/** The ⋯ menu of an accordion card; renders nothing when there are no actions. */
export function ActionsMenu({ label, items }: { label: string; items: { label: string; onSelect: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', key); };
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
        className="rounded px-2 py-1 text-lg leading-none text-muted-foreground hover:bg-muted">⋯</button>
      {open && (
        <div role="menu" aria-label={label} className="absolute end-0 z-20 mt-1 min-w-44 rounded-md border border-border bg-background py-1 shadow-lg">
          {items.map((i) => (
            <button key={i.label} type="button" role="menuitem" className="block w-full px-3 py-1.5 text-start text-sm hover:bg-muted" onClick={() => { setOpen(false); i.onSelect(); }}>{i.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One standard, requirement or sub-item as a full-width closable card: a shaded tag, the title, a ⋯ menu, and a body that
 * opens below. Hovering the closed card (after a short delay), or moving the keyboard focus to it, shows `hover` in a tooltip. Used by the internal and the
 * external requirement lists so they look and behave the same.
 */
export function AccordionCard({ label, gutter, toggleProps, lead, tag, title, strong, subtitle, meta, trailing, open, onToggle, menuLabel, menu, hover, testId, domId, tone = 'plain', children }: {
  label: string; /** Controls left of the header's button (a checkbox, a drag handle), outside it so they are not buttons inside a button. */ gutter?: ReactNode;
  /** Extra attributes for the header's toggle button (the tree's keyboard stop). */ toggleProps?: Record<string, string | number | undefined>;
  /** Shown before the tag, e.g. a logo. */ lead?: ReactNode; tag?: string; title?: string | null; strong?: boolean; /** Small text under the title. */ subtitle?: ReactNode; meta?: ReactNode; /** Beside the menu, outside the toggle, e.g. an Open button. */ trailing?: ReactNode; open: boolean; onToggle: () => void;
  menuLabel: string; menu: { label: string; onSelect: () => void }[]; hover?: ReactNode; testId?: string; /** The section's DOM id, for links that scroll to it. */ domId?: string; tone?: 'plain' | 'shaded'; children?: ReactNode;
}) {
  const [hovering, setHovering] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Focus from a click is not a request for the card (the click opens the card); focus from the keyboard, or from code, is.
  const pointer = useRef(false);
  return (
    <section aria-label={label} id={domId} className={`@container scroll-mt-4 rounded-lg border border-border ${tone === 'shaded' ? 'bg-muted/30' : 'bg-background'}`} data-testid={testId}>
      {/*
        Laid out by the card's own width (a container query), so it also works in narrow columns on wide screens. Below
        36rem the title gets a full line (after the tag, if any, which shares the first line with the chevron and the ⋯
        menu) and `meta` wraps onto a line under it; from 36rem up everything sits in one row. Callers may still hide
        `meta` on phones themselves.
      */}
      <div className="relative flex items-start gap-2 pe-2 @xl:items-center"
        onMouseEnter={() => { timer.current = setTimeout(() => setHovering(true), 400); }}
        onMouseLeave={() => { clearTimeout(timer.current); setHovering(false); }}>
        {gutter && <div className="flex h-12 shrink-0 items-center @xl:h-auto">{gutter}</div>}
        <button type="button" aria-expanded={open} onClick={onToggle} {...toggleProps}
          onMouseDown={() => { pointer.current = true; }} onFocus={() => { if (!pointer.current) setHovering(true); pointer.current = false; }} onBlur={() => setHovering(false)} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 px-3 py-3 text-start @xl:flex-nowrap @xl:px-4">
          {lead}
          {tag && <Shaded>{tag}</Shaded>}
          {/* With a tag, narrow cards put the tag (and chevron) on the first line and give the title a full line of its own. */}
          <span className={`min-w-0 flex-1 break-words [overflow-wrap:anywhere] ${tag ? '@max-xl:order-1 @max-xl:mt-1 @max-xl:basis-full' : ''}`}>
            <span className={`block ${strong ? 'font-semibold' : ''}`}>{title ? <ContentText>{title}</ContentText> : null}</span>
            {subtitle && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{subtitle}</span>}
          </span>
          {meta && (
            <span className="order-2 flex min-w-0 basis-full flex-wrap items-center gap-2 @max-xl:mt-1.5 @max-xl:has-[>.hidden:only-child]:mt-0 @xl:order-none @xl:shrink-0 @xl:basis-auto">
              {meta}
            </span>
          )}
          <span aria-hidden="true" className={`text-muted-foreground transition-transform ${tag ? '@max-xl:ms-auto' : ''} ${open ? 'rotate-90' : ''}`}>›</span>
        </button>
        {/* In narrow cards these stay level with the first row of the header. */}
        <div className="flex h-12 shrink-0 items-center gap-2 empty:hidden @xl:h-auto">
          {trailing}
          <ActionsMenu label={menuLabel} items={menu} />
        </div>
        {hovering && !open && hover}
      </div>
      {open && <div className="space-y-4 border-t border-border px-4 py-4">{children}</div>}
    </section>
  );
}

/** The tooltip body of a closed card. */
export function HoverCard({ children }: { children: ReactNode }) {
  return <div role="tooltip" className="pointer-events-none absolute start-4 top-full z-30 mt-1 w-[min(32rem,calc(100vw-4rem))] rounded-md [@media(hover:none)]:hidden border border-border bg-background p-3 text-sm shadow-lg">{children}</div>;
}
