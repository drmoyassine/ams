// Undo (DEC-026). Every reversible mutation answers with an `X-Undo` header (percent-encoded JSON:
// {label, method, path, body}); the typed client's fetch wrapper hands it to this bus, which keeps a small history per
// screen (20 entries) and the toasts that are showing. Undo sends the descriptor's request; a refusal carries the reason
// ("Cannot restore: the version is no longer a draft") and is shown, not swallowed.
import { UNDO_HEADER, UndoDescriptorSchema, type UndoDescriptor } from '@ams/shared';

export const HISTORY_LIMIT = 20;
/** How long a toast stays (ms): long enough to read and reach the button. */
export const TOAST_MS = 9000;

export interface UndoEntry {
  id: number;
  label: string;
  /** The screen it was made on (the address); Ctrl+Z only undoes what was done on the current screen. */
  scope: string;
  /** Sends the inverse request; rejects with the server's reason when it is refused. */
  run: () => Promise<void>;
}
export interface Toast { id: number; kind: 'undo' | 'error' | 'info'; label: string; entry?: UndoEntry }

type Listener = () => void;
let nextId = 1;
let history: UndoEntry[] = [];
let toasts: Toast[] = [];
let replaying = 0;
const listeners = new Set<Listener>();
const undoneListeners = new Set<Listener>();
const emit = () => { for (const l of listeners) l(); };

export const currentScope = () => (typeof window === 'undefined' ? '/' : window.location.pathname);

/** The reason a refused request gives, in the server's words. */
async function reasonOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { message?: string; error?: string };
    return body.message ?? body.error ?? `HTTP ${res.status}`;
  } catch { return text || `HTTP ${res.status}`; }
}

/** Sends the descriptor's request with the same fetch the client uses; throws the server's reason when it refuses. */
export function runner(fetcher: typeof fetch, d: UndoDescriptor): () => Promise<void> {
  return async () => {
    const res = await fetcher(d.path, {
      method: d.method, credentials: 'include',
      ...(d.body === undefined ? {} : { body: JSON.stringify(d.body), headers: { 'content-type': 'application/json' } }),
    });
    if (!res.ok) throw new Error(await reasonOf(res));
    await res.arrayBuffer().catch(() => undefined);
  };
}

/** Called by the client's fetch wrapper for every response: records the undo a mutation offered, if any. */
export function noteResponse(res: Response, fetcher: typeof fetch): void {
  if (replaying > 0) return; // what an undo itself offers (a redo) is not put on the stack
  const raw = res.headers.get(UNDO_HEADER);
  if (!raw) return;
  let parsed;
  try { parsed = UndoDescriptorSchema.safeParse(JSON.parse(decodeURIComponent(raw))); } catch { return; }
  if (!parsed.success) return;
  pushUndo(parsed.data.label, runner(fetcher, parsed.data));
}

export function pushUndo(label: string, run: () => Promise<void>, scope: string = currentScope()): UndoEntry {
  const entry: UndoEntry = { id: nextId++, label, scope, run };
  history = [...history, entry];
  // Keep 20 per screen.
  const mine = history.filter((h) => h.scope === scope);
  if (mine.length > HISTORY_LIMIT) { const drop = new Set(mine.slice(0, mine.length - HISTORY_LIMIT).map((h) => h.id)); history = history.filter((h) => !drop.has(h.id)); }
  toasts = [...toasts, { id: entry.id, kind: 'undo' as const, label, entry }].slice(-4);
  emit();
  return entry;
}

export function dismissToast(id: number): void { toasts = toasts.filter((t) => t.id !== id); emit(); }
export function showToast(kind: 'error' | 'info', label: string): void { toasts = [...toasts, { id: nextId++, kind, label }].slice(-4); emit(); }

/** Undoes one entry: its toast goes, the entry leaves the history, and data on screen is refreshed. A refusal shows why. */
export async function undoEntry(entry: UndoEntry): Promise<boolean> {
  dismissToast(entry.id);
  replaying += 1;
  try {
    await entry.run();
  } catch (e) {
    showToast('error', `Could not undo "${entry.label}": ${(e as Error).message}`);
    return false;
  } finally {
    replaying -= 1;
  }
  history = history.filter((h) => h.id !== entry.id);
  showToast('info', `Undone: ${entry.label}`);
  for (const l of undoneListeners) l();
  emit();
  return true;
}

/** Ctrl/Cmd+Z: undoes the latest action of this screen. False when there is nothing to undo here. */
export async function undoLast(scope: string = currentScope()): Promise<boolean> {
  const last = [...history].reverse().find((h) => h.scope === scope);
  if (!last) return false;
  return undoEntry(last);
}

export const hasUndo = (scope: string = currentScope()) => history.some((h) => h.scope === scope);
export const subscribe = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** Called after a successful undo: screens refresh what they show. */
export const onUndone = (l: Listener) => { undoneListeners.add(l); return () => { undoneListeners.delete(l); }; };
export const getToasts = () => toasts;
export const getHistory = () => history;
export function resetUndoForTests() { history = []; toasts = []; replaying = 0; emit(); }
