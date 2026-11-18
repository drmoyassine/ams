// @vitest-environment jsdom
// The address keeps where you are (deep linking): a value is read from and written to the address, survives a route that validates its own
// search (unknown keys are kept), drops out of the address at its fallback, ignores an unknown value, and is plain state without a router.
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { useUrlState } from './url-state';

afterEach(cleanup);

function Picker() {
  const [tab, setTab] = useUrlState<'one' | 'two'>('sub', 'one', ['one', 'two']);
  return <div><p data-testid="value">{tab}</p><button type="button" onClick={() => setTab('two')}>two</button><button type="button" onClick={() => setTab('one')}>one</button></div>;
}

function routerAt(href: string) {
  const root = createRootRoute();
  // A page that validates its own search and knows only `tab`, like the app's routes.
  const page = createRoute({ getParentRoute: () => root, path: '/page', component: Picker, validateSearch: (s: Record<string, unknown>) => (s.tab === 'x' ? { tab: 'x' as const } : {}) });
  return createRouter({ routeTree: root.addChildren([page]), history: createMemoryHistory({ initialEntries: [href] }) });
}

describe('useUrlState', () => {
  it('reads the value from the address and writes it back, keeping the other keys', async () => {
    const router = routerAt('/page?tab=x&sub=two');
    render(<RouterProvider router={router} />);
    expect((await screen.findByTestId('value')).textContent).toBe('two');
    await userEvent.setup().click(screen.getByRole('button', { name: 'one' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(router.state.location.search).toEqual({ tab: 'x' }); // the fallback leaves the address
    expect(screen.getByTestId('value').textContent).toBe('one');
    await userEvent.setup().click(screen.getByRole('button', { name: 'two' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(router.state.location.search).toEqual({ tab: 'x', sub: 'two' });
    expect(screen.getByTestId('value').textContent).toBe('two');
  });

  it('reads an unknown value as the fallback', async () => {
    render(<RouterProvider router={routerAt('/page?sub=nonsense')} />);
    expect((await screen.findByTestId('value')).textContent).toBe('one');
  });

  it('is plain state without a router', async () => {
    render(<Picker />);
    expect(screen.getByTestId('value').textContent).toBe('one');
    await userEvent.setup().click(screen.getByRole('button', { name: 'two' }));
    expect(screen.getByTestId('value').textContent).toBe('two');
  });
});
