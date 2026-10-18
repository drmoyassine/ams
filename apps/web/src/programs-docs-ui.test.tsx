// @vitest-environment jsdom
// Programs -> Docs (TASK-076): the Docs section of the Programs tab and the review of imported programs, against the real API and
// database; the worker runs with a fake model (no network).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import userEvent from '@testing-library/user-event';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, MemoryStore } from '@ams/api';
import { createFakeAiModel, handlers, runJob, setAiModelForTests } from '@ams/core';
import type { JobEnvelope, JobType } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import './i18n';
import { resetConfirmForTests } from './components/confirm-dialog';
import { UndoToaster } from './components/undo-toaster';
import { createApi } from './lib/api';
import { documentsApi } from './lib/documents-api';
import { settingsApi } from './lib/settings-api';
import { resetUndoForTests } from './lib/undo';
import { ProgramsSettingsPage } from './pages/settings/programs';

configure({ asyncUtilTimeout: 10000 });

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const store = new MemoryStore();
const queued: (JobEnvelope & { type: JobType })[] = [];
const queue = { send: async (type: JobType, e: JobEnvelope) => { queued.push({ ...e, type }); } };
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
type Who = 'lead' | 'viewer';
const fetchAs = (who: Who) => ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-test-user', `${ids[who]}:${ids.inst}`);
  return app.request(input as string, { ...init, headers });
}) as typeof fetch;
function page(who: Who) {
  const f = fetchAs(who);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <><ProgramsSettingsPage api={settingsApi(createApi(f), f)} docs={documentsApi(createApi(f), f)} /><UndoToaster /></> }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>;
}
async function work(types: JobType[]) {
  let n = 0;
  while (n++ < 100) {
    const i = queued.findIndex((q) => types.includes(q.type));
    if (i < 0) break;
    const [{ type, ...env }] = queued.splice(i, 1) as [JobEnvelope & { type: JobType }];
    await runJob(pool, type, env, handlers, { store, queue });
  }
}
function pdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((t, i) => {
    const content = t.split('\n').map((line, n) => `BT /F1 12 Tf 72 ${700 - n * 16} Td (${line.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET`).join('\n');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
const filler = 'This page is part of the catalogue of programs of the university and describes each one.';

/** The fake model: one program per "Program: Name | level | unit" line, citing the line. */
function responder() {
  return (options: unknown): object => {
    const prompt = (options as { prompt?: { role: string; content: unknown }[] }).prompt ?? [];
    const user = prompt.filter((m) => m.role === 'user').map((m) => (Array.isArray(m.content) ? m.content.map((c) => (c as { text?: string }).text ?? '').join('') : String(m.content))).join('\n');
    const items: object[] = [];
    const parts = user.split(/=== Page (\d+) ===/);
    for (let i = 1; i < parts.length; i += 2) {
      for (const m of parts[i + 1]!.matchAll(/Program: ([^|\n]+?) \| (\w*) \| (.+)$/gm)) {
        items.push({ item: { nameEn: m[1], degreeLevel: m[2] === 'none' ? null : m[2], unitName: m[3] }, source: { page: Number(parts[i]), quote: m[0] }, confidence: 0.9, flags: [] });
      }
    }
    return { items };
  };
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('webprogramsdocs');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store, queue,
    authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [who, role, name] of [['lead', 'lead', 'Lena Lead'], ['viewer', 'viewer', 'Vera Viewer']] as const) {
    ids[who] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $3) returning id`, [ids.inst, name, `${who}@x.org`]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[who], role]);
  }
  await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
}, 60000);
beforeEach(() => { resetUndoForTests(); resetConfirmForTests(); });
afterEach(() => { cleanup(); setAiModelForTests(null); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('Programs -> Docs', () => {
  it('uploads a catalogue, imports programs, reviews them, applies them as one undoable change and shows them in the list', async () => {
    const user = userEvent.setup({ applyAccept: false });
    setAiModelForTests(createFakeAiModel([responder()]).model);
    render(page('lead'));
    await user.click(await screen.findByRole('tab', { name: 'Docs' }));
    const tab = await screen.findByRole('region', { name: 'Docs' });
    await user.upload(await within(tab).findByLabelText('Files to upload'), new File([pdf([`Program: BSc Nursing | bachelor | College of Health\nProgram: MEng Mechanical | master | Engineering\n${filler}`, `Program: Short Course | none | Engineering\n${filler}`]) as unknown as BlobPart], 'catalogue.pdf', { type: 'application/pdf' }));
    await screen.findByRole('article', { name: 'catalogue.pdf' });
    await work(['extract_text']);
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'catalogue.pdf' })).getByRole('status').textContent).toBe('Read'));

    await user.click(screen.getByRole('button', { name: 'Import programs' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Start import' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(dialog).getByRole('button', { name: 'Start import' }));
    await screen.findByRole('status', { name: 'Import progress' });
    await work(['import']);
    const history = await screen.findByRole('list', { name: 'Import history' });
    await waitFor(() => expect(within(history).getByTestId('import-run').textContent).toContain('Finished'));
    await user.click(within(history).getByRole('button', { name: /Review/ }));

    const review = await screen.findByRole('region', { name: 'Review proposals' });
    const table = await within(review).findByRole('table', { name: 'Proposals' });
    const rows = within(table).getAllByTestId('proposal');
    expect(rows).toHaveLength(3);
    // A cell for every field, so the missing degree level can be filled in right there; flags say what is missing.
    const short = rows.find((r) => within(r).queryByLabelText('Name en of Short Course') ?? within(r).queryByDisplayValue('Short Course'))!;
    expect(short.textContent).toMatch(/No degree level was found/);
    // Degree level has a fixed list, so it is a choice: nothing typed can fail to fit. Set it on the selected rows at once.
    const level = within(short).getByLabelText(/^Degree level of /) as HTMLSelectElement;
    expect(level.tagName).toBe('SELECT');
    expect([...level.options].map((o) => o.value)).toEqual(['', 'associate', 'bachelor', 'master', 'doctorate', 'diploma', 'certificate']);
    // The owning unit is offered from the org chart (a new name can still be typed); the unit type is the institution's list.
    const unit = within(short).getByLabelText(/^Unit name of /) as HTMLInputElement;
    const listId = unit.getAttribute('list')!;
    expect([...document.getElementById(listId)!.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toContain('Engineering');
    expect((within(short).getByLabelText(/^Unit type of /) as HTMLElement).tagName).toBe('SELECT');
    await user.click(within(short).getByRole('checkbox', { name: /^Select / }));
    await user.selectOptions(within(review).getByLabelText('Field to set'), 'degreeLevel');
    await user.selectOptions(within(review).getByLabelText('Value for Degree level'), 'diploma');
    await user.click(within(review).getByRole('button', { name: 'Set on 1 selected' }));
    await waitFor(() => expect(within(short).getByText('Edited')).toBeTruthy());
    expect((within(short).getByLabelText(/^Degree level of /) as HTMLSelectElement).value).toBe('diploma');
    await user.click(within(review).getByRole('button', { name: /^Accept all without a flag/ }));
    await user.click(await within(review).findByRole('button', { name: /^Apply \d+$/ }));
    const confirmation = await screen.findByRole('dialog');
    expect(confirmation.textContent).toMatch(/You can undo it afterwards/);
    await user.click(within(confirmation).getByRole('button', { name: /^Apply \d+$/ }));
    const result = await within(review).findByTestId('apply-result');
    expect(result.textContent).toMatch(/Applied 3 programs/);
    const programs = (await db.su.query(`select p.name_en, p.degree_level, u.name_en unit, p.created_by from program p join org_unit u on u.id = p.org_unit_id order by p.name_en`)).rows;
    expect(programs.map((p) => [p.name_en, p.degree_level, p.unit])).toEqual([['BSc Nursing', 'bachelor', 'College of Health'], ['MEng Mechanical', 'master', 'Engineering'], ['Short Course', 'diploma', 'Engineering']]);
    expect(programs.every((p) => p.created_by === ids.lead)).toBe(true);

    await user.click(within(result).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByTestId('apply-result').textContent).toMatch(/^Undone: Applied/));
    expect((await db.su.query(`select count(*)::int n from program where active`)).rows[0].n).toBe(0);
    expect((await db.su.query(`select active from org_unit where name_en = 'College of Health'`)).rows[0].active).toBe(false);
  }, 120000);

  it('shows a person who may not edit programs the documents, with no upload and no Import', async () => {
    render(page('viewer'));
    await userEvent.setup().click(await screen.findByRole('tab', { name: 'Docs' }));
    const tab = await screen.findByRole('region', { name: 'Docs' });
    await within(tab).findByRole('article', { name: 'catalogue.pdf' });
    expect(within(tab).queryByRole('group', { name: 'Upload documents' })).toBeNull();
    expect(within(tab).queryByRole('button', { name: 'Import programs' })).toBeNull();
  });
});
