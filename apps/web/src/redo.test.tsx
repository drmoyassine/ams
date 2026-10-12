// @vitest-environment jsdom
// Redo in the browser (TASK-065): the redo stack beside the undo history, the "Undone . Redo" toast, Ctrl/Cmd+Shift+Z and
// Ctrl/Cmd+Y, a new action clearing the stack, and a refused redo saying why. A fake fetch stands in for the API: no network.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPLAY_HEADER, UNDO_HEADER, type UndoDescriptor } from '@ams/shared';
import { UndoToaster } from './components/undo-toaster';
import { getRedoStack, getHistory, HISTORY_LIMIT, hasRedo, hasUndo, noteResponse, pushUndo, resetUndoForTests, redoLast, undoLast } from './lib/undo';

const header = (d: UndoDescriptor) => encodeURIComponent(JSON.stringify(d));
const answer = (d: UndoDescriptor | null, status = 200) =>
  new Response(status === 204 ? null : '{}', { status, headers: d ? { [UNDO_HEADER]: header(d) } : {} });

const del: UndoDescriptor = { label: 'Deleted 2.1 and 6 sub-items', method: 'POST', path: '/api/trash/groups/g1/restore', body: {} };
const redoDelete: UndoDescriptor = { label: 'Restored 2.1', method: 'POST', path: '/api/requirements/delete', body: { ids: ['a'] }, kind: 'redo' };
const undoAgain: UndoDescriptor = { label: 'Deleted 2.1 and 6 sub-items', method: 'POST', path: '/api/trash/groups/g2/restore', body: {}, kind: 'undo' };

/** A fake API: the restore answers with the redo descriptor, the delete with the undo descriptor again. */
function fakeFetch(opts: { refuseRedo?: string } = {}) {
  const calls: { path: string; replay: string | null }[] = [];
  const fetcher = (async (path: string, init?: RequestInit) => {
    const replay = new Headers(init?.headers).get(REPLAY_HEADER);
    calls.push({ path, replay });
    if (path.endsWith('/restore')) return answer(redoDelete);
    if (path === '/api/requirements/delete') {
      if (opts.refuseRedo) return new Response(JSON.stringify({ message: opts.refuseRedo }), { status: 409 });
      return answer(undoAgain);
    }
    return answer(null);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const wrap = (ui: React.ReactNode) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
const toasts = () => screen.queryAllByTestId('toast');
afterEach(() => { cleanup(); resetUndoForTests(); vi.useRealTimers(); });

/** A new action arrives through the client's fetch wrapper exactly like this. */
const newAction = (f: typeof fetch, d: UndoDescriptor | null = del, method = 'DELETE') => noteResponse(answer(d), f, method);

describe('the redo stack', () => {
  it('Undo sends X-Replay: undo and puts what the answer offers on the redo stack; Redo sends X-Replay: redo and offers the Undo again', async () => {
    const { fetcher, calls } = fakeFetch();
    newAction(fetcher);
    expect(hasUndo()).toBe(true);
    expect(hasRedo()).toBe(false);
    expect(await undoLast()).toBe(true);
    expect(calls).toEqual([{ path: del.path, replay: 'undo' }]);
    expect(hasUndo()).toBe(false);
    expect(hasRedo()).toBe(true);
    expect(await redoLast()).toBe(true);
    expect(calls[1]).toEqual({ path: '/api/requirements/delete', replay: 'redo' });
    expect(hasRedo()).toBe(false);
    expect(hasUndo()).toBe(true); // the redo offered its undo, which is now the latest action
    expect(getHistory()[0]!.label).toBe('Deleted 2.1 and 6 sub-items');
    expect(await redoLast()).toBe(false); // nothing more to redo
  });

  it('redoes in the reverse order of the undos', async () => {
    const { fetcher, calls } = fakeFetch();
    newAction(fetcher, { ...del, path: '/api/trash/groups/first/restore' });
    newAction(fetcher, { ...del, path: '/api/trash/groups/second/restore' });
    await undoLast();
    await undoLast();
    expect(getRedoStack()).toHaveLength(2);
    await redoLast();
    await redoLast();
    expect(calls.filter((c) => c.replay === 'redo')).toHaveLength(2);
    expect(hasRedo()).toBe(false);
  });

  it('a new action clears the redo stack, even one that offers no undo; a read does not', async () => {
    const { fetcher } = fakeFetch();
    newAction(fetcher);
    await undoLast();
    expect(hasRedo()).toBe(true);
    noteResponse(answer(null), fetcher, 'GET');
    expect(hasRedo()).toBe(true); // reading is not an action
    noteResponse(answer(null, 500), fetcher, 'POST');
    expect(hasRedo()).toBe(true); // a refused request did nothing
    noteResponse(answer(null), fetcher, 'PATCH');
    expect(hasRedo()).toBe(false);
    newAction(fetcher);
    await undoLast();
    newAction(fetcher, { ...del, label: 'Moved 3.2' });
    expect(hasRedo()).toBe(false);
  });

  it('keeps 20 per screen', async () => {
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) pushUndo(`Edit ${i}`, async () => ({ label: `Edit ${i}`, run: async () => null }));
    expect(getHistory()).toHaveLength(HISTORY_LIMIT);
    for (let i = 0; i < HISTORY_LIMIT; i += 1) await undoLast();
    expect(getRedoStack()).toHaveLength(HISTORY_LIMIT);
    pushUndo('One more', async () => undefined);
    expect(getRedoStack()).toHaveLength(0);
  });

  it('an undo that offers nothing to redo leaves the redo stack empty', async () => {
    const f = (async () => answer(null)) as unknown as typeof fetch;
    newAction(f);
    await undoLast();
    expect(hasRedo()).toBe(false);
  });
});

describe('the toast', () => {
  it('after an Undo shows "Undone" with a labelled Redo button in a status region; Redo shows "Redone" with Undo', async () => {
    const { fetcher } = fakeFetch();
    const user = userEvent.setup();
    render(wrap(<UndoToaster />));
    newAction(fetcher);
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    const undone = await screen.findByText(`Undone: ${del.label}`);
    const toast = undone.closest('[data-testid="toast"]') as HTMLElement;
    expect(toast.getAttribute('role')).toBe('status');
    expect(toast.getAttribute('aria-live')).toBe('polite');
    await user.click(within(toast).getByRole('button', { name: 'Redo' }));
    const redone = await screen.findByText(`Redone: ${undoAgain.label}`);
    expect(within(redone.closest('[data-testid="toast"]') as HTMLElement).getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Redo' })).toBeNull();
  });

  it('the Redo toast goes away after a few seconds, and the redo stays available on the keyboard', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetcher } = fakeFetch();
    render(wrap(<UndoToaster />));
    newAction(fetcher);
    await undoLast();
    await screen.findByRole('button', { name: 'Redo' });
    vi.advanceTimersByTime(9500);
    await waitFor(() => expect(toasts()).toHaveLength(0));
    expect(hasRedo()).toBe(true);
  });

  it('a refused Redo shows the server\'s reason as an alert and keeps the entry', async () => {
    const { fetcher } = fakeFetch({ refuseRedo: 'Cannot redo: the version is no longer a draft (it is published).' });
    const user = userEvent.setup();
    render(wrap(<UndoToaster />));
    newAction(fetcher);
    await undoLast();
    await user.click(await screen.findByRole('button', { name: 'Redo' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not redo');
    expect(alert.textContent).toContain('Cannot redo: the version is no longer a draft (it is published).');
    expect(hasRedo()).toBe(true);
    expect(hasUndo()).toBe(false);
  });

  it('shows no Redo button when the Undo offered nothing to redo', async () => {
    const f = (async () => answer(null)) as unknown as typeof fetch;
    render(wrap(<UndoToaster />));
    newAction(f);
    await undoLast();
    await screen.findByText(`Undone: ${del.label}`);
    expect(screen.queryByRole('button', { name: 'Redo' })).toBeNull();
  });
});

describe('the keyboard', () => {
  const setup = async () => {
    const { fetcher, calls } = fakeFetch();
    const user = userEvent.setup();
    render(wrap(<><input aria-label="Title" /><UndoToaster /></>));
    newAction(fetcher);
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(hasRedo()).toBe(true));
    return { user, calls };
  };

  it.each([
    ['Ctrl+Shift+Z', '{Control>}{Shift>}z{/Shift}{/Control}'],
    ['Cmd+Shift+Z', '{Meta>}{Shift>}z{/Shift}{/Meta}'],
    ['Ctrl+Y', '{Control>}y{/Control}'],
    ['Cmd+Y', '{Meta>}y{/Meta}'],
  ])('%s redoes the latest undone action of the screen', async (_name, keys) => {
    const { user, calls } = await setup();
    await user.keyboard(keys);
    await waitFor(() => expect(calls.some((c) => c.replay === 'redo')).toBe(true));
    await waitFor(() => expect(hasRedo()).toBe(false));
  });

  it('leaves them to a text field, and does nothing when there is nothing to redo', async () => {
    const { user, calls } = await setup();
    await user.click(screen.getByLabelText('Title'));
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    await user.keyboard('{Control>}y{/Control}');
    expect(calls.some((c) => c.replay === 'redo')).toBe(false);
    expect(hasRedo()).toBe(true);
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('{Control>}y{/Control}');
    await waitFor(() => expect(hasRedo()).toBe(false));
    const n = calls.length;
    await user.keyboard('{Control>}y{/Control}');
    expect(calls.length).toBe(n);
  });

  it('plain Ctrl+Z still only undoes, and Ctrl+Shift+Z does not undo', async () => {
    const { fetcher, calls } = fakeFetch();
    const user = userEvent.setup();
    render(wrap(<UndoToaster />));
    newAction(fetcher);
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    expect(calls).toHaveLength(0);
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(calls).toHaveLength(1));
  });
});
