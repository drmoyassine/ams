// @vitest-environment jsdom
// Courses -> Docs (DEC-044): the Docs section of the Courses tab and the review of imported courses, against the real API and database;
// the worker runs with a fake model (no network).
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
import { CoursesSettingsPage } from './pages/settings/courses';
import { outcomesApi } from './lib/outcomes-api';

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
    routeTree: createRootRoute({ component: () => <><CoursesSettingsPage api={settingsApi(createApi(f), f)} outcomes={outcomesApi(f)} docs={documentsApi(createApi(f), f)} /><UndoToaster /></> }),
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

/** Windows: one fact per "Fact: course | field | value" line. Organise: one item per course, matched by its code without spaces. */
function responder() {
  return (options: unknown): object => {
    const prompt = (options as { prompt?: { role: string; content: unknown }[] }).prompt ?? [];
    const user = prompt.filter((m) => m.role === 'user').map((m) => (Array.isArray(m.content) ? m.content.map((c) => (c as { text?: string }).text ?? '').join('') : String(m.content))).join('\n');
    if (!user.includes('Facts found in them')) {
      const items: object[] = [];
      const parts = user.split(/=== Page (\d+) ===/);
      for (let i = 1; i < parts.length; i += 2) {
        for (const m of parts[i + 1]!.matchAll(/Fact: ([^|\n]+?) \| (\w+) \| (.+)$/gm)) items.push({ item: { course: m[1], field: m[2], value: m[3] }, source: { page: Number(parts[i]), quote: m[0] }, confidence: 0.9, flags: [] });
      }
      return { items };
    }
    const facts = [...user.matchAll(/^\[(\d+)\] (.+?) · (\w+): (.+)$/gm)].map((m) => ({ n: Number(m[1]), course: m[2]!, field: m[3]!, value: m[4]! }));
    const known = [...user.matchAll(/^(C\d+) · code (.+?) · /gm)].map((m) => ({ ref: m[1]!, code: m[2]!.replace(/\s/g, '') }));
    return {
      items: [...new Set(facts.map((f) => f.course))].map((name) => {
        const mine = facts.filter((f) => f.course === name);
        const v = (field: string) => mine.find((f) => f.field === field)?.value ?? null;
        const match = known.find((k) => k.code === (v('code') ?? '').replace(/\s/g, ''));
        return { match: match?.ref ?? null, match_reason: match ? 'Same code.' : null, code: v('code'), title: v('title'), unit: v('unit'), credits: v('credits'), year: v('year'), programs: mine.filter((f) => f.field === 'program').map((f) => f.value), from: mine.map((f) => f.n), confidence: 0.9, flags: [] };
      }),
    };
  };
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('webcoursesdocs');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store, queue,
    authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [who, role, name] of [['lead', 'admin', 'Lena Lead'], ['viewer', 'viewer', 'Vera Viewer']] as const) {
    ids[who] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $3) returning id`, [ids.inst, name, `${who}@x.org`]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[who], role]);
  }
  ids.unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.prog = await one(`insert into program (institution_id, org_unit_id, code, name_en, degree_level) values ($1, $2, 'BSME', 'BS Mechanical', 'bachelor') returning id`, [ids.inst, ids.unit]);
  ids.course = await one(`insert into course (institution_id, org_unit_id, code, title_en) values ($1, $2, 'MCE 410', 'Heat Transfer') returning id`, [ids.inst, ids.unit]);
}, 60000);
beforeEach(() => { resetUndoForTests(); resetConfirmForTests(); });
afterEach(() => { cleanup(); setAiModelForTests(null); });
afterAll(async () => { await pool.end(); await db.close(); });

describe('Courses -> Docs', () => {
  it('uploads a catalogue, matches "MCE410" to MCE 410, reviews it field by field and applies: record at once, content into the draft', async () => {
    const user = userEvent.setup({ applyAccept: false });
    setAiModelForTests(createFakeAiModel([responder()]).model);
    render(page('lead'));
    await user.click(await screen.findByRole('tab', { name: 'Docs' }));
    const tab = await screen.findByRole('region', { name: 'Docs' });
    const page1 = ['Fact: MCE410 Heat Transfer | code | MCE410', 'Fact: MCE410 Heat Transfer | title | Heat Transfer', 'Fact: MCE410 Heat Transfer | credits | 3', 'Fact: MCE410 Heat Transfer | year | 4', 'Fact: MCE410 Heat Transfer | program | BSME',
      'Fact: Capstone | code | MCE 499', 'Fact: Capstone | title | Capstone Design', 'Fact: Capstone | unit | Engineering', 'Fact: Capstone | credits | 3', 'Fact: Capstone | program | BSME', filler].join('\n');
    await user.upload(await within(tab).findByLabelText('Files to upload'), new File([pdf([page1]) as unknown as BlobPart], 'catalogue.pdf', { type: 'application/pdf' }));
    await screen.findByRole('article', { name: 'catalogue.pdf' });
    await work(['extract_text']);
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'catalogue.pdf' })).getByRole('status').textContent).toBe('Read'));
    await user.click(screen.getByRole('button', { name: 'Import courses' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Start import' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(dialog).getByRole('button', { name: 'Start import' }));
    await screen.findByRole('status', { name: 'Import progress' });
    await work(['import']);
    const history = await screen.findByRole('list', { name: 'Import history' });
    await waitFor(() => expect(within(history).getByTestId('import-run').textContent).toContain('Finished'));
    await user.click(within(history).getByRole('button', { name: /Review/ }));

    const review = await screen.findByRole('region', { name: 'Review proposals' });
    const rows = within(await within(review).findByRole('table', { name: 'Proposals' })).getAllByTestId('proposal');
    expect(rows).toHaveLength(2);
    const mce = rows.find((r) => r.textContent?.includes('Updates MCE 410'))!;
    expect(mce.textContent).toMatch(/Updates MCE 410: now: Year of study; adds to BSME; into the draft: Credit hours\./); // "MCE410" is its code
    expect(rows.find((r) => r.textContent?.includes('New course'))).toBeTruthy();
    await user.click(within(mce).getByRole('button', { name: /^Show the details of / }));
    const details = await within(review).findByRole('region', { name: /^Details of MCE410/ });
    expect((within(details).getByLabelText(/^Course for /) as HTMLSelectElement).value).toBe(ids.course);
    await user.click(within(details).getByRole('checkbox', { name: /^Apply Year of study of / })); // keep it as it is
    await waitFor(() => expect(mce.textContent).toMatch(/Updates MCE 410: adds to BSME; into the draft: Credit hours\./));
    await user.click(within(review).getByRole('checkbox', { name: 'Select all' }));
    await user.click(within(review).getByRole('button', { name: 'Accept selected' }));
    await user.click(await within(review).findByRole('button', { name: /^Apply 2$/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^Apply \d+$/ }));
    expect((await within(review).findByTestId('apply-result')).textContent).toMatch(/Applied 2 courses/);
    expect((await db.su.query(`select code, level, credits from course order by code`)).rows).toEqual([{ code: 'MCE 410', level: null, credits: null }, { code: 'MCE 499', level: null, credits: '3.0' }]);
    expect((await db.su.query(`select count(*)::int n from course_program where program_id = $1`, [ids.prog])).rows[0].n).toBe(2);
    const draft = (await db.su.query(`select status, source, content from syllabus_version where course_id = $1`, [ids.course])).rows[0];
    expect(draft).toMatchObject({ status: 'draft', source: 'document import' });
    expect(draft.content.info.credits).toBe(3);
  }, 120000);

  it('shows a viewer the documents, with no upload and no Import', async () => {
    render(page('viewer'));
    await userEvent.setup().click(await screen.findByRole('tab', { name: 'Docs' }));
    const tab = await screen.findByRole('region', { name: 'Docs' });
    expect(await within(tab).findByRole('article', { name: 'catalogue.pdf' })).toBeTruthy();
    expect(within(tab).queryByLabelText('Files to upload')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import courses' })).toBeNull();
  });
});
