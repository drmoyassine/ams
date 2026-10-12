// The app's own confirmation question, in place of the browser's window.confirm (which cannot be styled, translated,
// tested or read by a screen reader the way the rest of the app can). `useConfirm()` returns a function that opens the
// dialog and resolves true (confirmed) or false (cancelled, Escape, or a click outside):
//
//   const confirm = useConfirm();
//   if (!(await confirm({ title: 'Delete 2.1?', message: '...', confirmLabel: 'Delete', tone: 'danger' }))) return;
//
// Built on the shared Dialog: focus moves in, Tab stays inside, focus returns afterwards, Escape cancels, the phone layout
// is full screen. Focus starts on Cancel for a danger question (so a stray Enter cannot delete); Enter confirms only when
// the confirm button has focus, like any button. `ConfirmHost` is mounted once by the app layout; where it is not (a page
// rendered on its own, in tests) the first question mounts a host of its own.
import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from './ui/button';
import { Dialog } from './dialog';

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
  /** Lines under the message (what else goes with it, what stays). */
  details?: ReactNode[];
}
type Ask = ConfirmOptions & { resolve: (ok: boolean) => void };

const queue: Ask[] = [];
const hosts = new Set<(a: Ask | null) => void>();
let standalone = false;

function pump() {
  const next = queue[0] ?? null;
  for (const h of hosts) h(next);
}

function ensureHost() {
  if (hosts.size > 0 || standalone || typeof document === 'undefined') return;
  standalone = true;
  const el = document.createElement('div');
  el.setAttribute('data-confirm-host', '');
  document.body.appendChild(el);
  createRoot(el).render(<ConfirmHost />);
}

/** Opens the question; resolves true when confirmed. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  ensureHost();
  return new Promise<boolean>((resolve) => {
    queue.push({ ...options, resolve });
    // The standalone host mounts after this call: it asks for the current question when it appears.
    pump();
  });
}

export const useConfirm = () => confirmDialog;

export function ConfirmHost() {
  const [ask, setAsk] = useState<Ask | null>(queue[0] ?? null);
  useEffect(() => {
    hosts.add(setAsk);
    setAsk(queue[0] ?? null);
    return () => { hosts.delete(setAsk); };
  }, []);
  if (!ask) return null;
  const answer = (ok: boolean) => {
    queue.shift();
    ask.resolve(ok);
    pump();
  };
  const danger = ask.tone === 'danger';
  return (
    <Dialog key={queue.length ? `${ask.title}-${queue.length}` : ask.title} labelledBy="confirm-title" size="sm" z="z-[80]" onClose={() => answer(false)} initialFocus={danger ? '[data-confirm-cancel]' : '[data-confirm-ok]'}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="confirm-title" className={`min-w-0 pt-1 text-lg font-semibold break-words ${danger ? 'text-red-800' : ''}`} dir="auto">{ask.title}</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={() => answer(false)}>✕</Button>
      </div>
      <div className="space-y-2 text-sm" aria-describedby={undefined}>
        <p dir="auto" id="confirm-message">{ask.message}</p>
        {ask.details && ask.details.length > 0 && (
          <ul className="list-disc space-y-1 ps-5 text-muted-foreground">{ask.details.map((d, i) => <li key={i} dir="auto">{d}</li>)}</ul>
        )}
      </div>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" data-confirm-cancel="" onClick={() => answer(false)}>{ask.cancelLabel ?? 'Cancel'}</Button>
        <Button type="button" data-confirm-ok="" className={danger ? 'bg-red-700 text-white hover:bg-red-800' : ''} onClick={() => answer(true)}>{ask.confirmLabel ?? 'OK'}</Button>
      </div>
    </Dialog>
  );
}

/** Answers every open question "no" (tests call it between cases so one case's question cannot leak into the next). */
export function resetConfirmForTests(): void {
  while (queue.length) queue.shift()!.resolve(false);
  pump();
}
