// Undo (DEC-026). Every reversible mutation answers with an `X-Undo` header (percent-encoded JSON:
// {label, method, path, body}); the typed client's fetch wrapper hands it to this bus, which keeps a small history per
// screen (20 entries) and the toasts that are showing. Undo sends the descriptor's request; a refusal carries the reason
// ("Cannot restore: the version is no longer a draft") and is shown, not swallowed.
// Redo (TASK-065): the response to an Undo carries, tagged `kind: 'redo'`, the descriptor that re-does the action; it goes on
// a per-screen redo stack (20) beside the history. The response to a Redo carries the Undo again. Any new action clears the
// redo stack of the screen.
import { REPLAY_HEADER, UNDO_HEADER, UndoDescriptorSchema, type UndoDescriptor } from '@ams/shared';

export const HISTORY_LIMIT = 20;
/** How long a toast stays (ms): long enough to read and reach the button. */
export const TOAST_MS = 9000;

export interface UndoEntry {
  id: number;
  label: string;
  /** The screen it was made on (the address); Ctrl+Z only undoes what was done on the current screen. */
  scope: string;
  /** Sends the inverse request; resolves with what the answer offers to take this back again (null: nothing); rejects with the server's reason when refused. */
  run: () => Promise<Step | null>;
}
/** One request that can be sent (an Undo or a Redo) and the step the answer offers in the other direction. */
export interface Step { label: string; run: () => Promise<Step | null> }
export interface Toast { id: number; kind: 'undo' | 'redo' | 'error' | 'info'; label: string; entry?: UndoEntry }

type Listener = () => void;
let nextId = 1;
let history: UndoEntry[] = [];
let redoStack: UndoEntry[] = [];
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

function parseDescriptor(raw: string | null): UndoDescriptor | null {
  if (!raw) return null;
  try {
    const parsed = UndoDescriptorSchema.safeParse(JSON.parse(decodeURIComponent(raw)));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/**
 * Sends the descriptor's request with the same fetch the client uses, marked as an Undo or a Redo (the server then tags what
 * it offers back). Throws the server's reason when it refuses; returns the descriptor of the other direction, if it offered one.
 */
export function runner(fetcher: typeof fetch, d: UndoDescriptor, as: 'undo' | 'redo' = 'undo'): () => Promise<Step | null> {
  return async () => {
    const res = await fetcher(d.path, {
      method: d.method, credentials: 'include',
      headers: { [REPLAY_HEADER]: as, ...(d.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(d.body === undefined ? {} : { body: JSON.stringify(d.body) }),
    });
    if (!res.ok) throw new Error(await reasonOf(res));
    const back = parseDescriptor(res.headers.get(UNDO_HEADER));
    await res.arrayBuffer().catch(() => undefined);
    return back ? { label: back.label, run: runner(fetcher, back, as === 'undo' ? 'redo' : 'undo') } : null;
  };
}

/** Called by the client's fetch wrapper for every response: records the undo a mutation offered, if any. */
export function noteResponse(res: Response, fetcher: typeof fetch, method: string = 'POST'): void {
  if (replaying > 0) return; // what an undo or redo itself offers is handled by undoEntry / redoEntry, not put on the stack here
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && res.ok;
  const d = parseDescriptor(res.headers.get(UNDO_HEADER));
  if (d) { pushUndo(d.label, runner(fetcher, d, 'undo')); return; }
  // A new action that offers no undo still ends the chain of redos: what they would redo no longer follows from here.
  if (mutation) clearRedo();
}

function trim(list: UndoEntry[], scope: string): UndoEntry[] {
  const mine = list.filter((h) => h.scope === scope);
  if (mine.length <= HISTORY_LIMIT) return list;
  const drop = new Set(mine.slice(0, mine.length - HISTORY_LIMIT).map((h) => h.id));
  return list.filter((h) => !drop.has(h.id));
}

/** A NEW action: goes on the history (20 per screen), shows its toast, and clears the redo stack of the screen. */
export function pushUndo(label: string, run: () => Promise<Step | null | void>, scope: string = currentScope()): UndoEntry {
  const entry: UndoEntry = { id: nextId++, label, scope, run: async () => (await run()) ?? null };
  redoStack = redoStack.filter((r) => r.scope !== scope);
  addToHistory(entry);
  toasts = [...toasts, { id: entry.id, kind: 'undo' as const, label, entry }].slice(-4);
  emit();
  return entry;
}

function addToHistory(entry: UndoEntry) { history = trim([...history, entry], entry.scope); }
/** Clears the redo stack of a screen (a new action was made there). */
export function clearRedo(scope: string = currentScope()): void {
  if (!redoStack.some((r) => r.scope === scope)) return;
  redoStack = redoStack.filter((r) => r.scope !== scope);
  emit();
}

export function dismissToast(id: number): void { toasts = toasts.filter((t) => t.id !== id); emit(); }
export function showToast(kind: 'error' | 'info', label: string): void { toasts = [...toasts, { id: nextId++, kind, label }].slice(-4); emit(); }

/** Undoes one entry: its toast goes, the entry leaves the history, and data on screen is refreshed. A refusal shows why. */
export async function undoEntry(entry: UndoEntry): Promise<boolean> {
  dismissToast(entry.id);
  replaying += 1;
  let redo: Step | null;
  try {
    redo = await entry.run();
  } catch (e) {
    showToast('error', `Could not undo "${entry.label}": ${(e as Error).message}`);
    return false;
  } finally {
    replaying -= 1;
  }
  history = history.filter((h) => h.id !== entry.id);
  // What the answer offers to do it again goes on the redo stack of the screen the action was made on.
  let again: UndoEntry | undefined;
  if (redo) {
    again = { id: nextId++, label: entry.label, scope: entry.scope, run: redo.run };
    redoStack = trim([...redoStack, again], entry.scope);
  }
  // The toast shares the redo entry's id, so using the entry (Redo, or Ctrl+Y) takes its toast down.
  toasts = [...toasts, { id: again?.id ?? nextId++, kind: 'redo' as const, label: `Undone: ${entry.label}`, ...(again ? { entry: again } : {}) }].slice(-4);
  for (const l of undoneListeners) l();
  emit();
  return true;
}

/** Redo: sends the descriptor the Undo returned. The answer offers the Undo again; a refusal says why and the entry stays. */
export async function redoEntry(entry: UndoEntry): Promise<boolean> {
  dismissToast(entry.id);
  replaying += 1;
  let back: Step | null;
  try {
    back = await entry.run();
  } catch (e) {
    showToast('error', `Could not redo "${entry.label}": ${(e as Error).message}`);
    return false;
  } finally {
    replaying -= 1;
  }
  redoStack = redoStack.filter((r) => r.id !== entry.id);
  if (back) {
    const undo: UndoEntry = { id: nextId++, label: back.label, scope: entry.scope, run: back.run };
    addToHistory(undo);
    toasts = [...toasts, { id: undo.id, kind: 'undo' as const, label: `Redone: ${back.label}`, entry: undo }].slice(-4);
  } else {
    showToast('info', `Redone: ${entry.label}`);
  }
  for (const l of undoneListeners) l();
  emit();
  return true;
}

/**
 * Undoes or redoes an action that is not on this screen's history: a button inside the chat (the assistant's change card) whose
 * descriptor is known. Same request (marked X-Replay), same toasts, and the answer lands on the Redo / Undo stacks like any other,
 * so Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z keep working around it.
 */
export function undoDescriptor(fetcher: typeof fetch, d: UndoDescriptor): Promise<boolean> {
  return undoEntry({ id: nextId++, label: d.label, scope: currentScope(), run: runner(fetcher, d, 'undo') });
}
export function redoDescriptor(fetcher: typeof fetch, d: UndoDescriptor): Promise<boolean> {
  return redoEntry({ id: nextId++, label: d.label, scope: currentScope(), run: runner(fetcher, d, 'redo') });
}

/** Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y: redoes the latest undone action of this screen. False when there is nothing to redo here. */
export async function redoLast(scope: string = currentScope()): Promise<boolean> {
  const last = [...redoStack].reverse().find((h) => h.scope === scope);
  return last ? redoEntry(last) : false;
}

/** Ctrl/Cmd+Z: undoes the latest action of this screen. False when there is nothing to undo here. */
export async function undoLast(scope: string = currentScope()): Promise<boolean> {
  const last = [...history].reverse().find((h) => h.scope === scope);
  if (!last) return false;
  return undoEntry(last);
}

export const hasRedo = (scope: string = currentScope()) => redoStack.some((h) => h.scope === scope);
export const getRedoStack = () => redoStack;
export const hasUndo = (scope: string = currentScope()) => history.some((h) => h.scope === scope);
export const subscribe = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** Called after a successful undo: screens refresh what they show. */
export const onUndone = (l: Listener) => { undoneListeners.add(l); return () => { undoneListeners.delete(l); }; };
export const getToasts = () => toasts;
export const getHistory = () => history;
export function resetUndoForTests() { history = []; redoStack = []; toasts = []; replaying = 0; emit(); }
