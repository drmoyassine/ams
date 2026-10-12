// @vitest-environment jsdom
// The app's own confirmation question (DEC-026), in place of window.confirm: focus handling, keys, tone, queueing.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetConfirmForTests, useConfirm, type ConfirmOptions } from './components/confirm-dialog';

afterEach(() => { resetConfirmForTests(); cleanup(); vi.restoreAllMocks(); });

function Harness({ options, onAnswer }: { options: ConfirmOptions; onAnswer: (ok: boolean) => void }) {
  const confirm = useConfirm();
  return <button type="button" onClick={() => void confirm(options).then(onAnswer)}>Ask</button>;
}
const open = async (options: Partial<ConfirmOptions> = {}) => {
  const answers: boolean[] = [];
  const user = userEvent.setup();
  render(<Harness options={{ title: 'Delete 2.1?', message: 'Delete 2.1 and its 6 sub-items and 11 notes? You can restore them from the Trash for 30 days.', confirmLabel: 'Delete', tone: 'danger', ...options }} onAnswer={(ok) => answers.push(ok)} />);
  const trigger = screen.getByRole('button', { name: 'Ask' });
  await user.click(trigger);
  return { user, answers, trigger, dialog: await screen.findByRole('dialog', { name: options.title ?? 'Delete 2.1?' }) };
};

describe('useConfirm', () => {
  it('opens an accessible dialog (not the browser\'s) named by its title, with the message and details', async () => {
    const browser = vi.spyOn(window, 'confirm');
    const { dialog } = await open({ details: ['Its evidence links stay where they are.'] });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Delete 2.1 and its 6 sub-items and 11 notes?');
    expect(within(dialog).getByRole('list').textContent).toContain('Its evidence links stay where they are.');
    expect(browser).not.toHaveBeenCalled();
  });

  it('resolves true on the confirm button and false on Cancel, Escape, the close button and a click outside', async () => {
    let r = await open();
    await r.user.click(within(r.dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(r.answers).toEqual([true]));
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();

    for (const how of ['cancel', 'escape', 'close', 'outside'] as const) {
      r = await open();
      if (how === 'cancel') await r.user.click(within(r.dialog).getByRole('button', { name: 'Cancel' }));
      if (how === 'escape') await r.user.keyboard('{Escape}');
      if (how === 'close') await r.user.click(within(r.dialog).getByRole('button', { name: 'Close' }));
      if (how === 'outside') fireEvent.mouseDown(r.dialog.parentElement!);
      await waitFor(() => expect(r.answers).toEqual([false]));
      expect(screen.queryByRole('dialog')).toBeNull();
      cleanup();
    }
  });

  it('starts on Cancel for a danger question, so Enter alone cannot confirm; Enter confirms only on the confirm button', async () => {
    const r = await open();
    expect(document.activeElement).toBe(within(r.dialog).getByRole('button', { name: 'Cancel' }));
    await r.user.keyboard('{Enter}'); // on Cancel: cancels
    await waitFor(() => expect(r.answers).toEqual([false]));
    cleanup();

    const again = await open();
    await again.user.tab(); // Cancel -> Delete
    expect(document.activeElement).toBe(within(again.dialog).getByRole('button', { name: 'Delete' }));
    await again.user.keyboard('{Enter}');
    await waitFor(() => expect(again.answers).toEqual([true]));
  });

  it('starts on the confirm button for a plain question', async () => {
    const r = await open({ title: 'Make a new link?', tone: 'default', confirmLabel: 'Make a new link' });
    expect(document.activeElement).toBe(within(r.dialog).getByRole('button', { name: 'Make a new link' }));
  });

  it('keeps Tab inside the dialog, and gives focus back to what had it', async () => {
    const r = await open();
    const cancel = within(r.dialog).getByRole('button', { name: 'Cancel' });
    const close = within(r.dialog).getByRole('button', { name: 'Close' });
    const ok = within(r.dialog).getByRole('button', { name: 'Delete' });
    expect(document.activeElement).toBe(cancel);
    await r.user.tab(); expect(document.activeElement).toBe(ok);
    await r.user.tab(); expect(r.dialog.contains(document.activeElement)).toBe(true); // wrapped to the first control, never out to the page
    await r.user.tab({ shift: true }); await r.user.tab({ shift: true });
    expect(r.dialog.contains(document.activeElement)).toBe(true);
    void close;
    await r.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(r.trigger);
  });

  it('marks a danger question visibly and lays out for a phone (full screen) through the shared dialog', async () => {
    const r = await open();
    expect(within(r.dialog).getByRole('button', { name: 'Delete' }).className).toContain('bg-red-700');
    expect(within(r.dialog).getByRole('heading', { name: 'Delete 2.1?' }).className).toContain('text-red-800');
    expect(r.dialog.className).toContain('h-full'); // fills the screen below the small breakpoint, a card from sm up
    const plain = await (async () => { resetConfirmForTests(); cleanup(); return open({ title: 'Make a new link?', tone: 'default', confirmLabel: 'Go' }); })();
    expect(within(plain.dialog).getByRole('button', { name: 'Go' }).className).not.toContain('bg-red-700');
  });

  it('shows questions one after the other when several are asked', async () => {
    const answers: string[] = [];
    function Two() {
      const confirm = useConfirm();
      return <button type="button" onClick={() => { void confirm({ title: 'First?', message: 'one' }).then((ok) => answers.push(`first:${ok}`)); void confirm({ title: 'Second?', message: 'two' }).then((ok) => answers.push(`second:${ok}`)); }}>Ask two</button>;
    }
    const user = userEvent.setup();
    render(<Two />);
    await user.click(screen.getByRole('button', { name: 'Ask two' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'First?' })).getByRole('button', { name: 'OK' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Second?' })).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(answers).toEqual(['first:true', 'second:false']));
  });

  it('keeps the direction of Arabic text in the question', async () => {
    const r = await open({ title: 'حذف المعيار؟', message: 'سيتم حذف المعيار الأول' });
    expect(within(r.dialog).getByRole('heading').getAttribute('dir')).toBe('auto');
    expect(r.dialog.querySelector('#confirm-message')!.getAttribute('dir')).toBe('auto');
  });
});
