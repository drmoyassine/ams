// @vitest-environment jsdom
// Multi-select, bulk delete, drag and drop and the keyboard model of the requirement trees, in the browser, against the
// real API and database: the institution's quality framework screen and an external standard's requirements. Nothing
// touches the network. (A real pointer drag needs layout, which jsdom does not have; the keyboard sensor of dnd-kit does
// not, so the drop itself is driven that way, and the geometry is covered by the pure tests in lib/tree-dnd.test.ts.)
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore, seedFrameworks } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { resetConfirmForTests } from './components/confirm-dialog';
import { UndoToaster } from './components/undo-toaster';
import { treeProbe } from './components/tree/tree';
import { createApi } from './lib/api';
import { frameworkApi } from './lib/framework-api';
import { glossaryApi } from './lib/glossary-api';
import { settingsApi } from './lib/settings-api';
import { resetUndoForTests } from './lib/undo';
import { QualityFrameworkPage } from './pages/settings/quality-framework';
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
const extra = (who: string) => ({ glossary: glossaryApi(apiOf(who)), settings: settingsApi(apiOf(who)) });
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const quality = (who = 'lead') => <><QualityFrameworkPage api={apiFor(who)} {...extra(who)} /><UndoToaster /></>;
const external = (v: string, who = 'lead') => <><VersionPage versionId={v} api={apiFor(who)} onOpenVersion={() => undefined} {...extra(who)} /><UndoToaster /></>;
const card = (name: string) => screen.findByRole('region', { name });
const checkboxOf = async (name: string) => within(await card(name)).getByRole('checkbox');
const headerOf = async (name: string) => (await card(name)).querySelector<HTMLElement>('[data-tree-focus]')!;
const toasts = () => screen.queryAllByTestId('toast');
const live = () => screen.getByTestId('tree-live').textContent;

let editions = 0;
/** An external draft:  S1 (S1.1, S1.2, S1.3) · S2 (S2.1) · S3 · S4 */
async function external4() {
  const lead = apiFor('lead');
  ids.acc ??= (await lead.createAccreditor({ name: 'Invented Council', shortName: 'IC', type: 'institutional' })).id;
  editions += 1;
  const fw = await lead.createFramework({ accreditorId: ids.acc, name: `Handbook ${editions}`, scope: 'institution' });
  const v = await lead.createVersion(fw.id, { edition: `t${editions}` });
  const mk = (code: string, order: number, parentId?: string) => lead.createRequirement(v.id, { code, levelLabel: 'Standard', title: `Title ${code}`, displayOrder: order, ...(parentId ? { parentId } : {}) });
  const s1 = await mk('S1', 0);
  const r = { v: v.id, s1: s1.id, s11: (await mk('S1.1', 0, s1.id)).id, s12: (await mk('S1.2', 1, s1.id)).id, s13: (await mk('S1.3', 2, s1.id)).id } as Record<string, string>;
  const s2 = await mk('S2', 1);
  r.s2 = s2.id; r.s21 = (await mk('S2.1', 0, s2.id)).id;
  r.s3 = (await mk('S3', 2)).id; r.s4 = (await mk('S4', 3)).id;
  resetUndoForTests(); // building the fixture through the client made Undo toasts
  return r as { v: string; s1: string; s11: string; s12: string; s13: string; s2: string; s21: string; s3: string; s4: string };
}
/** The tree as text: S1(S1.1,S1.2,S1.3) S2(S2.1) S3 S4 */
async function shape(v: string) {
  const rows = await apiFor('lead').requirements(v);
  const kids = (p: string | null) => rows.filter((r) => (r.parentId ?? null) === p);
  const fmt = (p: string | null): string => kids(p).map((r) => (kids(r.id).length ? `${r.code}(${fmt(r.id)})` : r.code)).join(p === null ? ' ' : ',');
  return fmt(null);
}
const START = 'S1(S1.1,S1.2,S1.3) S2(S2.1) S3 S4';

beforeAll(async () => {
  db = await createTestDb('webtree');
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
  ids.iqf = (await apiFor('lead').setUpQualityFramework({ template: true })).versions[0]!.id;
}, 60000);
afterEach(() => { resetConfirmForTests(); cleanup(); resetUndoForTests(); treeProbe.row = null; treeProbe.card = null; vi.restoreAllMocks(); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('multi-select and bulk delete (the quality framework)', () => {
  it('Select shows the checkboxes, ticks with the mouse and modifiers, and the bar counts what comes along', async () => {
    const user = userEvent.setup();
    render(wrap(quality()));
    await card('Standard 1.0');
    // Before Select mode the bar is not there, and Select is a toggle.
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
    const select = screen.getByRole('button', { name: 'Select' });
    expect(select.getAttribute('aria-pressed')).toBe('false');

    await user.click(await checkboxOf('Standard 1.0'));
    expect(select.getAttribute('aria-pressed')).toBe('false'); // ticking a box does not switch Select mode on: rows still open when clicked
    const parentSubs = (await apiFor('lead').requirements(ids.iqf!)).filter((r) => r.parentId && r.code.startsWith('1.')).length;
    expect(screen.getByTestId('bulk-count').textContent).toBe(`1 selected, with ${parentSubs} sub-item${parentSubs === 1 ? '' : 's'}`);
    expect((await checkboxOf('Standard 1.0')).getAttribute('aria-label')).toBe(`Deselect 1, with its ${parentSubs} sub-item${parentSubs === 1 ? '' : 's'}`);

    // Ctrl-click on a card toggles it without opening it; shift-click takes the range.
    const h3 = await headerOf('Standard 3.0');
    fireEvent.click(h3, { ctrlKey: true });
    expect((await checkboxOf('Standard 3.0') as HTMLInputElement).checked).toBe(true);
    expect(h3.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(await headerOf('Standard 5.0'), { shiftKey: true });
    for (const n of ['3.0', '4.0', '5.0']) expect((await checkboxOf(`Standard ${n}`) as HTMLInputElement).checked).toBe(true);
    expect((await checkboxOf('Standard 2.0') as HTMLInputElement).checked).toBe(false);

    // Select all, then Clear.
    await user.click(screen.getByRole('button', { name: /^Select all \(/ }));
    expect(screen.getByTestId('bulk-count').textContent).toMatch(/^\d+ selected, with \d+ sub-items$/);
    await user.click(within(screen.getByTestId('bulk-bar')).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
    expect((await checkboxOf('Standard 3.0') as HTMLInputElement).checked).toBe(false);
  });

  it('deletes the selection after the server\'s question, as one action with one Undo, keeping the other selection state', async () => {
    const user = userEvent.setup();
    const before = (await apiFor('lead').requirements(ids.iqf!)).map((r) => r.code);
    render(wrap(quality()));
    await card('Standard 7.0');
    await user.click(await checkboxOf('Standard 7.0'));
    await user.click(await checkboxOf('Standard 8.0'));
    // A sub-standard under a selected standard counts once.
    await user.click(await checkboxOf('Standard 8.1'));
    const preview = await apiFor('lead').previewDelete([...(await apiFor('lead').requirements(ids.iqf!)).filter((r) => ['7', '8'].includes(r.code)).map((r) => r.id)]);
    await user.click(within(screen.getByTestId('bulk-bar')).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete 2 standards?' });
    expect(dialog.textContent).toContain(preview.message);
    expect(dialog.textContent).toMatch(/^Delete 2 standards\?.*Delete 7, 8 and their \d+ sub-items?\? You can restore them from the Trash for 30 days\./);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect((await apiFor('lead').requirements(ids.iqf!)).map((r) => r.code)).toEqual(before);
    expect(screen.getByTestId('bulk-bar')).toBeTruthy(); // cancelling keeps the selection

    await user.click(within(screen.getByTestId('bulk-bar')).getByRole('button', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Standard 7.0' })).toBeNull());
    expect(screen.queryByRole('region', { name: 'Standard 8.1' })).toBeNull();
    expect(screen.queryByTestId('bulk-bar')).toBeNull(); // selection cleared
    // One toast, one Undo.
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.textContent).toMatch(/^Deleted 7, 8 and \d+ sub-itemsUndo/);
    await user.click(within(toasts()[0]!).getByRole('button', { name: 'Undo' }));
    expect(await card('Standard 7.0')).toBeTruthy();
    expect(await card('Standard 8.1')).toBeTruthy();
    expect((await apiFor('lead').requirements(ids.iqf!)).map((r) => r.code)).toEqual(before);
  });

  it('works from the keyboard: Space ticks, Shift+arrow extends, Delete asks, Escape clears', async () => {
    const user = userEvent.setup();
    render(wrap(quality()));
    await card('Standard 1.0');
    const first = await headerOf('Standard 1.0');
    // Roving tabindex: one stop in the whole tree, the first row until the keyboard has moved.
    const stops = document.querySelectorAll('[data-tree-focus][tabindex="0"]');
    expect(stops).toHaveLength(1);
    first.focus();
    await user.keyboard(' ');
    expect((await checkboxOf('Standard 1.0') as HTMLInputElement).checked).toBe(true);
    expect(first.getAttribute('aria-expanded')).toBe('false'); // space ticks; it did not open the card
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    const second = document.activeElement as HTMLElement;
    expect(second.getAttribute('data-tree-focus')).not.toBe(first.getAttribute('data-tree-focus'));
    expect(screen.getByTestId('bulk-count').textContent).toMatch(/^2 selected/);
    // Enter still opens the card under the keyboard.
    await user.keyboard('{Enter}');
    expect(second.getAttribute('aria-expanded')).toBe('true');
    // Delete opens the same question for the selection; Escape in it changes nothing.
    await user.keyboard('{Delete}');
    expect(await screen.findByRole('dialog', { name: /^Delete (Standard )?1.*\?$|^Delete 1 standard\?$/ })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('bulk-bar')).toBeTruthy();
    (document.activeElement as HTMLElement | null)?.blur();
    second.focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
  });

  it('shows no checkboxes or handles to a viewer, or on a published version, and says why', async () => {
    const { unmount } = render(wrap(quality('viewer')));
    await card('Standard 1.0');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByTestId('drag-handle')).toHaveLength(0);
    const select = screen.getByRole('button', { name: 'Select' }) as HTMLButtonElement;
    expect(select.disabled).toBe(true);
    expect(select.title).toMatch(/permission/);
    unmount();

    // A published version is fixed for everyone.
    const lead = apiFor('admin');
    const fresh = (await lead.qualityFramework()).versions[0]!;
    await lead.publishQuality(fresh.id);
    render(wrap(quality('lead')));
    await card('Standard 1.0');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByTestId('drag-handle')).toHaveLength(0);
    expect((screen.getByRole('button', { name: 'Select' }) as HTMLButtonElement).title).toMatch(/published and fixed/);
    expect(screen.getByText(/is published and fixed\. Start a new version to select, move or delete standards\./)).toBeTruthy();
    // Start the next draft for the tests that follow.
    ids.iqf = (await apiFor('admin').newQualityVersion()).id;
  });

  it('"Delete all standards in this version" is in the framework\'s menu, on a draft only, with the same question and Undo', async () => {
    const user = userEvent.setup();
    const before = (await apiFor('lead').requirements(ids.iqf!)).map((r) => r.code);
    expect(before.length).toBeGreaterThan(8);
    render(wrap(quality()));
    await card('Standard 1.0');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete all standards in this version' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete all standards in this version?' });
    expect(dialog.textContent).toMatch(/Delete all \d+ standards.* You can restore them from the Trash for 30 days\./);
    await user.click(within(dialog).getByRole('button', { name: 'Delete all' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Standard 1.0' })).toBeNull());
    expect(await apiFor('lead').requirements(ids.iqf!)).toHaveLength(0);
    await user.click(within(await screen.findByTestId('toast')).getByRole('button', { name: 'Undo' }));
    expect(await card('Standard 1.0')).toBeTruthy();
    expect((await apiFor('lead').requirements(ids.iqf!)).map((r) => r.code)).toEqual(before);
  });
});

describe('drag and drop with the keyboard (an external standard)', () => {
  const handle = async (name: string) => within(await card(name)).getByRole('button', { name: new RegExp(`^Move ${name.replace('.', '\\.')}$`) });

  it('Space picks up, arrows choose a place in words, Space drops; one Undo toast; the selection stays', async () => {
    const user = userEvent.setup();
    const x = await external4();
    render(wrap(external(x.v)));
    await card('S3');
    // Tick S4 first: the selection must survive a drop.
    await user.click(within(await card('S4')).getByRole('checkbox'));
    const h = await handle('S3');
    h.focus();
    await user.keyboard(' ');
    expect(live()).toMatch(/^Picked up S3\. \d+ places to choose from\. Use the up and down arrow keys, space to drop, escape to cancel\.$/);
    await user.keyboard('{ArrowUp}'); // from "where it is" to the place before it
    await user.keyboard('{ArrowUp}');
    expect(live()).toMatch(/^Put S3 /);
    // Walk to "inside S2".
    for (let i = 0; i < 6 && !/inside S2, as the last/.test(live() ?? ''); i += 1) await user.keyboard('{ArrowUp}');
    if (!/inside S2, as the last/.test(live() ?? '')) for (let i = 0; i < 8 && !/inside S2, as the last/.test(live() ?? ''); i += 1) await user.keyboard('{ArrowDown}');
    expect(live()).toMatch(/^Put S3 inside S2, as the last sub-item\. \(\d+ of \d+\)$/);
    await user.keyboard(' ');
    await waitFor(async () => expect(await shape(x.v)).toBe('S1(S1.1,S1.2,S1.3) S2(S2.1,S3) S4'));
    // The result is said, with the codes left alone, and offered back.
    expect(await screen.findByTestId('tree-live')).toBeTruthy();
    await waitFor(() => expect(live()).toBe('Moved S3 under S2. Codes are not renumbered.'));
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toMatch(/^Moved S3 under S2Undo/);
    expect((await apiFor('lead').requirements(x.v)).find((r) => r.id === x.s3)!.code).toBe('S3');
    // Selection and expansion are kept.
    expect((within(await card('S4')).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    // The row now sits under S2 on screen.
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Items of S2' })).getByRole('region', { name: 'S3' })).toBeTruthy());
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await shape(x.v)).toBe(START));
  });

  it('Escape cancels and leaves everything where it was', async () => {
    const user = userEvent.setup();
    const x = await external4();
    render(wrap(external(x.v)));
    const h = await handle('S4');
    h.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(live()).toMatch(/^Move cancelled\. S4 stayed where it was\.$/));
    expect(await shape(x.v)).toBe(START);
    expect(toasts()).toHaveLength(0);
    // Dropping where it already is changes nothing either.
    h.focus();
    await user.keyboard(' ');
    await user.keyboard(' ');
    await waitFor(() => expect(live()).toBe('Nothing changed: it was dropped where it already is.'));
    expect(toasts()).toHaveLength(0);
  });

  it('moves the ticked rows together when one of them is picked up, keeping their order', async () => {
    const user = userEvent.setup();
    const x = await external4();
    render(wrap(external(x.v)));
    await user.click(within(await card('S3')).getByRole('checkbox'));
    await user.click(within(await card('S4')).getByRole('checkbox'));
    const h = await handle('S4');
    h.focus();
    await user.keyboard(' ');
    expect(live()).toMatch(/^Picked up 2 items\./);
    for (let i = 0; i < 12 && !/^Put 2 items inside S1, as the last/.test(live() ?? ''); i += 1) await user.keyboard('{ArrowUp}');
    expect(live()).toMatch(/^Put 2 items inside S1, as the last sub-item\./);
    await user.keyboard(' ');
    await waitFor(async () => expect(await shape(x.v)).toBe('S1(S1.1,S1.2,S1.3,S3,S4) S2(S2.1)'));
    expect((await screen.findByTestId('toast')).textContent).toMatch(/^Moved S3, S4 under S1Undo/);
    await user.click(within(screen.getByTestId('toast')).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await shape(x.v)).toBe(START)); // both back, in their places
  });

  it('shows the server\'s message and puts the tree back when the server refuses a drop', async () => {
    const user = userEvent.setup();
    const x = await external4();
    render(wrap(external(x.v)));
    const h = await handle('S3');
    await card('S2');
    h.focus();
    await user.keyboard(' ');
    for (let i = 0; i < 12 && !/inside S2, as the last/.test(live() ?? ''); i += 1) await user.keyboard('{ArrowUp}');
    expect(live()).toMatch(/inside S2, as the last/);
    // Meanwhile S2 is deleted by someone else: the screen does not know yet.
    await db.su.query(`delete from requirement where id in ($1, $2)`, [x.s21, x.s2]);
    await user.keyboard(' ');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/not in this version any more/);
    expect(toasts()).toHaveLength(0);
    // The list is as it was on screen (rolled back), and the server unchanged.
    expect(await shape(x.v)).toBe('S1(S1.1,S1.2,S1.3) S3 S4');
  });

  it('refuses a drop into the item\'s own sub-items while choosing, in words', async () => {
    const user = userEvent.setup();
    const x = await external4();
    render(wrap(external(x.v)));
    await card('S1');
    const h = await handle('S1');
    h.focus();
    await user.keyboard(' ');
    // No place is offered inside S1 or its sub-items.
    for (let i = 0; i < 30; i += 1) {
      await user.keyboard('{ArrowDown}');
      expect(live()).not.toMatch(/S1\.[123]|inside S1,/);
    }
    await user.keyboard('{Escape}');
  });

  it('is off for a viewer: no handles', async () => {
    const x = await external4();
    render(wrap(external(x.v, 'viewer')));
    await card('S1');
    expect(screen.queryAllByTestId('drag-handle')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

describe('Move to… and branches', () => {
  it('moves the selection under a chosen requirement in one action, with the refusal shown in the dialog', async () => {
    const user = userEvent.setup();
    const x = await external4();
    render(wrap(external(x.v)));
    await user.click(within(await card('S3')).getByRole('checkbox'));
    await user.click(within(await card('S4')).getByRole('checkbox'));
    await user.click(within(screen.getByTestId('bulk-bar')).getByRole('button', { name: 'Move to…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move 2 items' });
    // The selected rows are not offered as a new parent.
    const options = within(dialog).getAllByRole('option').map((o) => o.textContent);
    expect(options.some((t) => /S3|S4/.test(t ?? ''))).toBe(false);
    await user.click(within(within(dialog).getByRole('option', { name: /S2 ·/ })).getByRole('button'));
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(async () => expect(await shape(x.v)).toBe('S1(S1.1,S1.2,S1.3) S2(S2.1,S3,S4)'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toasts()[0]!.textContent).toMatch(/^Moved S3, S4 under S2Undo/);
  });

  it('hides and shows the sub-items of a branch, from the button and the arrow keys', async () => {
    const user = userEvent.setup();
    const x = await external4();
    render(wrap(external(x.v)));
    await card('S1.2');
    await user.click(within(await card('S1')).getByRole('button', { name: 'Hide the 3 sub-items of S1' }));
    expect(screen.queryByRole('region', { name: 'S1.2' })).toBeNull();
    expect(within(await card('S1')).getByTestId('collapsed-count').textContent).toBe('3');
    // Select all counts what is shown.
    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(screen.getByRole('button', { name: /^Select all \(\d+\)$/ }).textContent).toBe('Select all (5)');
    // ArrowRight on the focused collapsed row shows them again; ArrowLeft hides them.
    (await headerOf('S1')).focus();
    await user.keyboard('{ArrowRight}');
    expect(await card('S1.2')).toBeTruthy();
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'S1.2' })).toBeNull());
  });

  it('does not take the "n" key from the split view, and ticking leaves the card closed', async () => {
    const user = userEvent.setup();
    const x = await external4();
    render(wrap(external(x.v)));
    const h = await headerOf('S3');
    h.focus();
    await user.keyboard(' ');
    expect(h.getAttribute('aria-expanded')).toBe('false');
    expect((within(await card('S3')).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    await user.keyboard('n'); // the next-item shortcut is still its own (there is nothing flagged here, so it does nothing)
    expect((within(await card('S3')).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('bulk-count').textContent).toBe('1 selected');
  });
});

describe('a tree of 600 rows stays responsive', () => {
  it('ticking a row or moving the drop target re-renders only the rows involved', async () => {
    const user = userEvent.setup();
    const lead = apiFor('lead');
    const fw = await lead.createFramework({ accreditorId: ids.acc!, name: 'Big', scope: 'institution' });
    const v = await lead.createVersion(fw.id, { edition: 'big' });
    // 30 standards of 19 sub-items each = 600 rows, inserted directly (a test fixture, not a user path).
    await db.su.query(`
      with tops as (
        insert into requirement (institution_id, framework_version_id, code, level_label, title, display_order, origin)
        select $1, $2, 'T' || i, 'Standard', 'Top ' || i, i, 'manual' from generate_series(0, 29) i returning id, code, display_order)
      insert into requirement (institution_id, framework_version_id, parent_id, code, level_label, title, display_order, origin)
      select $1, $2, t.id, t.code || '.' || j, 'Criterion', 'Sub ' || t.code || '.' || j, j, 'manual' from tops t, generate_series(0, 18) j`, [ids.inst, v.id]);
    const total = (await lead.requirements(v.id)).length;
    expect(total).toBe(600);

    const renders = new Map<string, number>();
    const cards = new Map<string, number>();
    treeProbe.row = (id) => renders.set(id, (renders.get(id) ?? 0) + 1);
    treeProbe.card = (id) => cards.set(id, (cards.get(id) ?? 0) + 1);
    const t0 = performance.now();
    render(wrap(external(v.id)));
    await card('T29.18');
    const mount = performance.now() - t0;
    expect(renders.size).toBe(600);
    await screen.findByText('Needs a look'); // everything the screen loads has arrived
    await new Promise((r) => setTimeout(r, 300));
    const box = (name: string) => card(name).then((c) => c.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    const [a, b, c] = [await box('T5.7'), await box('T6.2'), await box('T7.3')];
    const handle = within(await card('T10.4')).getByRole('button', { name: 'Move T10.4' });

    const time = async (what: () => Promise<unknown>) => { renders.clear(); cards.clear(); const t = performance.now(); await what(); return { ms: performance.now() - t, rows: renders.size, cards: cards.size }; };
    const first = await time(() => user.click(a));      // Select mode turns on: every row learns that once
    const second = await time(() => user.click(b));      // from now on a tick costs one row (and the one that held the keyboard stop)
    expect(second.rows).toBeLessThanOrEqual(3);
    expect(second.cards).toBeLessThanOrEqual(3);
    const third = await time(() => user.click(c));
    expect(third.rows).toBeLessThanOrEqual(3);
    const allBtn = screen.getByRole('button', { name: /^Select all \(/ });
    const all = await time(async () => { fireEvent.click(allBtn); });
    expect(screen.getByTestId('bulk-count').textContent).toMatch(/^600 selected/);
    const none = await time(() => user.click(within(screen.getByTestId('bulk-bar')).getByRole('button', { name: 'Clear' })));

    // Dragging: pick up, then move the drop target through places (what a pointer does as it crosses rows).
    handle.focus();
    const pick = await time(() => user.keyboard(' '));
    const steps: number[] = [];
    let worst = 0;
    let cardsInSteps = 0;
    for (let n = 0; n < 8; n += 1) {
      const step = await time(() => user.keyboard('{ArrowDown}'));
      steps.push(step.rows);
      cardsInSteps += step.cards;
      worst = Math.max(worst, step.ms);
      expect(step.cards).toBe(0); // no card (the heavy part of a row) renders again while the drop target moves
    }
    const drop = await time(() => user.keyboard('{Escape}'));
    console.log(`[perf] 600 rows in jsdom: mount ${mount.toFixed(0)} ms; first tick ${first.ms.toFixed(0)} ms (${first.rows} rows); next ticks ${second.ms.toFixed(0)} / ${third.ms.toFixed(0)} ms (${second.rows} / ${third.rows} rows); select all ${all.ms.toFixed(0)} ms (${all.rows} rows); clear ${none.ms.toFixed(0)} ms; pick up ${pick.ms.toFixed(0)} ms (${pick.rows} rows); drop target steps re-render ${steps.join(',')} row wrappers and ${cardsInSteps} cards (slowest ${worst.toFixed(0)} ms); cancel ${drop.ms.toFixed(0)} ms (${drop.rows} rows)`);
    expect(mount).toBeLessThan(20000);
  }, 180000);
});
