// @vitest-environment jsdom
// Evidence requests in the SPA against the real API (DEC-018): ask from a standard's ⋯ menu; an AMS user supplies the
// file from Requests; someone without an account gets a one-time link that opens a page with only that request.
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
import { glossaryApi } from './lib/glossary-api';
import { settingsApi } from './lib/settings-api';
import { RequestsPage } from './pages/requests';
import { RespondPage } from './pages/respond';
import { QualityFrameworkPage } from './pages/settings/quality-framework';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const fetchAs = (who: string | null) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  if (who) headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
const apis = (who: string) => {
  const a = createApi(fetchAs(who));
  return { evidence: evidenceApi(a, fetchAs(who)), framework: frameworkApi(a), glossary: glossaryApi(a), settings: settingsApi(a) };
};
function wrap(ui: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => ui }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
const pdf = (name: string) => new File(['%PDF-1.4'], name, { type: 'application/pdf' });

beforeAll(async () => {
  db = await createTestDb('webrequests');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2 || '@x.org') returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  await apis('admin').framework.setUpQualityFramework({ template: true });
}, 120000);
afterEach(() => cleanup());
afterAll(async () => { await pool.end(); await db.close(); });

async function requestFrom(email: string, what: string) {
  const user = userEvent.setup();
  const a = apis('admin');
  render(wrap(<QualityFrameworkPage api={a.framework} glossary={a.glossary} settings={a.settings} evidence={a.evidence} />));
  const item = await screen.findByRole('region', { name: 'Standard 3.2' });
  await user.click(within(item).getByRole('button', { name: 'Actions for Standard 3.2' }));
  await user.click(screen.getByRole('menuitem', { name: 'Request evidence' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('What is needed'), what);
  await user.type(within(dialog).getByLabelText('Ask (email)'), email);
  await user.type(within(dialog).getByLabelText('Message'), 'The approved version, please');
  await user.click(within(dialog).getByRole('button', { name: 'Request' }));
  return { user, item, dialog };
}

describe('evidence requests', () => {
  it('asks an AMS user, who supplies the file from Requests', async () => {
    const { user, item, dialog } = await requestFrom('viewer@x.org', 'Exit survey 2025');
    expect(await within(dialog).findByText(/It is in their requests in the AMS/)).toBeTruthy();
    expect(within(dialog).queryByTestId('response-link')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect((await within(item).findByTestId('evidence-request')).textContent).toContain('Requested');
    cleanup();

    const v = apis('viewer');
    render(wrap(<RequestsPage api={v.evidence} framework={v.framework} />));
    const row = await screen.findByTestId('evidence-request');
    expect(row.textContent).toContain('Exit survey 2025');
    expect(within(row).queryByRole('button', { name: 'Cancel request' })).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'Supply evidence' }));
    const answer = await screen.findByRole('dialog');
    await user.upload(within(answer).getByLabelText('File'), pdf('exit.pdf'));
    await user.type(within(answer).getByLabelText('Note'), 'Spring and fall cohorts');
    await user.click(within(answer).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('evidence-request').textContent).toContain('Supplied'));
  });

  it('asks someone without an account through a one-time link that works once', async () => {
    const { dialog } = await requestFrom('hr@partner.com', 'Employer survey');
    const box = await within(dialog).findByTestId('response-link');
    const url = (within(box).getByLabelText('One-time link') as HTMLInputElement).value;
    const token = url.split('/respond/')[1]!;
    expect(token.length).toBeGreaterThan(20);
    cleanup();

    const user = userEvent.setup();
    const anon = evidenceApi(createApi(fetchAs(null)), fetchAs(null));
    render(wrap(<RespondPage token={token} api={anon} />));
    expect(await screen.findByRole('heading', { name: 'Evidence requested' })).toBeTruthy();
    expect(screen.getByText('Employer survey')).toBeTruthy();
    expect(screen.getByText('Gulf University')).toBeTruthy();
    await user.upload(screen.getByLabelText('File'), pdf('employers.pdf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('status')).toBeTruthy();
    cleanup();

    render(wrap(<RespondPage token={token} api={anon} />));
    expect((await screen.findByRole('alert')).textContent).toContain('has been used');
  });
});
