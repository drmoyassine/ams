// @vitest-environment jsdom
// The side panels of Settings and Quality Management (the owner, 2026-11-24): collapsible to icons with a tooltip on each, the choice
// saved on the person per panel (apart from the main menu); Quality Management's standards are a vertical tab list with their icons.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidePanel } from './components/side-panel';
import { StandardIcon, IconPicker } from './components/standard-icons';
import type { SettingsApi } from './lib/settings-api';

const settingsApi = (panels: Record<string, boolean> = {}) => {
  const updateMyPreferences = vi.fn(async () => ({}));
  const api = { me: async () => ({ permissions: [], language: { panelsCollapsed: panels } }), updateMyPreferences } as unknown as SettingsApi;
  return { api, updateMyPreferences };
};
const wrap = (ui: React.ReactElement) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>;

describe('side panel', () => {
  it('is a vertical tab list that collapses to icons with tooltips, and saves that on the person for this panel only', async () => {
    const user = userEvent.setup();
    const { api, updateMyPreferences } = settingsApi();
    const picked: string[] = [];
    render(wrap(
      <SidePanel panelKey="quality" title="Quality Management" label="IQF standards" tabs api={api}
        breadcrumb={[{ label: 'Quality Management', href: '/quality-management' }, { label: '1 Mission' }]}
        items={[
          { key: '1', label: '1 Mission', active: true, onSelect: () => picked.push('1'), iconNode: <StandardIcon name="Target" code="1" /> },
          { key: '2', label: '2 Programs', active: false, onSelect: () => picked.push('2'), iconNode: <StandardIcon name={null} code="2" /> },
        ]}>
        <p>Content</p>
      </SidePanel>,
    ));
    const list = screen.getByRole('tablist', { name: 'IQF standards' });
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
    expect(screen.getByRole('tab', { name: '1 Mission' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toContain('1 Mission');
    await user.click(screen.getByRole('tab', { name: '2 Programs' }));
    expect(picked).toEqual(['2']);
    expect(screen.queryAllByRole('tooltip', { hidden: true })).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Collapse Quality Management' }));
    expect(updateMyPreferences).toHaveBeenCalledWith({ panelsCollapsed: { quality: true } });
    // Collapsed: the label stays the tab's name, and shows as a tooltip on hover and focus.
    expect(screen.getByRole('tab', { name: '2 Programs' })).toBeTruthy();
    expect(screen.getAllByRole('tooltip', { hidden: true }).map((t) => t.textContent)).toEqual(['1 Mission', '2 Programs']);
    expect(screen.getByRole('button', { name: 'Expand Quality Management' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('opens collapsed when the person saved it so', async () => {
    const { api } = settingsApi({ settings: true });
    render(wrap(<SidePanel panelKey="settings" title="Settings" label="Settings" tabs api={api} items={[{ key: 'a', label: 'Organization', active: true, onSelect: () => undefined }]}><p>x</p></SidePanel>));
    expect(await screen.findByRole('button', { name: 'Expand Settings' })).toBeTruthy();
  });

  it('chooses an icon by searching for what it means, or none', async () => {
    const user = userEvent.setup();
    const picks: (string | null)[] = [];
    render(<IconPicker title="Icon for Standard 1.0" value="Target" onPick={(n) => { picks.push(n); }} onClose={() => undefined} />);
    await user.type(screen.getByRole('textbox', { name: 'Search icons' }), 'research');
    const options = screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'));
    expect(options).toContain('Microscope');
    expect(options).not.toContain('Target');
    await user.click(screen.getByRole('option', { name: 'Microscope' }));
    expect(picks).toEqual(['Microscope']);
  });
});
