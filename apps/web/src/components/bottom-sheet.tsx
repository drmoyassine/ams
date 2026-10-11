import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A panel that slides up from the bottom of a phone screen over a dimmed backdrop (the source viewer on small screens).
 * Escape and a tap on the backdrop close it; only the topmost open dialog or sheet answers Escape.
 */
export function BottomSheet({ labelledBy, onClose, children }: { labelledBy: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const open = document.querySelectorAll('[data-dialog-shell]');
      if (open[open.length - 1] !== ref.current) return;
      e.stopImmediatePropagation();
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} data-dialog-shell="" role="dialog" aria-modal="true" aria-labelledby={labelledBy}
        className="max-h-[85dvh] w-full min-w-0 overflow-y-auto overscroll-contain rounded-t-xl bg-background p-4 shadow-lg break-words">
        {children}
      </div>
    </div>
  );
}
