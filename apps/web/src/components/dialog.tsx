import { useEffect, useRef, type ReactNode } from 'react';

const WIDTH = { sm: 'sm:max-w-md', md: 'sm:max-w-xl', lg: 'sm:max-w-2xl' } as const;

/**
 * The one dialog shell. On phones (below `sm`) it fills the screen: no outer padding, no rounded corners, the content
 * scrolls inside and its first child (the title row with the close button) stays pinned at the top. From `sm` up it is
 * a centred card over a dimmed backdrop. Escape closes only the topmost open dialog; a mousedown on the backdrop closes it.
 */
export function Dialog({ labelledBy, onClose, children, size = 'md', z = 'z-50' }: {
  labelledBy: string; onClose: () => void; children: ReactNode; size?: keyof typeof WIDTH;
  /** Stacking class for a dialog opened over another, e.g. `z-[60]`. */
  z?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The topmost dialog is the last one in document order (stacked dialogs render after, or inside, the one below).
      const open = document.querySelectorAll('[data-dialog-shell]');
      if (open[open.length - 1] !== ref.current) return;
      e.stopImmediatePropagation();
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className={`fixed inset-0 ${z} flex items-start justify-center bg-black/40 sm:overflow-y-auto sm:p-6`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} data-dialog-shell="" role="dialog" aria-modal="true" aria-labelledby={labelledBy}
        className={`h-full w-full min-w-0 overflow-y-auto overscroll-contain bg-background p-4 shadow-lg break-words sm:h-auto sm:overflow-visible sm:rounded-lg sm:p-6 ${WIDTH[size]}
          max-sm:[&>:first-child]:sticky max-sm:[&>:first-child]:-top-4 max-sm:[&>:first-child]:z-10 max-sm:[&>:first-child]:-mx-4 max-sm:[&>:first-child]:-mt-4 max-sm:[&>:first-child]:bg-background max-sm:[&>:first-child]:px-4 max-sm:[&>:first-child]:pt-3 max-sm:[&>:first-child]:pb-2`}>
        {children}
      </div>
    </div>
  );
}
