// @vitest-environment jsdom
// Delete, Undo and the Trash in the browser (DEC-026), against the real API and database: the in-app confirm dialog with
// counts, the Undo toast and Ctrl/Cmd+Z, a failed undo that says why, "Delete all standards in this version", and the
// Trash page (groups, filters, restore, delete forever, empty trash, the parent-is-gone choice). Nothing touches the network.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore, seedFrameworks } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { resetConfirmForTests } from './components/confirm-dialog';
import { UndoToaster } from './components/undo-toaster';
import { createApi } from './lib/api';
import { frameworkApi } from './lib/framework-api';
import { glossaryApi } from './lib/glossary-api';
import { settingsApi } from './lib/settings-api';
import { trashApi } from './lib/trash-api';
import { resetUndoForTests } from './lib/undo';
import { QualityFrameworkPage } from './pages/settings/quality-framework';
import { SettingsLayout } from './pages/settings/layout';
import { TrashPage } from './pages/settings/trash';
import { VersionPage } from './pages/version';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const apiOf = (who: string) => createApi(((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch);
const apiFor = (who: string) => frameworkApi(apiOf(who));
const trashFor = (who: string) => trashApi(apiOf(who));
const extra = (who: string) => ({ glossary: glossaryApi(apiOf(who)), settings: settingsApi(apiOf(who)) });
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const quality = (who = 'lead') => <><QualityFrameworkPage api={apiFor(who)} {...extra(who)} /><UndoToaster /></>;
const standardsList = () => screen.findByRole('list', { name: 'Standards' });
async function deleteFromMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  const card = await screen.findByRole('region', { name });
  await user.click(within(card).getAllByRole('button', { name: `Actions for ${name}` })[0]!);
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
}
const confirmDelete = async (user: ReturnType<typeof userEvent.setup>, title: string | RegExp) => {
  const dialog = await screen.findByRole('dialog', { name: title });
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
};
const toasts = () => screen.queryAllByTestId('toast');

beforeAll(async () => {
  db = await createTestDb('webtrash');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  await seedFrameworks(pool, undefined);
  const q = await apiFor('lead').setUpQualityFramework({ template: true });
  ids.iqf = q.versions[0]!.id;
}, 60000);
afterEach(() => { resetConfirmForTests(); cleanup(); resetUndoForTests(); vi.restoreAllMocks(); });
afterAll(async () => { await pool.end(); await db.close(); });

const codes = async () => (await apiFor('lead').requirements(ids.iqf!)).map((r) => r.code);

describe('delete with a question in the app, then Undo', () => {
  it('asks in the app dialog with what goes along, deletes the whole subtree, and Undo brings it all back', async () => {
    const browserConfirm = vi.spyOn(window, 'confirm').mockImplementation(() => true);
    const user = userEvent.setup();
    const before = await codes();
    render(wrap(quality()));
    await standardsList();
    const preview = await apiFor('lead').previewDelete([(await apiFor('lead').requirements(ids.iqf!)).find((r) => r.code === '3')!.id]);
    expect(preview.counts).toMatchObject({ items: 1 });
    expect((preview.counts.subItems ?? 0)).toBeGreaterThan(0);

    // Cancel (Escape) changes nothing, and focus starts on the safe button.
    await deleteFromMenu(user, 'Standard 3.0');
    const dialog = await screen.findByRole('dialog', { name: 'Delete Standard 3.0?' });
    expect(dialog.textContent).toContain(preview.message);
    expect(dialog.textContent).toMatch(/Delete 3 and its \d+ sub-items?\? You can restore them from the Trash for 30 days\./);
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await codes()).toEqual(before);

    // Confirm: the card and its sub-standards are gone, and a toast offers Undo.
    await deleteFromMenu(user, 'Standard 3.0');
    await confirmDelete(user, 'Delete Standard 3.0?');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Standard 3.0' })).toBeNull());
    expect(screen.queryByRole('region', { name: 'Standard 3.2' })).toBeNull();
    const toast = await screen.findByRole('status');
    expect(toast.textContent).toMatch(/^Deleted 3 and \d+ sub-items?Undo/);
    expect(await codes()).not.toContain('3.2');
    expect(browserConfirm).not.toHaveBeenCalled();

    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('region', { name: 'Standard 3.0' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Standard 3.2' })).toBeTruthy();
    expect(await codes()).toEqual(before);
    expect(toasts().map((t) => t.textContent)).toEqual([expect.stringMatching(/^Undone: Deleted 3 and \d+ sub-items?/)]);
    // It was in the Trash while it was away, and is no longer.
    expect((await trashFor('lead').list()).total).toBe(0);
  });

  it('Ctrl+Z undoes the latest action of the screen, but not while focus is in a text field', async () => {
    const user = userEvent.setup();
    const before = await codes();
    render(wrap(quality()));
    await standardsList();
    await deleteFromMenu(user, 'Standard 4.0');
    await confirmDelete(user, 'Delete Standard 4.0?');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Standard 4.0' })).toBeNull());
    await screen.findByRole('status');

    // In a field, Ctrl+Z is the field's own.
    await user.click(screen.getByRole('button', { name: '+ Standard' }));
    const field = within(await screen.findByRole('dialog')).getByLabelText('Title');
    await user.click(field);
    await user.keyboard('{Control>}z{/Control}');
    expect(screen.queryByRole('region', { name: 'Standard 4.0' })).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Anywhere else it is the screen's Undo.
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('{Control>}z{/Control}');
    expect(await screen.findByRole('region', { name: 'Standard 4.0' })).toBeTruthy();
    expect(await codes()).toEqual(before);
    // The Mac key does the same.
    await deleteFromMenu(user, 'Standard 5.0');
    await confirmDelete(user, 'Delete Standard 5.0?');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Standard 5.0' })).toBeNull());
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('{Meta>}z{/Meta}');
    expect(await screen.findByRole('region', { name: 'Standard 5.0' })).toBeTruthy();
  });

  it('says why an Undo cannot be done, in the server\'s words', async () => {
    const user = userEvent.setup();
    render(wrap(quality()));
    await standardsList();
    await deleteFromMenu(user, 'Standard 6.0');
    await confirmDelete(user, 'Delete Standard 6.0?');
    const toast = await screen.findByRole('status');
    // The version is published meanwhile.
    await db.su.query(`update requirement set review_status = 'approved' where framework_version_id = $1`, [ids.iqf]);
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [ids.iqf]);
    await db.su.query(`update framework_version set status = 'published', published_by = $2, published_at = now() where id = $1`, [ids.iqf, ids.admin]);
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Cannot restore: the version is no longer a draft (it is published)');
    expect(alert.textContent).toContain('Could not undo');
    expect((await trashFor('lead').list()).total).toBe(1); // still there, untouched
    // Clean up for the tests after this one: a new draft is not needed, the data is read through the API only.
  });
});

describe('the toast', () => {
  it('is a status message with an Undo button, stacks, and goes away after a few seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { pushUndo } = await import('./lib/undo');
      render(wrap(<UndoToaster />));
      pushUndo('Deleted 2.1 and 6 sub-items', async () => undefined);
      pushUndo('Moved 3.2', async () => undefined);
      const shown = await screen.findAllByRole('status');
      expect(shown.map((t) => t.textContent)).toEqual(['Deleted 2.1 and 6 sub-itemsUndo✕', 'Moved 3.2Undo✕']);
      expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(2);
      expect(screen.getByRole('region', { name: 'Notifications' })).toBeTruthy();
      vi.advanceTimersByTime(8000);
      expect(screen.getAllByTestId('toast')).toHaveLength(2); // still there at 8 s
      vi.advanceTimersByTime(1500);
      await waitFor(() => expect(screen.queryAllByTestId('toast')).toHaveLength(0));
    } finally { vi.useRealTimers(); }
  });

  it('is reachable by keyboard and can be dismissed', async () => {
    const { pushUndo } = await import('./lib/undo');
    const user = userEvent.setup();
    let undone = false;
    render(wrap(<><button type="button">Before</button><UndoToaster /></>));
    pushUndo('Edited 1.2', async () => { undone = true; });
    await user.tab(); // the page's own button
    await user.tab();
    expect(document.activeElement).toBe(await screen.findByRole('button', { name: 'Undo' }));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(undone).toBe(true));
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryAllByTestId('toast')).toHaveLength(0));
  });
});

describe('Delete all standards in this version', () => {
  it('asks once with the counts, deletes the whole content as one Trash item, and Undo restores it', async () => {
    const user = userEvent.setup();
    // The previous test published the version; this one needs a draft of its own.
    const fresh = await apiFor('admin').newQualityVersion();
    const before = (await apiFor('lead').requirements(fresh.id)).map((r) => r.code);
    expect(before.length).toBeGreaterThan(8);
    render(wrap(<><VersionPage versionId={fresh.id} api={apiFor('lead')} {...extra('lead')} /><UndoToaster /></>));
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete all standards in this version' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete all standards in this version?' });
    expect(dialog.textContent).toContain(`Delete all ${before.length} standards`);
    expect(dialog.textContent).toContain('You can restore them from the Trash for 30 days.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete all' }));
    await waitFor(async () => expect(await apiFor('lead').requirements(fresh.id)).toHaveLength(0));
    const toast = await screen.findByRole('status');
    expect(toast.textContent).toMatch(/^Deleted all \d+ standards in /);
    const groups = (await trashFor('lead').list()).groups;
    expect(groups[0]!.items).toHaveLength(1); // one Trash item for the whole content
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await apiFor('lead').requirements(fresh.id)).map((r) => r.code)).toEqual(before));
  });
});

describe('Trash page', () => {
  it('lists what was deleted by action, filters and searches, opens a group, and restores it', async () => {
    const lead = apiFor('lead');
    const fw = await lead.createFramework({ accreditorId: (await lead.createAccreditor({ name: 'Invented Council', shortName: 'IC', type: 'institutional' })).id, name: 'Handbook', scope: 'institution' });
    const ver = await lead.createVersion(fw.id, { edition: '2031' });
    const std = await lead.createRequirement(ver.id, { code: 'Standard 1', levelLabel: 'Standard', title: 'المعيار الأول' });
    const cfr = await lead.createRequirement(ver.id, { code: 'CFR 1.1', levelLabel: 'CFR', title: 'Mission', parentId: std.id });
    await lead.addNote(cfr.id, { type: 'guidance', text: 'Show it', authority: 'suggested' });
    const other = await lead.createRequirement(ver.id, { code: 'Standard 2', levelLabel: 'Standard', title: 'Resources' });
    await lead.deleteMany([std.id]);
    await lead.deleteMany([other.id]);

    const user = userEvent.setup();
    render(wrap(<><TrashPage api={trashFor('lead')} /><UndoToaster /></>));
    const groups = await screen.findAllByTestId('trash-group');
    // Newest first (an earlier test left one more item behind, further down).
    expect(groups.slice(0, 2).map((g) => g.textContent)).toEqual([
      expect.stringMatching(/Standard 2 · Resources.*Deleted by lead.*30 days left/s),
      expect.stringMatching(/Standard 1 · المعيار الأول.*Inside: 1 sub-item, 1 note.*Deleted by lead.*30 days left/s),
    ]);
    // Arabic keeps its direction.
    expect(within(groups[1]!).getByText(/المعيار الأول/).getAttribute('dir')).toBe('auto');
    expect(screen.getByText(/Deleted items stay here for 30 days/)).toBeTruthy();

    // Filter by kind and search.
    await user.type(screen.getByLabelText('Search the Trash'), 'resources');
    await waitFor(() => expect(screen.getAllByTestId('trash-group')).toHaveLength(1));
    expect(screen.getByTestId('trash-group').textContent).toContain('Standard 2 · Resources');
    await user.clear(screen.getByLabelText('Search the Trash'));
    await user.selectOptions(screen.getByLabelText('Kind'), 'Notes');
    expect(await screen.findByTestId('trash-empty')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Kind'), 'All kinds');

    // Open the group: the subtree.
    const g1 = (await screen.findAllByTestId('trash-group'))[1]!;
    await user.click(within(g1).getByRole('button', { name: /what is inside/ }));
    const inside = await within(g1).findByTestId('trash-contents');
    expect(inside.textContent).toContain('Standard 1 · المعيار الأول');
    expect(inside.textContent).toContain('CFR 1.1 · Mission');
    expect(inside.textContent).toContain('Note: Show it');

    // Restore: it is back in the version and out of the Trash.
    await user.click(within(g1).getByRole('button', { name: /^Restore Standard 1/ }));
    expect((await screen.findByRole('status')).textContent).toContain('Restored Standard 1');
    expect((await lead.requirements(ver.id)).map((r) => r.code).sort()).toEqual(['CFR 1.1', 'Standard 1']);
    await waitFor(() => expect(screen.getAllByTestId('trash-group')).toHaveLength(groups.length - 1));
  });

  it('removes forever after a question, empties the Trash after a question, and shows an empty state', async () => {
    const lead = apiFor('lead');
    const list = await trashFor('lead').list();
    expect(list.total).toBeGreaterThan(0);
    const user = userEvent.setup();
    render(wrap(<TrashPage api={trashFor('lead')} />));
    const first = (await screen.findAllByTestId('trash-group'))[0]!;
    await user.click(within(first).getByRole('button', { name: /forever$/ }));
    const ask = await screen.findByRole('dialog', { name: 'Delete forever?' });
    expect(ask.textContent).toContain('This cannot be undone');
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect((await trashFor('lead').list()).total).toBe(list.total);
    await user.click(within(first).getByRole('button', { name: /forever$/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete forever?' })).getByRole('button', { name: 'Delete forever' }));
    await waitFor(async () => expect((await trashFor('lead').list()).total).toBeLessThan(list.total));

    // Make sure there is something to empty, then empty it.
    const fw = (await lead.frameworks())[0]!;
    const v = await lead.createVersion(fw.id, { edition: '2032' });
    const r = await lead.createRequirement(v.id, { code: 'E1', levelLabel: 'Standard', title: 'Bin me' });
    await lead.deleteMany([r.id]);
    await user.click(await screen.findByRole('button', { name: 'Empty trash' }));
    const empty = await screen.findByRole('dialog', { name: 'Empty the Trash?' });
    await user.click(within(empty).getByRole('button', { name: 'Empty trash' }));
    expect(await screen.findByTestId('trash-empty')).toBeTruthy();
    expect(screen.getByTestId('trash-empty').textContent).toMatch(/The Trash is empty\. Things you delete wait here for 30 days\./);
    expect((screen.getByRole('button', { name: 'Empty trash' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks where to put an item whose parent is gone, and puts it where the person chooses', async () => {
    const lead = apiFor('lead');
    const fw = (await lead.frameworks())[0]!;
    const v = await lead.createVersion(fw.id, { edition: '2033' });
    const top = await lead.createRequirement(v.id, { code: 'T1', levelLabel: 'Standard', title: 'Top' });
    const child = await lead.createRequirement(v.id, { code: 'T1.1', levelLabel: 'CFR', title: 'Child', parentId: top.id });
    await lead.deleteMany([child.id]);
    await lead.deleteMany([top.id]);
    const user = userEvent.setup();
    render(wrap(<TrashPage api={trashFor('lead')} />));
    const rows = await screen.findAllByTestId('trash-group');
    const childGroup = rows.find((g) => g.textContent?.includes('T1.1'))!;
    await user.click(within(childGroup).getByRole('button', { name: /^Restore T1\.1/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Where should it go?' });
    expect(dialog.textContent).toContain('T1 · Top no longer exists');
    expect(within(dialog).queryByRole('button', { name: /Put it under/ })).toBeNull(); // nothing above it is left
    await user.click(within(dialog).getByRole('button', { name: 'Put it at the top level' }));
    await waitFor(async () => expect((await lead.requirements(v.id)).map((r) => [r.code, r.parentId])).toEqual([['T1.1', null]]));
    expect((await screen.findByRole('status')).textContent).toContain('Placed under the top level');
  });

  it('is a Settings page for people who can delete; a viewer\'s Trash is empty', async () => {
    render(wrap(<TrashPage api={trashFor('viewer')} />));
    expect(await screen.findByTestId('trash-empty')).toBeTruthy();
  });
});

describe('Settings menu', () => {
  it('lists Trash with the number of items for people who can delete, and not for others', async () => {
    const lead = apiFor('lead');
    const fw = (await lead.frameworks())[0]!;
    const v = await lead.createVersion(fw.id, { edition: '2034' });
    const r = await lead.createRequirement(v.id, { code: 'M1', levelLabel: 'Standard', title: 'For the badge' });
    await lead.deleteMany([r.id]);
    render(wrap(<SettingsLayout api={settingsApi(apiOf('lead'))} trashApi={trashFor('lead')} />));
    const link = await screen.findByRole('link', { name: /^Trash/ });
    await waitFor(() => expect(link.textContent).toMatch(/^Trash\d+$/));
    expect(link.getAttribute('title')).toContain('30 days');
    cleanup();
    render(wrap(<SettingsLayout api={settingsApi(apiOf('viewer'))} trashApi={trashFor('viewer')} />));
    await screen.findByRole('link', { name: 'Organization' });
    expect(screen.queryByRole('link', { name: /^Trash/ })).toBeNull();
  });
});
