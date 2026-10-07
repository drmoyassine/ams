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
 * opens below. Hovering the closed card (after a short delay) shows `hover` in a tooltip. Used by the internal and the
 * external requirement lists so they look and behave the same.
 */
export function AccordionCard({ label, tag, title, strong, meta, open, onToggle, menuLabel, menu, hover, testId, tone = 'plain', children }: {
  label: string; tag: string; title?: string | null; strong?: boolean; meta?: ReactNode; open: boolean; onToggle: () => void;
  menuLabel: string; menu: { label: string; onSelect: () => void }[]; hover?: ReactNode; testId?: string; tone?: 'plain' | 'shaded'; children?: ReactNode;
}) {
  const [hovering, setHovering] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <section aria-label={label} className={`rounded-lg border border-border ${tone === 'shaded' ? 'bg-muted/30' : 'bg-background'}`} data-testid={testId}>
      <div className="relative flex items-center gap-2 pe-2"
        onMouseEnter={() => { timer.current = setTimeout(() => setHovering(true), 400); }}
        onMouseLeave={() => { clearTimeout(timer.current); setHovering(false); }}>
        <button type="button" aria-expanded={open} onClick={onToggle} className="flex flex-1 items-center gap-3 px-4 py-3 text-start">
          <Shaded>{tag}</Shaded>
          <span className={`flex-1 ${strong ? 'font-semibold' : ''}`}>{title ? <ContentText>{title}</ContentText> : null}</span>
          {meta}
          <span aria-hidden="true" className={`text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        </button>
        <ActionsMenu label={menuLabel} items={menu} />
        {hovering && !open && hover}
      </div>
      {open && <div className="space-y-4 border-t border-border px-4 py-4">{children}</div>}
    </section>
  );
}

/** The tooltip body of a closed card. */
export function HoverCard({ children }: { children: ReactNode }) {
  return <div role="tooltip" className="pointer-events-none absolute start-4 top-full z-30 mt-1 w-[min(32rem,90vw)] rounded-md border border-border bg-background p-3 text-sm shadow-lg">{children}</div>;
}
