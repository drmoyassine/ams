import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { dismissToast, getToasts, hasRedo, hasUndo, onUndone, redoEntry, redoLast, subscribe, TOAST_MS, undoEntry, undoLast, type Toast } from '../lib/undo';

/** Is the keyboard focus in something people type into? Then Ctrl/Cmd+Z belongs to that field, not to the screen. */
export function isTextTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes((el as HTMLInputElement).type);
  return !!el.closest?.('[contenteditable="true"]');
}

function ToastView({ toast }: { toast: Toast }) {
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (paused || busy) return undefined;
    const t = setTimeout(() => dismissToast(toast.id), toast.kind === 'error' ? TOAST_MS * 2 : TOAST_MS);
    return () => clearTimeout(t);
  }, [paused, busy, toast.id, toast.kind]);
  const tone = toast.kind === 'error' ? 'border-red-300 bg-red-50 text-red-900' : 'border-border bg-background';
  return (
    <div role={toast.kind === 'error' ? 'alert' : 'status'} aria-live={toast.kind === 'error' ? 'assertive' : 'polite'} data-testid="toast"
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
      className={`pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg ${tone}`}>
      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]" dir="auto">{toast.label}</span>
      {toast.entry && (
        <button type="button" disabled={busy} className="shrink-0 rounded px-2 py-1 font-medium text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          onClick={() => { setBusy(true); void (toast.kind === 'redo' ? redoEntry : undoEntry)(toast.entry!).finally(() => setBusy(false)); }}>{toast.kind === 'redo' ? 'Redo' : 'Undo'}</button>
      )}
      <button type="button" aria-label="Dismiss" className="shrink-0 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted" onClick={() => dismissToast(toast.id)}>✕</button>
    </div>
  );
}

/**
 * The snackbar that follows every reversible action ("Deleted 2.1 and 6 sub-items . Undo"), and Ctrl/Cmd+Z for the latest
 * action of the current screen (and Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y to redo what was undone) when focus is not in a text field. Toasts stack, last 9 seconds (longer while hovered or
 * focused) and are plain buttons in the page order, so the keyboard reaches them. Mounted once, in the app layout.
 */
export function UndoToaster() {
  const qc = useQueryClient();
  const toasts = useSyncExternalStore(subscribe, getToasts, getToasts);
  useEffect(() => onUndone(() => { void qc.invalidateQueries(); }), [qc]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      // Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo. A text field keeps all of them for its own text.
      const redo = (key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey);
      const undo = key === 'z' && !e.shiftKey;
      if (!redo && !undo) return;
      if (isTextTarget(e.target) || !(redo ? hasRedo() : hasUndo())) return;
      e.preventDefault();
      void (redo ? redoLast() : undoLast());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div aria-label="Notifications" role="region" className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex flex-col items-center gap-2 p-4 sm:items-end">
      {toasts.map((t) => <ToastView key={t.id} toast={t} />)}
    </div>
  );
}
