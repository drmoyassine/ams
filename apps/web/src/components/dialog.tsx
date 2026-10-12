import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

const WIDTH = { sm: 'sm:max-w-md', md: 'sm:max-w-xl', lg: 'sm:max-w-2xl' } as const;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The one dialog shell. On phones (below `sm`) it fills the screen: no outer padding, no rounded corners, the content
 * scrolls inside and its first child (the title row with the close button) stays pinned at the top. From `sm` up it is
 * a centred card over a dimmed backdrop. Escape closes only the topmost open dialog; a mousedown on the backdrop closes it.
 *
 * Focus: when it opens, focus moves inside (to `initialFocus` if given, else the first thing that can be focused, unless
 * something inside already has it, e.g. an autofocused field); Tab and Shift+Tab stay inside the topmost dialog; when it
 * closes, focus returns to what had it before.
 */
export function Dialog({ labelledBy, onClose, children, size = 'md', z = 'z-50', initialFocus }: {
  labelledBy: string; onClose: () => void; children: ReactNode; size?: keyof typeof WIDTH;
  /** Stacking class for a dialog opened over another, e.g. `z-[60]`. */
  z?: string;
  /** A CSS selector inside the dialog for what takes focus first (e.g. the safe button of a question). */
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const isTop = () => {
      // The topmost dialog is the last one in document order (stacked dialogs render after, or inside, the one below).
      const open = document.querySelectorAll('[data-dialog-shell]');
      return open[open.length - 1] === ref.current;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!isTop()) return;
        e.stopImmediatePropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !isTop() || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0]; const last = items[items.length - 1];
      if (!first || !last) { e.preventDefault(); return; }
      const active = document.activeElement;
      if (!ref.current.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // A layout effect: focus is inside before the first paint, so nothing (a screen reader, a test) sees the dialog without it.
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      const target = (initialFocus ? el.querySelector<HTMLElement>(initialFocus) : null) ?? el.querySelector<HTMLElement>(FOCUSABLE);
      (target ?? el).focus();
    }
    return () => { if (before && before.isConnected && typeof before.focus === 'function') before.focus(); };
    // Only when it opens.
  }, []);
  return (
    <div className={`fixed inset-0 ${z} flex items-start justify-center bg-black/40 sm:overflow-y-auto sm:p-6`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} data-dialog-shell="" role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}
        className={`h-full w-full min-w-0 overflow-y-auto overscroll-contain bg-background p-4 shadow-lg break-words outline-none sm:h-auto sm:overflow-visible sm:rounded-lg sm:p-6 ${WIDTH[size]}
          max-sm:[&>:first-child]:sticky max-sm:[&>:first-child]:-top-4 max-sm:[&>:first-child]:z-10 max-sm:[&>:first-child]:-mx-4 max-sm:[&>:first-child]:-mt-4 max-sm:[&>:first-child]:bg-background max-sm:[&>:first-child]:px-4 max-sm:[&>:first-child]:pt-3 max-sm:[&>:first-child]:pb-2`}>
        {children}
      </div>
    </div>
  );
}
