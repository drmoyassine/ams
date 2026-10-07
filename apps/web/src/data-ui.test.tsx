// @vitest-environment jsdom
// Data evidence in the SPA against the real API: define the columns, paste a block from Excel, see the cells that do
// not fit, fix them, save as a version; import a CSV into the sheet.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { createApi } from './lib/api';
import { evidenceApi } from './lib/evidence-api';
import { frameworkApi } from './lib/framework-api';
import { EvidencePage } from './pages/evidence';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const fetchAs = (who: string) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const apis = (who: string) => { const a = createApi(fetchAs(who)); return { evidence: evidenceApi(a, fetchAs(who)), framework: frameworkApi(a) }; };
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}

beforeAll(async () => {
  db = await createTestDb('webdata');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  ids.admin = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'admin', 'admin@x.org') returning id`, [ids.inst]);
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [ids.inst, ids.admin]);
}, 120000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

describe('data evidence', () => {
  it('defines columns, takes a pasted block, flags bad cells and saves a version', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<EvidencePage api={a.evidence} framework={a.framework} />));
    await user.click(await screen.findByRole('button', { name: '+ Evidence' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Fall-to-fall retention');
    await user.click(within(dialog).getByRole('radio', { name: 'Data' }));
    expect(within(dialog).getByText('File (optional)')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Create evidence' }));

    const panel = await screen.findByRole('region', { name: 'Data' });
    await user.type(within(panel).getByLabelText('What the data means'), 'Students still enrolled the next fall');
    await user.type(within(panel).getByLabelText('Column 1 name'), 'Program');
    await user.click(within(panel).getByLabelText('Column 1 required'));
    await user.click(within(panel).getByRole('button', { name: '+ Column' }));
    await user.type(within(panel).getByLabelText('Column 2 name'), 'Retention');
    await user.selectOptions(within(panel).getByLabelText('Column 2 type'), 'percent');
    await user.click(within(panel).getByRole('button', { name: 'Save definition' }));

    const sheet = await within(panel).findByRole('table', { name: 'Data' });
    await user.click(within(sheet).getByLabelText('Program, row 1'));
    await user.paste('BS Mechanical\t82%\nهندسة مدنية\thigh\n');
    const bad = await within(sheet).findByLabelText('Retention, row 2');
    expect(bad.getAttribute('aria-invalid')).toBe('true');
    expect(bad.getAttribute('title')).toMatch(/percent/);
    expect(within(panel).getByTestId('sheet-status').textContent).toContain('1 cell needs attention');
    expect((within(panel).getByRole('button', { name: 'Save as new version' }) as HTMLButtonElement).disabled).toBe(true);

    await user.clear(bad);
    await user.type(bad, '79.5');
    await waitFor(() => expect(bad.getAttribute('aria-invalid')).toBeNull());
    await user.type(within(panel).getByLabelText('Note for this version'), 'From the registrar');
    await user.click(within(panel).getByRole('button', { name: 'Save as new version' }));
    expect((await within(panel).findByRole('status')).textContent).toContain('Saved as version 1 (2 rows)');
    expect((await screen.findByTestId('evidence-version')).textContent).toContain('2 rows of data');
  });

  it('imports a CSV into the sheet for checking before it is saved', async () => {
    const user = userEvent.setup();
    const a = apis('admin');
    render(wrap(<EvidencePage api={a.evidence} framework={a.framework} />));
    await user.click(await screen.findByRole('button', { name: /Fall-to-fall retention/ }));
    const panel = await screen.findByRole('region', { name: 'Data' });
    const sheet = await within(panel).findByRole('table', { name: 'Data' });
    await waitFor(() => expect((within(sheet).getByLabelText('Program, row 1') as HTMLInputElement).value).toBe('BS Mechanical'));
    await user.upload(within(panel).getByLabelText('Import Excel or CSV'), new File(['Program,Retention,Comment\nBS Electrical,88\n'], 'ret.csv', { type: 'text/csv' }));
    expect((await within(panel).findByRole('status')).textContent).toMatch(/Imported 1 row from ret.csv.*Ignored columns: Comment/);
    expect((within(sheet).getByLabelText('Program, row 1') as HTMLInputElement).value).toBe('BS Electrical');
    await user.click(within(panel).getByRole('button', { name: 'Save as new version' }));
    expect((await within(panel).findByRole('status')).textContent).toContain('Saved as version 2 (1 row)');
  });
});
