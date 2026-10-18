// @vitest-environment jsdom
// The org chart builder in the browser (TASK-072), against the real API and database: the Tree view (rows, keyboard drag and
// drop, multi-select, bulk delete with Undo, the refusal for units with programs), the unit drawer, the Unit types manager,
// the Chart view (render, zoom, collapse, open, export, print, right-to-left), and the read-only role. A real pointer drag
// needs layout, which jsdom does not have; the keyboard sensor of dnd-kit does not, so drops are driven that way and the
// geometry is covered by lib/tree-dnd.test.ts. Nothing touches the network.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { resetConfirmForTests } from './components/confirm-dialog';
import { UndoToaster } from './components/undo-toaster';
import { createApi } from './lib/api';
import { settingsApi, type SettingsApi } from './lib/settings-api';
import { resetUndoForTests } from './lib/undo';
import { OrgChartSection, type ChartExporters } from './pages/settings/org-chart/org-chart-section';
import { OrganizationPage } from './pages/settings/organization';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const apiFor = (who: string): SettingsApi => { const f = ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch; return settingsApi(createApi(f), f); };
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const exporters = (): ChartExporters => ({ png: vi.fn(async () => new Blob(['png'], { type: 'image/png' })), save: vi.fn(), print: vi.fn() });
const section = (who = 'admin', view: 'tree' | 'chart' = 'tree', ex: ChartExporters = exporters(), onOpenPrograms = () => undefined) =>
  <><OrgChartSection api={apiFor(who)} canEdit={who !== 'viewer'} onOpenPrograms={onOpenPrograms} exporters={ex} initialView={view} /><UndoToaster /></>;
const live = () => screen.getByTestId('tree-live').textContent;
const chartLive = () => screen.getByTestId('chart-live').textContent;
const chartBox = (name: string) => screen.getAllByTestId('chart-box').find((b) => b.getAttribute('aria-label')!.startsWith(`${name},`)) as HTMLElement;
/** The middle of a box in client coordinates (jsdom has no layout: the viewport is at 0,0 and the chart is not fitted, so 1:1). */
const centre = (name: string): [number, number] => {
  const [x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(chartBox(name).getAttribute('transform')!)!.slice(1).map(Number) as [number, number];
  return [x + 104, y + 36];
};
const xy = (x: number, y: number) => ({ clientX: x, clientY: y });
/** A pointer drag from the middle of a box to a point, in steps (and the release, unless `up` is false). */
function dragBox(name: string, x: number, y: number, { up = true } = {}) {
  const [x0, y0] = centre(name);
  const vp = screen.getByTestId('chart-viewport');
  fireEvent.pointerDown(chartBox(name), { pointerId: 1, button: 0, pointerType: 'mouse', ...xy(x0, y0) });
  for (let i = 1; i <= 4; i += 1) fireEvent.pointerMove(vp, { pointerId: 1, pointerType: 'mouse', ...xy(x0 + ((x - x0) * i) / 4, y0 + ((y - y0) * i) / 4) });
  if (up) fireEvent.pointerUp(vp, { pointerId: 1, pointerType: 'mouse', ...xy(x, y) });
}
const rowOf = async (name: string) => (await screen.findByLabelText(`Open ${name}`)).closest('[data-testid="org-unit"]') as HTMLElement;

/** A shape string from the API: "Arts(Dept1,Dept2) Science Engineering" */
async function shape() {
  const { units } = await apiFor('admin').orgChart();
  const kids = (p: string | null) => units.filter((u) => u.parentId === p);
  const fmt = (p: string | null): string => kids(p).map((u) => (kids(u.id).length ? `${u.nameEn}(${fmt(u.id)})` : u.nameEn)).join(p === null ? ' ' : ',');
  return fmt(null);
}
const START = 'Arts(Dept1,Dept2) Science Engineering(Mech)';

beforeAll(async () => {
  db = await createTestDb('weborgchart');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'viewer', 'Dr Head']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  const admin = apiFor('admin');
  const arts = await admin.createOrgUnit({ type: 'college', nameEn: 'Arts', nameAr: 'كلية الآداب' });
  ids.arts = arts.id;
  ids.d1 = (await admin.createOrgUnit({ parentId: arts.id, type: 'department', nameEn: 'Dept1' })).id;
  ids.d2 = (await admin.createOrgUnit({ parentId: arts.id, type: 'department', nameEn: 'Dept2' })).id;
  ids.sci = (await admin.createOrgUnit({ type: 'college', nameEn: 'Science' })).id;
  ids.eng = (await admin.createOrgUnit({ type: 'college', nameEn: 'Engineering' })).id;
  ids.mech = (await admin.createOrgUnit({ parentId: ids.eng, type: 'department', nameEn: 'Mech' })).id;
  await admin.updateOrgUnit(ids.arts!, { headUserId: ids['Dr Head']!, locked: true });
  await db.su.query(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BS Mechanical', 'bachelor')`, [ids.inst, ids.mech]);
}, 60000);
afterEach(() => { resetConfirmForTests(); cleanup(); resetUndoForTests(); document.documentElement.style.direction = ''; document.body.className = ''; vi.restoreAllMocks(); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('Tree view', () => {
  it('shows each unit with its names (Arabic beneath, direction auto), type, head, programs, lock and source', async () => {
    render(wrap(section()));
    const arts = await rowOf('Arts');
    expect(within(arts).getByText('كلية الآداب').getAttribute('dir')).toBe('auto');
    expect(within(arts).getByTestId('unit-type-chip').textContent).toBe('College');
    expect(within(arts).getByTestId('unit-head').textContent).toBe('Head: Dr Head');
    expect(within(arts).getByTestId('unit-programs-count').textContent).toBe('0 programs');
    expect(within(arts).getByRole('img', { name: 'Locked' })).toBeTruthy();
    expect(within(arts).getByTestId('unit-source').textContent).toBe('manual');
    expect((await rowOf('Mech')).querySelector('[data-testid="unit-programs-count"]')!.textContent).toBe('1 program');
    expect((await rowOf('Dept1')).getAttribute('data-depth')).toBe('1');
    expect(within(await rowOf('Dept1')).queryByRole('img', { name: 'Locked' })).toBeNull();
    // The view switch is a toggle; Tree is on, and both are buttons reachable by keyboard.
    expect(screen.getByRole('button', { name: 'Tree' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Chart' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('collapses and expands a branch', async () => {
    const user = userEvent.setup();
    render(wrap(section()));
    await rowOf('Dept1');
    await user.click(screen.getByRole('button', { name: /^Hide the 2 sub-items of Arts/ }));
    expect(screen.queryByLabelText('Open Dept1')).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Show the 2 sub-items of Arts/ }));
    expect(await screen.findByLabelText('Open Dept1')).toBeTruthy();
  });

  it('moves a unit with the keyboard: Space picks up, arrows choose a place in words, Space drops; one Undo and a Redo', async () => {
    const user = userEvent.setup();
    render(wrap(section()));
    await rowOf('Science');
    const handle = screen.getByRole('button', { name: 'Move Science' });
    handle.focus();
    await user.keyboard(' ');
    expect(live()).toMatch(/^Picked up Science\. \d+ places to choose from/);
    for (let i = 0; i < 14 && !/inside Arts, as the last sub-item/.test(live() ?? ''); i += 1) await user.keyboard('{ArrowUp}');
    expect(live()).toMatch(/^Put Science inside Arts, as the last sub-item\./);
    await user.keyboard(' ');
    await waitFor(async () => expect(await shape()).toBe('Arts(Dept1,Dept2,Science) Engineering(Mech)'));
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toMatch(/^Moved Science under ArtsUndo/);
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Sub-units of Arts' })).getByLabelText('Open Science')).toBeTruthy());
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await shape()).toBe(START));
    // The Undo's answer is a Redo.
    const redo = await screen.findByRole('button', { name: 'Redo' });
    await user.click(redo);
    await waitFor(async () => expect(await shape()).toBe('Arts(Dept1,Dept2,Science) Engineering(Mech)'));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await shape()).toBe(START));
  });

  it('refuses a drop into a unit\'s own sub-units while choosing, in words, and Escape cancels', async () => {
    const user = userEvent.setup();
    render(wrap(section()));
    await rowOf('Arts');
    screen.getByRole('button', { name: 'Move Arts' }).focus();
    await user.keyboard(' ');
    // Places inside Arts' own branch are not offered at all (the slot list leaves them out).
    for (let i = 0; i < 12; i += 1) { await user.keyboard('{ArrowDown}'); expect(live()).not.toMatch(/inside Dept/); }
    await user.keyboard('{Escape}');
    await waitFor(() => expect(live()).toMatch(/^Move cancelled\. Arts stayed where it was\./));
    expect(await shape()).toBe(START);
  });

  it('ticks units, deletes them after the server\'s question as one action with one Undo; programs block it with their names', async () => {
    const user = userEvent.setup();
    render(wrap(section()));
    await rowOf('Science');
    await user.click(within(await rowOf('Science')).getByRole('checkbox'));
    await user.click(within(await rowOf('Dept2')).getByRole('checkbox'));
    expect(screen.getByTestId('bulk-count').textContent).toBe('2 selected');
    await user.click(within(screen.getByTestId('bulk-bar')).getByRole('button', { name: 'Delete' }));
    let dialog = await screen.findByRole('dialog', { name: 'Delete 2 units?' });
    expect(dialog.textContent).toMatch(/Delete Dept2, Science\? You can restore them from the Trash for 30 days\./);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await shape()).toBe(START);
    await user.click(within(screen.getByTestId('bulk-bar')).getByRole('button', { name: 'Delete' }));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(async () => expect(await shape()).toBe('Arts(Dept1) Engineering(Mech)'));
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toMatch(/^Deleted Dept2, ScienceUndo/);
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await shape()).toBe(START));

    // Engineering has a program in Mech: refused, with the program named, nothing changes.
    await user.click(within(await rowOf('Engineering')).getByRole('checkbox'));
    await user.click(within(screen.getByTestId('bulk-bar')).getByRole('button', { name: 'Delete' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/BS Mechanical \(in Mech\).*Move or reassign it to another unit first/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await shape()).toBe(START);
  });

  it('works from the keyboard: Space ticks, Escape clears', async () => {
    const user = userEvent.setup();
    render(wrap(section()));
    const open = await screen.findByLabelText('Open Science');
    open.focus();
    await user.keyboard(' ');
    expect(screen.getByTestId('bulk-count').textContent).toBe('1 selected');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
  });
});

describe('the unit drawer', () => {
  it('edits names, type, head, description and lock, sends only what changed, and offers Undo', async () => {
    const user = userEvent.setup();
    render(wrap(section()));
    await user.click(await screen.findByLabelText('Open Dept1'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Unit name (Arabic)').getAttribute('dir')).toBe('auto');
    await user.type(within(dialog).getByLabelText('Unit name (Arabic)'), 'قسم الأول');
    await user.selectOptions(within(dialog).getByLabelText('Unit type'), 'school');
    await waitFor(() => expect(within(dialog).getByLabelText('Head (person)').querySelectorAll('option').length).toBeGreaterThan(1));
    await user.selectOptions(within(dialog).getByLabelText('Head (person)'), ids['Dr Head']!);
    expect((within(dialog).getByLabelText('Head (name)') as HTMLInputElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Description'), 'Teaches things');
    await user.click(within(dialog).getByLabelText('Locked'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const u = (await apiFor('admin').orgChart()).units.find((x) => x.id === ids.d1)!;
    expect(u).toMatchObject({ nameAr: 'قسم الأول', type: 'school', headUserId: ids['Dr Head'], description: 'Teaches things', locked: true, editedByPerson: true });
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toMatch(/^Edited Dept1Undo/);
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await apiFor('admin').orgChart()).units.find((x) => x.id === ids.d1)).toMatchObject({ nameAr: null, type: 'department', headUserId: null, locked: false }));
  });

  it('takes a head who is not a user as a typed name, and clears the person', async () => {
    const user = userEvent.setup();
    render(wrap(section()));
    await user.click(await screen.findByLabelText('Open Dept2'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Head (name)'), 'Dr X');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await apiFor('admin').orgChart()).units.find((x) => x.id === ids.d2)).toMatchObject({ headName: 'Dr X', headUserId: null }));
    expect(await within(await rowOf('Dept2')).findByTestId('unit-head')).toBeTruthy();
    expect(within(await rowOf('Dept2')).getByTestId('unit-head').textContent).toBe('Head: Dr X');
  });

  it('adds a unit as a root and under a parent, and lists a unit\'s programs with a link to the Programs tab', async () => {
    const user = userEvent.setup();
    const toPrograms = vi.fn();
    render(wrap(section('admin', 'tree', exporters(), toPrograms)));
    await user.click(await screen.findByLabelText('Add a unit under Science'));
    let dialog = await screen.findByRole('dialog', { name: 'New unit under Science' });
    await user.type(within(dialog).getByLabelText('Unit name (English)'), 'Physics');
    await user.click(within(dialog).getByRole('button', { name: 'Add unit' }));
    await waitFor(async () => expect(await shape()).toBe('Arts(Dept1,Dept2) Science(Physics) Engineering(Mech)'));
    expect((await screen.findByTestId('toast')).textContent).toMatch(/^Added PhysicsUndo/);

    await user.click(await screen.findByLabelText('Open Mech'));
    dialog = await screen.findByRole('dialog');
    const programs = within(dialog).getByTestId('unit-programs');
    expect(programs.textContent).toMatch(/Programs \(1\)BS Mechanical/);
    await user.click(within(programs).getByRole('link', { name: 'BS Mechanical' }));
    expect(toPrograms).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    // Undo the creation, so the other tests start from START.
    await user.click(within(screen.getAllByTestId('toast')[0]!).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await shape()).toBe(START));
  });

  it('deletes from the drawer after asking, and says why when programs are attached', async () => {
    const user = userEvent.setup();
    render(wrap(section()));
    await user.click(await screen.findByLabelText('Open Engineering'));
    let dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/BS Mechanical/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByLabelText('Open Science'));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const ask = await screen.findByRole('dialog', { name: 'Delete Science?' });
    await user.click(within(ask).getByRole('button', { name: 'Delete' }));
    await waitFor(async () => expect(await shape()).toBe('Arts(Dept1,Dept2) Engineering(Mech)'));
    await user.click(within(await screen.findByTestId('toast')).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await shape()).toBe(START));
  });
});

describe('Unit types manager', () => {
  it('adds, renames, reorders and removes types; a type in use cannot be removed', async () => {
    const user = userEvent.setup();
    render(wrap(section()));
    await screen.findByLabelText('Open Arts');
    await user.click(screen.getByRole('button', { name: 'Unit types' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unit types' });
    expect(within(dialog).getAllByTestId('unit-type-row')).toHaveLength(5);
    expect((within(dialog).getByRole('button', { name: 'Remove College' }) as HTMLButtonElement).disabled).toBe(true); // used by 3 units
    expect(within(dialog).getAllByTestId('unit-type-count')[0]!.textContent).toBe('3 units');

    await user.type(within(dialog).getByLabelText('New type name (English)'), 'Research centre');
    await user.type(within(dialog).getByLabelText('New type name (Arabic)'), 'مركز بحوث');
    await user.click(within(dialog).getByRole('button', { name: 'Add type' }));
    await waitFor(() => expect(within(dialog).getAllByTestId('unit-type-row')).toHaveLength(6));

    const name = within(dialog).getByLabelText('Name of Research centre (English)');
    await user.clear(name);
    await user.type(name, 'Institute');
    await user.click(within(dialog).getByRole('button', { name: 'Save Research centre' }));
    await waitFor(() => expect(within(dialog).getByLabelText('Name of Institute (English)')).toBeTruthy());

    await user.click(within(dialog).getByRole('button', { name: 'Move Institute up' }));
    await waitFor(async () => expect((await apiFor('admin').orgChart()).types.map((t) => t.key).indexOf('research_centre')).toBe(4));

    await user.click(within(dialog).getByRole('button', { name: 'Remove Institute' }));
    await waitFor(() => expect(within(dialog).getAllByTestId('unit-type-row')).toHaveLength(5));
    expect((await apiFor('admin').orgChart()).types.map((t) => t.key)).not.toContain('research_centre');
  });

  it('offers a new type to the drawer, and shows it read-only to a viewer', async () => {
    const user = userEvent.setup();
    await apiFor('admin').createOrgUnitType({ labelEn: 'Council' });
    render(wrap(section('viewer')));
    await screen.findByLabelText('Open Arts');
    await user.click(screen.getByRole('button', { name: 'Unit types' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unit types' });
    expect(within(dialog).getByLabelText('Name of Council (English)')).toHaveProperty('disabled', true);
    expect(within(dialog).queryByRole('button', { name: 'Add type' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /^Remove / })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    const types = (await apiFor('admin').orgChart()).types;
    await apiFor('admin').removeOrgUnitType(types.find((t) => t.key === 'council')!.id);
  });
});

describe('Chart view', () => {
  it('draws one box per unit with its names, type and head, and switches from the tree', async () => {
    const user = userEvent.setup();
    render(wrap(section()));
    await screen.findByLabelText('Open Arts');
    await user.click(screen.getByRole('button', { name: 'Chart' }));
    const svg = await screen.findByTestId('chart-svg');
    await waitFor(() => expect(within(svg as unknown as HTMLElement).getAllByTestId('chart-box')).toHaveLength(6));
    const arts = screen.getByRole('button', { name: /^Arts, كلية الآداب, College, head Dr Head/ });
    expect(arts.textContent).toContain('كلية الآداب');
    expect(arts.textContent).toContain('Dr Head');
    expect(arts.querySelector('text[direction="rtl"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Chart' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('group', { name: /^Org chart\./ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tree' }));
    expect(await screen.findByLabelText('Open Arts')).toBeTruthy();
  });

  it('zooms with the buttons and the keyboard, pans with arrows, fits with 0', async () => {
    const user = userEvent.setup();
    render(wrap(section('admin', 'chart')));
    const viewport = await screen.findByTestId('chart-viewport');
    const zoom = () => screen.getByTestId('chart-zoom').textContent;
    expect(zoom()).toBe('100%');
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoom()).toBe('125%');
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(zoom()).toBe('80%');
    viewport.focus();
    await user.keyboard('+');
    expect(zoom()).toBe('100%');
    const g = () => viewport.querySelector('[data-view]')!.getAttribute('transform')!;
    const before = g();
    await user.keyboard('{ArrowLeft}');
    expect(g()).not.toBe(before);
    await user.keyboard('-');
    expect(zoom()).toBe('80%');
    fireEvent.wheel(viewport, { deltaY: -200, clientX: 10, clientY: 10 });
    expect(Number.parseInt(zoom()!, 10)).toBeGreaterThan(80);
  });

  it('fits the whole chart into the viewport when it opens, and again with the Fit button or 0', async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 700, height: 400, top: 0, left: 0, right: 700, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
    render(wrap(section('admin', 'chart')));
    const viewport = await screen.findByTestId('chart-viewport');
    const zoom = () => Number.parseInt(screen.getByTestId('chart-zoom').textContent!, 10);
    await waitFor(() => expect(zoom()).toBeLessThan(100));
    const fitted = zoom();
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoom()).toBeGreaterThan(fitted);
    await user.click(screen.getByRole('button', { name: 'Fit' }));
    expect(zoom()).toBe(fitted);
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    viewport.focus();
    await user.keyboard('0');
    expect(zoom()).toBe(fitted);
  });

  it('collapses and expands a branch from its box, and opens a unit\'s drawer on click or Enter', async () => {
    const user = userEvent.setup();
    render(wrap(section('admin', 'chart')));
    const boxes = async () => (await screen.findAllByTestId('chart-box')).length;
    await waitFor(async () => expect(await boxes()).toBe(6));
    await user.click(screen.getByRole('button', { name: 'Collapse Arts' }));
    await waitFor(async () => expect(await boxes()).toBe(4));
    expect(screen.getByRole('button', { name: /^Arts, .*collapsed, 2 units hidden/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand Arts' }).textContent).toBe('+2');
    await user.click(screen.getByRole('button', { name: 'Expand Arts' }));
    await waitFor(async () => expect(await boxes()).toBe(6));
    await user.click(screen.getByRole('button', { name: /^Science,/ }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Unit name (English)') as HTMLInputElement).value).toBe('Science');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    screen.getByRole('button', { name: /^Engineering,/ }).focus();
    await user.keyboard('{Enter}');
    expect(((await screen.findByLabelText('Unit name (English)')) as HTMLInputElement).value).toBe('Engineering');
  });

  it('mirrors for a right-to-left interface', async () => {
    const x = async () => {
      const boxes = await screen.findAllByTestId('chart-box');
      const at = (name: string) => Number(/translate\(([-\d.]+)/.exec(boxes.find((b) => b.getAttribute('aria-label')!.startsWith(`${name},`))!.getAttribute('transform')!)![1]);
      return { arts: at('Arts'), eng: at('Engineering') };
    };
    render(wrap(section('admin', 'chart')));
    const ltr = await x();
    expect(ltr.arts).toBeLessThan(ltr.eng);
    cleanup();
    document.documentElement.style.direction = 'rtl';
    render(wrap(section('admin', 'chart')));
    const rtl = await x();
    expect(rtl.arts).toBeGreaterThan(rtl.eng);
  });

  it('exports as an image and as SVG with the whole chart, Arabic included, and prints a one-page sheet', async () => {
    const user = userEvent.setup();
    const ex = exporters();
    render(wrap(section('admin', 'chart', ex)));
    await waitFor(async () => expect((await screen.findAllByTestId('chart-box')).length).toBe(6));
    await user.click(screen.getByRole('button', { name: 'Export as image' }));
    await waitFor(() => expect(ex.save).toHaveBeenCalledTimes(1));
    const [svg, size] = (ex.png as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { width: number; height: number }];
    expect(svg).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain(`viewBox="0 0 ${size.width} ${size.height}"`);
    expect(svg).toContain('كلية الآداب');
    expect(svg).toContain('direction="rtl"');
    expect(svg).not.toContain('transform="translate(0 0) scale(1)"'); // the zoom and pan are not part of the export
    expect(svg).not.toMatch(/class="[^"]*org-chart-print/);
    expect(size.width).toBeGreaterThan(200 * 3);
    expect(size.height).toBeGreaterThan(84 * 2);
    expect((ex.save as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe('org-chart.png');
    expect(await screen.findByText('Saved org-chart.png.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Export as SVG' }));
    await waitFor(() => expect(ex.save).toHaveBeenCalledTimes(2));
    const [blob, name] = (ex.save as ReturnType<typeof vi.fn>).mock.calls[1] as [Blob, string];
    expect(name).toBe('org-chart.svg');
    expect(blob.type).toBe('image/svg+xml');
    expect(blob.size).toBeGreaterThan(1000);

    await user.click(screen.getByRole('button', { name: 'Print / save as PDF' }));
    await waitFor(() => expect(ex.print).toHaveBeenCalled());
    expect(document.body.classList.contains('org-chart-printing')).toBe(true);
    const sheet = screen.getByTestId('print-sheet');
    expect(sheet.parentElement).toBe(document.body);
    expect(sheet.querySelector('svg')!.getAttribute('viewBox')).toBe(`0 0 ${size.width} ${size.height}`);
    fireEvent(window, new Event('afterprint'));
    await waitFor(() => expect(screen.queryByTestId('print-sheet')).toBeNull());
    expect(document.body.classList.contains('org-chart-printing')).toBe(false);
  });

  it('says so when an export fails', async () => {
    const user = userEvent.setup();
    const ex = { ...exporters(), png: vi.fn(async () => { throw new Error('The chart could not be drawn as an image.'); }) };
    render(wrap(section('admin', 'chart', ex)));
    await waitFor(async () => expect((await screen.findAllByTestId('chart-box')).length).toBe(6));
    await user.click(screen.getByRole('button', { name: 'Export as image' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The chart could not be drawn as an image.');
    expect(ex.save).not.toHaveBeenCalled();
  });
});

describe('editing on the chart', () => {
  const chartReady = async () => waitFor(async () => expect((await screen.findAllByTestId('chart-box')).length).toBe(6));

  it('renames a box in place: a double-click opens the name field (not the drawer), Enter saves with Undo; F2 then Escape cancels', async () => {
    const user = userEvent.setup();
    render(wrap(section('admin', 'chart')));
    await chartReady();
    await user.dblClick(chartBox('Science'));
    const field = await screen.findByLabelText('Rename Science') as HTMLInputElement;
    expect(field.getAttribute('dir')).toBe('auto');
    expect(field.value).toBe('Science');
    expect(document.activeElement).toBe(field);
    await user.clear(field);
    await user.type(field, 'Natural Sciences{Enter}');
    await waitFor(async () => expect(await shape()).toBe('Arts(Dept1,Dept2) Natural Sciences Engineering(Mech)'));
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Natural Sciences,/));
    expect(screen.queryByRole('dialog')).toBeNull(); // the clicks of the double-click did not open the drawer
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toMatch(/^Edited ScienceUndo/);
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await shape()).toBe(START));
    await waitFor(() => expect(chartBox('Science')).toBeTruthy());

    // F2 opens the same field; Escape leaves the name as it was and goes back to the box.
    chartBox('Engineering').focus();
    await user.keyboard('{F2}');
    const f2 = await screen.findByLabelText('Rename Engineering') as HTMLInputElement;
    await user.type(f2, ' and Design');
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('Rename Engineering')).toBeNull();
    expect(document.activeElement).toBe(chartBox('Engineering'));
    expect(await shape()).toBe(START);
    // A click still opens the unit's drawer.
    await user.click(chartBox('Engineering'));
    expect(((await screen.findByLabelText('Unit name (English)')) as HTMLInputElement).value).toBe('Engineering');
  });

  it('adds a sub-unit from the ＋ of a box: the parent\'s type, appears in the chart and takes the focus; Undo takes it away', async () => {
    const user = userEvent.setup();
    render(wrap(section('admin', 'chart')));
    await chartReady();
    expect(screen.getAllByTestId('chart-add')).toHaveLength(6);
    await user.click(screen.getByRole('button', { name: 'Add a unit under Science' }));
    const field = await screen.findByLabelText('Name of the new unit under Science') as HTMLInputElement;
    expect(field.getAttribute('dir')).toBe('auto');
    expect(screen.getByTestId('chart-add-field').textContent).toMatch(/College · Enter saves, Escape cancels/);
    await user.type(field, 'Physics{Enter}');
    await waitFor(async () => expect(await shape()).toBe('Arts(Dept1,Dept2) Science(Physics) Engineering(Mech)'));
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Physics, College/));
    const { units } = await apiFor('admin').orgChart();
    expect(units.find((u) => u.nameEn === 'Physics')).toMatchObject({ type: 'college', parentId: ids.sci });
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toMatch(/^Added PhysicsUndo/);
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await shape()).toBe(START));
    // Escape (or an empty name) adds nothing.
    await user.click(screen.getByRole('button', { name: 'Add a unit under Arts' }));
    await user.type(await screen.findByLabelText('Name of the new unit under Arts'), 'Nothing');
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('Name of the new unit under Arts')).toBeNull();
    expect(await shape()).toBe(START);
  });

  it('sends the focused box to the Trash with Delete after the server\'s question, with Undo; programs refuse it with their names', async () => {
    const user = userEvent.setup();
    render(wrap(section('admin', 'chart')));
    await chartReady();
    chartBox('Science').focus();
    await user.keyboard('{Delete}');
    let dialog = await screen.findByRole('dialog', { name: 'Delete Science?' });
    expect(dialog.textContent).toMatch(/Science.*Trash for 30 days/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await shape()).toBe(START);
    chartBox('Science').focus();
    await user.keyboard('{Backspace}');
    dialog = await screen.findByRole('dialog', { name: 'Delete Science?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(async () => expect(await shape()).toBe('Arts(Dept1,Dept2) Engineering(Mech)'));
    await waitFor(() => expect(screen.getAllByTestId('chart-box')).toHaveLength(5));
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toMatch(/^Deleted ScienceUndo/);
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await shape()).toBe(START));

    // Engineering has a program in Mech: refused with the program named, no question, nothing changes.
    await waitFor(() => expect(screen.getAllByTestId('chart-box')).toHaveLength(6));
    chartBox('Engineering').focus();
    await user.keyboard('{Delete}');
    expect((await screen.findByRole('alert')).textContent).toMatch(/BS Mechanical \(in Mech\).*Move or reassign it to another unit first/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await shape()).toBe(START);
  });

  it('moves a box with the keyboard: Space picks it up, the arrows choose the unit in words, Space drops; one Undo; a locked unit says why', async () => {
    const user = userEvent.setup();
    render(wrap(section('admin', 'chart')));
    await chartReady();
    chartBox('Science').focus();
    await user.keyboard(' ');
    expect(chartLive()).toMatch(/^Picked up Science\. Use the arrow keys/);
    await user.keyboard('{ArrowRight}');
    expect(chartLive()).toBe('Put Science under Dept1. (2 of 5)');
    await user.keyboard('{ArrowLeft}');
    expect(chartLive()).toBe('Put Science under Arts. (1 of 5)');
    expect(screen.getByTestId('chart-drop-target').getAttribute('data-target')).toBe(ids.arts);
    expect(screen.getByTestId('chart-drop-target').getAttribute('data-ok')).toBe('true');
    await user.keyboard(' ');
    await waitFor(async () => expect(await shape()).toBe('Arts(Dept1,Dept2,Science) Engineering(Mech)'));
    expect(screen.queryByTestId('chart-drag')).toBeNull();
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toMatch(/^Moved Science under ArtsUndo/);
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await shape()).toBe(START));

    // Escape puts it down where it was.
    await waitFor(() => expect(chartBox('Science')).toBeTruthy());
    chartBox('Science').focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Escape}');
    expect(chartLive()).toMatch(/^Move cancelled\. Science stayed where it was\./);
    expect(screen.queryByTestId('chart-drag')).toBeNull();

    // Arts is locked: it is not picked up, and the reason is shown.
    chartBox('Arts').focus();
    await user.keyboard(' ');
    expect((await screen.findByRole('alert')).textContent).toBe('Arts is locked, so it cannot be moved from the chart. Unlock it in its details first.');
    expect(screen.queryByTestId('chart-drag')).toBeNull();
    expect(await shape()).toBe(START);
  });

  it('drags a box onto another with the pointer: the target is outlined, its own sub-unit is refused in words, empty canvas cancels', async () => {
    render(wrap(section('admin', 'chart')));
    await chartReady();
    // Engineering over its own Mech: outlined as refused, with the reason; dropped there, nothing moves.
    dragBox('Engineering', ...centre('Mech'), { up: false });
    const target = screen.getByTestId('chart-drop-target');
    expect(target.getAttribute('data-ok')).toBe('false');
    expect(target.getAttribute('data-target')).toBe(ids.mech);
    expect(screen.getByTestId('chart-drop-hint').textContent).toBe('Cannot drop here. A unit cannot be moved under itself or one of its own sub-items.');
    fireEvent.pointerUp(screen.getByTestId('chart-viewport'), { pointerId: 1, ...xy(...centre('Mech')) });
    expect((await screen.findByRole('alert')).textContent).toBe('A unit cannot be moved under itself or one of its own sub-items.');
    expect(screen.queryByTestId('chart-drag')).toBeNull();
    expect(await shape()).toBe(START);

    // Onto itself: refused too.
    dragBox('Science', ...centre('Science').map((v) => v + 8) as [number, number], { up: false });
    expect(screen.getByTestId('chart-drop-hint').textContent).toBe('Cannot drop here. Science cannot be moved under itself.');
    fireEvent.pointerUp(screen.getByTestId('chart-viewport'), { pointerId: 1 });

    // Onto empty canvas: cancelled.
    dragBox('Science', -2000, -2000);
    fireEvent.click(chartBox('Science')); // the click that ends a drag does not open the drawer
    expect(chartLive()).toMatch(/^Move cancelled\. Science stayed where it was\./);
    expect(await shape()).toBe(START);
    await new Promise((r) => setTimeout(r, 350));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Onto Engineering: moved under it, with one Undo, and the zoom and pan are kept.
    const transform = screen.getByTestId('chart-viewport').querySelector('[data-view]')!.getAttribute('transform');
    dragBox('Science', ...centre('Engineering'));
    await waitFor(async () => expect(await shape()).toBe('Arts(Dept1,Dept2) Engineering(Mech,Science)'));
    expect(screen.getByTestId('chart-viewport').querySelector('[data-view]')!.getAttribute('transform')).toBe(transform);
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toMatch(/^Moved Science under EngineeringUndo/);
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await shape()).toBe(START));

    // A locked box is not picked up: the reason is shown and nothing moves.
    dragBox('Arts', ...centre('Science'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/^Arts is locked/);
    expect(await shape()).toBe(START);
  });

  it('leaves the edit chrome out of the exported SVG', async () => {
    const user = userEvent.setup();
    const ex = exporters();
    render(wrap(section('admin', 'chart', ex)));
    await chartReady();
    dragBox('Science', ...centre('Engineering'), { up: false });
    expect(screen.getByTestId('chart-drop-target')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Export as SVG' }));
    await waitFor(() => expect(ex.save).toHaveBeenCalledTimes(1));
    const svg = await ((ex.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Blob).text();
    expect(svg).toContain('Science');
    expect(svg).not.toContain('Add a unit under');
    expect(svg).not.toContain('chart-drop-target');
    expect(svg).not.toContain('chart-drag');
    fireEvent.pointerCancel(screen.getByTestId('chart-viewport'), { pointerId: 1 });
    expect(await shape()).toBe(START);
  });
});

describe('read-only role', () => {
  it('sees both views, no handles, boxes or checkboxes to edit with, and a read-only drawer', async () => {
    const user = userEvent.setup();
    render(wrap(<OrganizationPage api={apiFor('viewer')} />));
    await screen.findByLabelText('Open Arts');
    expect(screen.queryByRole('button', { name: 'Add unit' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
    expect(screen.queryByLabelText(/^Add a unit under /)).toBeNull();
    expect(screen.getByRole('button', { name: 'Select' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByLabelText('Open Arts'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('read-only-note')).toBeTruthy();
    expect((within(dialog).getByLabelText('Unit name (English)') as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Delete' })).toBeNull();
    await user.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Chart' }));
    await waitFor(async () => expect((await screen.findAllByTestId('chart-box')).length).toBe(6));
    expect(screen.getByRole('button', { name: 'Export as image' })).toBeTruthy();
    // The chart is read-only: no ＋, no edit help; a double-click opens the unit (no name field), Delete does nothing, Space opens.
    expect(screen.queryAllByTestId('chart-add')).toHaveLength(0);
    expect(screen.queryByLabelText(/^Add a unit under /)).toBeNull();
    expect(screen.queryByTestId('chart-edit-help')).toBeNull();
    expect(screen.getByTestId('chart-viewport').getAttribute('data-editable')).toBe('false');
    await user.dblClick(chartBox('Science'));
    expect(screen.queryByLabelText(/^Rename /)).toBeNull();
    const d2 = await screen.findByRole('dialog');
    await user.click(within(d2).getAllByRole('button', { name: 'Close' })[0]!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    chartBox('Science').focus();
    await user.keyboard('{Delete}');
    await user.keyboard('{F2}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByLabelText(/^Rename /)).toBeNull();
    // A pointer drag on a box pans the chart; nothing is picked up.
    const vp = screen.getByTestId('chart-viewport');
    const before = vp.querySelector('[data-view]')!.getAttribute('transform');
    dragBox('Science', 300, 300);
    expect(screen.queryByTestId('chart-drag')).toBeNull();
    expect(vp.querySelector('[data-view]')!.getAttribute('transform')).not.toBe(before);
    await user.keyboard(' ');
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(await shape()).toBe(START);
  });
});
