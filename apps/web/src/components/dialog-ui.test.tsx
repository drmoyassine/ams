// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './dialog';

afterEach(cleanup);

function Stacked() {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(true);
  return (
    <>
      {outer && <Dialog labelledBy="outer-title" onClose={() => setOuter(false)}><h2 id="outer-title">Outer</h2></Dialog>}
      {inner && <Dialog labelledBy="inner-title" onClose={() => setInner(false)} z="z-[60]"><h2 id="inner-title">Inner</h2></Dialog>}
    </>
  );
}

describe('Dialog', () => {
  it('is a modal dialog named by its title, closed by Escape and by the backdrop', async () => {
    const onClose = vi.fn();
    render(<Dialog labelledBy="t" onClose={onClose} size="sm"><h2 id="t">Start a new version</h2><button type="button">Inside</button></Dialog>);
    const dialog = screen.getByRole('dialog', { name: 'Start a new version' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Inside' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes only the topmost of stacked dialogs on Escape', async () => {
    render(<Stacked />);
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Inner' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryAllByRole('dialog')).toHaveLength(0);
  });
});
