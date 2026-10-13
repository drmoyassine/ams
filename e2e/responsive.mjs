#!/usr/bin/env node
/* global process, console, fetch, TextEncoder, URL, window, document, getComputedStyle, performance, requestAnimationFrame, cancelAnimationFrame, Buffer, crypto */
// Responsiveness check (`pnpm test:responsive`): boots the real API + built SPA against a fresh test database, signs in
// through the login page in Chromium, and visits the main screens at 375, 768 and 1280 px. For each page and width it
// asserts the page does not scroll horizontally and saves a full-page screenshot to e2e/screenshots/<width>/<page>.png.
//
// Needs: PostgreSQL (TEST_DATABASE_ADMIN_URL, as for `pnpm db:test`), built packages and SPA
// (`pnpm build`), and Playwright with Chromium. Playwright is not a repo dependency: the script uses `playwright` if it
// resolves, otherwise PLAYWRIGHT_MODULE (default /opt/node-tools/node_modules/playwright/index.mjs). Chromium comes from
// PLAYWRIGHT_BROWSERS_PATH, or CHROMIUM_PATH if set.
//
// Flags: --report-only (exit 0 even when pages overflow), --widths=375,768 (subset), --pages=engagements,evidence (subset),
//        --headed (show the browser).
// Exit codes: 0 ok (or --report-only), 1 some page overflows horizontally, 2 the run itself failed.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const reportOnly = flag('report-only');
const widths = (option('widths') ?? '375,768,1280').split(',').map(Number);
const onlyPages = option('pages')?.split(',');
const shotsDir = join(root, 'e2e', 'screenshots');

// Workspace packages and their dependencies resolve from apps/api, which depends on all of them.
const apiRequire = createRequire(join(root, 'apps/api/package.json'));
const load = (spec) => import(pathToFileURL(apiRequire.resolve(spec)).href);
const dist = (p) => import(pathToFileURL(join(root, p)).href);

for (const p of ['apps/api/dist/index.js', 'packages/db/dist/test-db.js', 'apps/web/dist/index.html']) {
  if (!existsSync(join(root, p))) fail(`${p} is missing: build first (pnpm build)`);
}

function fail(msg) {
  console.error(`test:responsive: ${msg}`);
  process.exit(2);
}

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not a repo dependency; fall back to the preinstalled copy */ }
  const path = process.env.PLAYWRIGHT_MODULE ?? '/opt/node-tools/node_modules/playwright/index.mjs';
  try { return await import(pathToFileURL(path).href); } catch (e) {
    return fail(`cannot load Playwright from ${path} (set PLAYWRIGHT_MODULE): ${e.message}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const EMAIL = 'responsive-admin@example.edu';
const PASSWORD = 'responsive-check-password';

/** Fresh database, seeded admin + demo data, the API serving the built SPA. Returns the base URL and a stop function. */
async function startApp() {
  const [{ createTestDb }, api, { createAuth, sessionAuthenticator }, { MemoryStore }, pg, { serve }, { serveStatic }] = await Promise.all([
    dist('packages/db/dist/test-db.js'), dist('apps/api/dist/index.js'), dist('apps/api/dist/auth.js'),
    load('@ams/core'), load('pg'), load('@hono/node-server'), load('@hono/node-server/serve-static'),
  ]);
  const db = await createTestDb('responsive');
  const pool = new pg.default.Pool({ connectionString: db.url });
  // An idle client dropped by the server (e.g. PostgreSQL restarted) must not crash the run; the pool reconnects.
  pool.on('error', (e) => console.warn(`database pool: ${e.message}`));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server;
  const stop = async () => {
    if (server) await new Promise((r) => server.close(() => r()));
    await pool.end().catch(() => undefined);
    await db.close().catch((e) => console.error(`could not drop test database: ${e.message}`));
  };
  try {
    process.env.APP_SECRET ??= 'responsive-check-secret-0123456789abcdef'; // encrypts the AI account keys the seed saves
    const auth = createAuth(pool, { AUTH_SECRET: 'responsive-check-secret-0123456789abcdef', APP_URL: base, OIDC_PROVIDER_ID: 'oidc' });
    await api.seedAdmin(pool, auth, { INSTITUTION_NAME: 'Gulf University of Science and Technology', ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD: PASSWORD });
    await api.seedFrameworks(pool);
    await api.seedGlossary(pool);

    const queue = { send: async () => undefined }; // no worker: jobs are dropped
    const { app } = api.createApp({ pool, authenticate: sessionAuthenticator(auth, pool), authHandler: auth.handler, queue, store: new MemoryStore() });
    const webRoot = join(root, 'apps/web/dist');
    app.use('/*', serveStatic({ root: relative(process.cwd(), webRoot) }));
    const index = readFileSync(join(webRoot, 'index.html'), 'utf8');
    app.get('*', (c) => (c.req.path.startsWith('/api') ? c.json({ error: 'not_found' }, 404) : c.html(index)));
    server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });

    const ids = await seedDemo(db, base);
    return { base, ids, stop, db };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** Signs in over HTTP and creates what the screens need, through the API as a person would. */
async function seedDemo(db, base) {
  const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!signIn.ok) throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`);
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = async (method, path, body, headers = { 'content-type': 'application/json' }) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...headers, cookie, origin: base }, ...(body === undefined ? {} : { body: headers['content-type'] === 'application/json' ? JSON.stringify(body) : body }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const q = async (sql, p = []) => (await db.su.query(sql, p)).rows;

  const [{ institution_id: inst, id: admin }] = await q(`select institution_id, id from app_user where email = $1`, [EMAIL]);
  const [{ id: unit }] = await q(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'College of Engineering and Applied Sciences') returning id`, [inst]);
  const [{ id: program }] = await q(`insert into program (institution_id, org_unit_id, name_en, degree_level, tags) values ($1, $2, 'BS Mechanical Engineering', 'bachelor', '{mechanical}') returning id`, [inst, unit]);
  const [{ id: versionId }] = await q(
    `select fv.id from framework_version fv join framework f on f.id = fv.framework_id join accreditor a on a.id = f.accreditor_id
      where not f.internal and fv.status = 'published' order by (a.short_name = 'ABET') desc, a.short_name limit 1`);

  const ids = { versionId };
  // A draft with a finished analysis run, so the Sources section shows the analysis panel and its last run.
  try {
    const { version: draft } = await call('POST', `/api/framework-versions/${versionId}/new-version`, { edition: 'responsive-draft' });
    ids.draftId = draft.id;
    await q(`insert into analysis_run (institution_id, framework_version_id, status, stage, started_at, finished_at, usage, report)
      values ($1, $2, 'succeeded', 'finalise', now(), now(), '{"inputTokens":120000,"outputTokens":34000,"costUsd":1.23,"calls":42}',
      '{"stats":{"pagesRead":120,"requirementsByLevel":{"Standard":4,"Criterion":31,"Indicator":120},"requirements":155,"notes":48,"quoteVerified":190,"quoteVerifiedShare":0.936,"unverified":13,"orphans":2,"lowConfidence":5,"added":203,"updated":0,"keptHumanEdits":0,"recoveryRounds":2,"gapsRecovered":6,"gapsUnresolved":2,"conflicts":1,"uncoveredPages":1,"dismissedSkipped":3},
      "recovery":{"stopped":"max_rounds"},
      "gaps":[{"key":"req:CFR 2.13","kind":"numbering_gap","status":"unresolved","code":"CFR 2.13","documentId":null,"page":null,"round":2,"attempts":2,"detail":"between CFR 2.12 and CFR 2.14 — a long explanation that must wrap on a phone rather than push the page sideways","reason":null,"requirementId":null},
        {"key":"conflict:CFR 1.1","kind":"conflict","status":"conflict","code":"CFR 1.1","documentId":null,"page":null,"round":0,"attempts":0,"detail":"different wording in two documents (pages 12 and 47)","reason":null,"requirementId":null},
        {"key":"req:CFR 3.9","kind":"numbering_gap","status":"confirmed_absent","code":"CFR 3.9","documentId":null,"page":null,"round":1,"attempts":1,"detail":"between CFR 3.8 and CFR 3.10","reason":"The numbering goes from 3.8 to 3.10.","requirementId":null}]}')`, [inst, draft.id]);
  } catch (e) { console.warn(`seed: analysis draft skipped (${e.message})`); }
  // The same draft gets a source with page text and requirements citing it, for the split view and "Needs a look".
  if (ids.draftId) {
    try {
      const [{ id: doc }] = await q(`insert into source_document (institution_id, framework_version_id, title, role, authority, file_path, sha256) values ($1,$2,'Accreditation handbook (responsive check)','standards','binding','p',$3) returning id`, [inst, ids.draftId, 'e'.repeat(64)]);
      await q(`insert into source_page (institution_id, source_document_id, page_no, text, method) values ($1,$2,1,$3,'pdf_text'),($1,$2,2,$4,'pdf_text')`,
        [inst, doc, 'Institutions must publish their mission statement and review it every year, together with a very long unbroken wording that has to wrap on a phone rather than push the page sideways.', 'يَجِبُ أَنْ تَكُونَ لِلْمُؤَسَّسَةِ رِسَالَةٌ مُعْلَنَةٌ وَمُعْتَمَدَةٌ تُراجَعُ كُلَّ سَنَةٍ.']);
      const reqs = await q(`select id from requirement where framework_version_id = $1 and parent_id is null order by display_order, code limit 2`, [ids.draftId]);
      if (reqs[0]) await q(`update requirement set origin = 'ai', source_document_id = $2, source_page = 1, source_quote = 'must publish their mission statement', quote_verified = true where id = $1`, [reqs[0].id, doc]);
      if (reqs[1]) await q(`update requirement set origin = 'ai', source_document_id = $2, source_page = 2, source_quote = 'a quote that is not on the page at all', quote_verified = false where id = $1`, [reqs[1].id, doc]);
    } catch (e) { console.warn(`seed: split-view sources skipped (${e.message})`); }
  }
  const warn = (what, e) => console.warn(`seed: ${what} skipped (${e.message})`);
  // Two saved AI accounts (the screen opens on Models when there are some), so the cards, the model pickers and the add dialog have content.
  try {
    await call('POST', '/api/settings/ai/accounts', { name: 'Work OpenAI with a rather long label to check wrapping', provider: 'openai', apiKey: 'sk-responsive-check-1234' });
    await call('POST', '/api/settings/ai/accounts', { name: 'Home Gemini', provider: 'google', apiKey: 'gkey-responsive-check-5678' });
  } catch (e) { warn('ai accounts', e); }
  try {
    const eng = await call('POST', '/api/engagements', { frameworkVersionId: versionId, subjectType: 'program', subjectId: program, kind: 'initial', reviewYear: 2027, leadUserId: admin });
    ids.engagementId = eng.engagement.id;
  } catch (e) { warn('engagement', e); }
  try {
    const doc = await call('POST', '/api/evidence', { title: 'Strategic plan 2025–2030 and annual institutional effectiveness report', type: 'document', periodLabel: 'AY2025-26', description: 'The board-approved strategic plan with its key performance indicators.' });
    await call('POST', `/api/evidence/${doc.id}/files?fileName=${encodeURIComponent('strategic-plan-2025-2030-board-approved-final-version.pdf')}`, new TextEncoder().encode('%PDF-1.4 plan'), { 'content-type': 'application/pdf' });
    await call('POST', '/api/evidence', { title: 'الخطة الاستراتيجية للجامعة', type: 'document', url: 'https://intranet.example.edu/very/long/path/to/the/strategic-plan/document/in/arabic.pdf' });
    const data = await call('POST', '/api/evidence', { title: 'Enrolment headcount by program', type: 'data' });
    await call('PUT', `/api/evidence/${data.id}/data-definition`, { columns: [
      { key: 'program', label: 'Program', type: 'text', required: true }, { key: 'year', label: 'Academic year', type: 'text', required: true },
      { key: 'n', label: 'Headcount', type: 'integer', required: true },
    ] });
    await call('POST', `/api/evidence/${data.id}/data`, { rows: [
      { program: 'BS Mechanical Engineering', year: '2024-25', n: '412' }, { program: 'BS Civil Engineering', year: '2024-25', n: '1,204' },
    ] });
  } catch (e) { warn('evidence', e); }
  try {
    const qf = await call('GET', '/api/quality-framework');
    const items = await call('GET', `/api/framework-versions/${qf.versions[0].id}/requirements`);
    await call('POST', `/api/requirements/${items[0].id}/evidence-requests`, { title: 'Exit survey results for the spring cohort', assigneeEmail: 'institutional.research@partner.example.edu', message: 'Please upload the latest results.' });
  } catch (e) { warn('evidence request', e); }
  // Things in the Trash (DEC-026): a source document, an Arabic standard with a sub-item and a note, and the last quality-framework standard with its sub-standards.
  try {
    if (ids.draftId) {
      const doc = await call('POST', `/api/framework-versions/${ids.draftId}/source-documents`, { title: 'Superseded circular (responsive check) with a long title that has to wrap', authority: 'informational', role: 'guidance' });
      await call('DELETE', `/api/source-documents/${doc.id}`);
      const std = await call('POST', `/api/framework-versions/${ids.draftId}/requirements`, { code: 'ع١', levelLabel: 'Standard', title: 'المعيار الأول: الرسالة والأهداف والحوكمة المؤسسية' });
      const kid = await call('POST', `/api/framework-versions/${ids.draftId}/requirements`, { code: 'ع١.١', levelLabel: 'Criterion', title: 'مراجعة الرسالة', parentId: std.id });
      await call('POST', `/api/requirements/${kid.id}/notes`, { type: 'guidance', text: 'ملاحظة على المعيار', authority: 'suggested' });
      await call('DELETE', `/api/requirements/${std.id}`);
    }
    const qf = await call('GET', '/api/quality-framework');
    const items = await call('GET', `/api/framework-versions/${qf.versions[0].id}/requirements`);
    const lastTop = [...items].reverse().find((r) => !r.parentId);
    if (lastTop) await call('DELETE', `/api/requirements/${lastTop.id}`);
    // A standard to delete with the question and the Undo toast on the draft's page (it is restored again afterwards).
  } catch (e) { warn('trash', e); }
  // The in-app assistant (DEC-027): AI switched on so the panel's composer is live, one saved conversation with steps, links and a
  // pending "Remember this?" card, and a few memory notes (long and Arabic) for the memory page.
  try {
    const accounts = await call('GET', '/api/settings/ai/accounts');
    await call('PUT', '/api/settings/ai', { enabled: true, analysis: { accountId: accounts[0].id, model: 'responsive-check-model' } });
    const [req] = await q(`select id, code, title from requirement where framework_version_id = $1 and parent_id is not null order by display_order, code limit 1`, [versionId]);
    // Bulk edits confirmed in the chat (Phase 2): a proposal waiting for the person's answer, and one already applied. Long Arabic and
    // English text, a skipped list and named deletes must wrap on a phone. (Inserted first: the chat list shows newest first and the
    // other states click the first chat.)
    const target = ids.draftId ?? versionId;
    const longAr = 'توضح رسالة المؤسسة الغرض من إنشائها وتتضمن الفئات المستفيدة من خدماتها ومجالات عملها الأساسية وأولوياتها للسنوات الخمس القادمة بما يتسق مع رؤيتها';
    const longEn = 'The institution publishes its policies, procedures and decisions in a form that staff, students and external reviewers can find without help';
    const baseProposal = {
      type: 'change_proposal', versionId: target, versionLabel: 'ABET responsive-draft', operations: [{ op: 'swap_title_and_description', filter: { level: 'Indicator' }, direction: 'statement_to_title' }],
      changeSetHash: 'h'.repeat(64), planHash: 'p'.repeat(64),
      counts: { items: 149, byOperation: [{ op: 'swap_title_and_description', label: 'Put the statement in the title', items: 149 }], deletes: 0, linksByCode: 0, writtenByAssistant: 0 },
      examples: [{ code: '1-1-1', field: 'title', before: '1-1-1', after: longAr }, { code: '3-2-4', field: 'title', before: '3-2-4', after: longEn }, { code: '6-1-8', field: 'title', before: '6-1-8', after: 'a-very-long-unbroken-title-sample-'.repeat(4) }],
      skipped: [{ code: '1-2-2', reason: 'the statement is longer than 300 characters, so it stays the description' }, { code: '1-2-3', reason: 'the title is only the code and there is no description to use' }, { code: '2-1-9', reason: 'it already has a description' }, { code: '2-1-10', reason: 'it already has a description' }],
      skippedCount: 4, deletes: [], deletesCount: 0, warnings: [], dryRun: { ok: true, problems: [] }, remaining: 0, newDraft: null, error: null,
    };
    const pending = { ...baseProposal, id: 'cp1', status: 'pending', summary: 'Make the statement the title of 149 indicators in ABET responsive-draft', result: null };
    const [{ id: convChange }] = await q(`insert into assistant_conversation (institution_id, user_id, title, context) values ($1, $2, 'Put each indicator statement in its title in the responsive draft, where the title is only the code', '{}') returning id`, [inst, admin]);
    await q(`insert into assistant_message (institution_id, conversation_id, role, parts, created_at) values ($1, $2, 'user', $3::jsonb, now() - interval '4 minutes')`,
      [inst, convChange, JSON.stringify([{ id: 'cu1', type: 'text', text: 'Put each indicator statement in its title where the title is only the code.' }])]);
    await q(`insert into assistant_message (institution_id, conversation_id, role, status, parts, created_at) values ($1, $2, 'assistant', 'done', $3::jsonb, now() - interval '3 minutes')`,
      [inst, convChange, JSON.stringify([
        { id: 'ct1', type: 'text', text: 'I will make the statement the title of **149 indicators** in ABET responsive-draft, for example 1-1-1: «' + longAr + '». 4 are skipped. Go ahead?' },
        pending,
      ])]);
    const applied = { ...baseProposal, id: 'cp2', status: 'applied', summary: 'Delete the empty headings in ABET responsive-draft',
      counts: { items: 8, byOperation: [{ op: 'delete_by_filter', label: 'Delete (to the Trash)', items: 8 }], deletes: 2, linksByCode: 0, writtenByAssistant: 0 }, examples: [], skipped: [], skippedCount: 0,
      deletes: [{ code: '4.2', title: 'Facilities and a very long heading that has to wrap on a narrow phone screen', subItems: 5, notes: 2 }, { code: '4.3', title: 'قاعات الدراسة', subItems: 1, notes: 0 }], deletesCount: 2,
      operations: [{ op: 'delete_by_filter', filter: { emptyHeading: true } }],
      result: { changeSetId: crypto.randomUUID(), state: 'applied', message: 'Changed 8 items in ABET responsive-draft', items: 8, appliedAt: new Date().toISOString(), newVersionId: null } };
    const [{ id: convApplied }] = await q(`insert into assistant_conversation (institution_id, user_id, title, context) values ($1, $2, 'Delete the empty headings in the responsive draft', '{}') returning id`, [inst, admin]);
    await q(`insert into assistant_message (institution_id, conversation_id, role, parts, created_at) values ($1, $2, 'user', $3::jsonb, now() - interval '9 minutes')`,
      [inst, convApplied, JSON.stringify([{ id: 'cu2', type: 'text', text: 'Delete the empty headings.' }])]);
    await q(`insert into assistant_message (institution_id, conversation_id, role, status, parts, created_at) values ($1, $2, 'assistant', 'done', $3::jsonb, now() - interval '8 minutes')`,
      [inst, convApplied, JSON.stringify([{ id: 'ct2', type: 'text', text: 'Done. I deleted 2 empty headings and what was under them; they are in the Trash for 30 days.' }, applied])]);
    const [{ id: conv }] = await q(`insert into assistant_conversation (institution_id, user_id, title, context) values ($1, $2, 'Which requirement is about the mission, and what does its source say on page 12 of the handbook?', '{}') returning id`, [inst, admin]);
    await q(`insert into assistant_message (institution_id, conversation_id, role, parts, created_at) values ($1, $2, 'user', $3::jsonb, now() - interval '2 minutes')`,
      [inst, conv, JSON.stringify([{ id: 'u1', type: 'text', text: 'Which requirement is about the mission? من فضلك أخبرني أيضا عن المصدر.' }])]);
    const parts = [
      { id: 'call-1', type: 'tool_call', name: 'search_requirements', summary: '“mission”' },
      { id: 'res-1', type: 'tool_result', callId: 'call-1', name: 'search_requirements', summary: 'Found 3 requirements about “mission”',
        links: req ? [{ kind: 'requirement', id: req.id, versionId, code: req.code, label: `${req.code} ${req.title}`.slice(0, 80) }] : [] },
      { id: 't1', type: 'text', text: `The closest one is **${req?.code ?? '1.1'}**. It asks the institution to state its mission publicly, and:\n\n- the source page is page 12 of a very long handbook title that has to wrap on a narrow phone screen without scrolling sideways\n- المصدر: الصفحة ١٢ من الدليل\n\n\`${'a-very-long-unbroken-code-sample-'.repeat(4)}\`` },
      { id: 'm1', type: 'memory_proposal', text: 'When I say “title” I mean the statement of an indicator, kept in the original Arabic wording and never shortened.', scope: { type: 'version', id: versionId, label: 'ABET 2025-26' }, visibility: 'workspace', kind: 'convention', status: 'pending' },
    ];
    await q(`insert into assistant_message (institution_id, conversation_id, role, status, parts, usage, created_at) values ($1, $2, 'assistant', 'done', $3::jsonb, '{"inputTokens":4200,"outputTokens":380,"costUsd":null,"calls":2,"model":"responsive-check-model"}', now() - interval '1 minute')`,
      [inst, conv, JSON.stringify(parts)]);
    await q(`insert into memory_item (institution_id, scope_type, visibility, kind, text, created_by, pinned) values
      ($1, 'institution', 'private', 'preference', 'Answer in Arabic when I write in Arabic, and keep replies short, with the requirement code first and a very long note that has to wrap nicely on a phone.', $2, true)`, [inst, admin]);
    await q(`insert into memory_item (institution_id, scope_type, scope_id, visibility, kind, text, created_by) values
      ($1, 'version', $3, 'workspace', 'convention', 'في هذا الإصدار يُكتب نص المؤشر في خانة العنوان ويُحفظ كما ورد في المصدر دون اختصار.', $2)`, [inst, admin, versionId]);
  } catch (e) { warn('assistant', e); }
  return ids;
}

/** Clicks the first closed accordion/disclosure inside the main content. */
async function expandFirst(page) {
  const btn = page.locator('main button[aria-expanded="false"]:not([aria-haspopup])').first();
  if (await btn.count()) { await btn.click(); return true; }
  return false;
}
const clickTab = (name) => async (page) => { await page.getByRole('tab', { name }).first().click(); };
// A real 1x1 PNG, for the institution logo.
const LOGO_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==', 'base64');
const FILES = [
  { name: 'Accreditation handbook 2027 with a long name.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 handbook') },
  { name: 'دليل المعايير والمؤشرات الخاصة باعتماد المؤسسات.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('docx') },
  { name: 'criteria.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('xlsx') },
];
const openCreateFromFiles = async (page) => { await page.getByRole('button', { name: 'Create from files' }).first().click(); await page.getByRole('dialog').waitFor(); };
const menuItem = (item) => async (page) => {
  await page.getByRole('button', { name: /^Actions for / }).first().click();
  await page.getByRole('menuitem', { name: item }).click();
};


/** Ticks `n` rows (turning Select on first, as a phone has to) and waits for the bulk bar. */
async function tickRows(page, n, selectFirst) {
  if (selectFirst) await page.getByRole('button', { name: 'Select', exact: true }).click();
  const boxes = page.getByTestId('row-checkbox');
  for (let i = 0; i < n; i += 1) await boxes.nth(i).click();
  await page.getByTestId('bulk-bar').waitFor();
}
/** Holds the mouse on the first row's move handle and drags it over the row `rows` below, leaving the button down. */
async function pointerDragOver(page, rows) {
  const handles = page.getByTestId('drag-handle');
  await handles.first().scrollIntoViewIfNeeded();
  const from = await handles.first().boundingBox();
  const to = await handles.nth(rows).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 8, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.getByTestId('drag-overlay').waitFor();
}

/**
 * A tree of 600 rows in a real browser: how long ticking, selecting all and a drag take, and how smooth the frames are while
 * dragging. Printed, not asserted (machines differ); only a stall of over 1.5 s fails the run.
 */
async function perfCheck(page, app) {
  const q = async (sql, p = []) => (await app.db.su.query(sql, p)).rows;
  const [{ id: inst }] = await q(`select id from institution limit 1`);
  const [{ id: acc }] = await q(`select id from accreditor limit 1`);
  const [{ id: fw }] = await q(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Perf check (600 rows)', 'institution') returning id`, [inst, acc]);
  const [{ id: ver }] = await q(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, 'perf') returning id`, [inst, fw]);
  await q(`with tops as (
      insert into requirement (institution_id, framework_version_id, code, level_label, title, display_order, origin)
      select $1, $2, 'T' || i, 'Standard', 'Top ' || i, i, 'manual' from generate_series(0, 29) i returning id, code)
    insert into requirement (institution_id, framework_version_id, parent_id, code, level_label, title, display_order, origin)
    select $1, $2, t.id, t.code || '.' || j, 'Criterion', 'Sub ' || t.code || '.' || j, j, 'manual' from tops t, generate_series(0, 18) j`, [inst, ver]);
  const out = {};
  const t0 = Date.now();
  await page.goto(`/settings/versions/${ver}`);
  await page.getByRole('region', { name: 'T29.18' }).waitFor({ timeout: 30000 });
  out['open the screen with 600 rows'] = Date.now() - t0;
  await settle(page);
  // Time from the click to the next painted frame, measured in the page.
  const click = (locator) => locator.evaluate((el) => new Promise((resolve) => {
    const t = performance.now();
    el.click();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t)));
  }));
  out['Select (turn on)'] = await click(page.getByRole('button', { name: 'Select', exact: true }));
  out['tick one row'] = await click(page.getByTestId('row-checkbox').nth(40));
  out['tick another'] = await click(page.getByTestId('row-checkbox').nth(200));
  out['select all 600'] = await click(page.getByRole('button', { name: /^Select all \(/ }));
  out['clear 600'] = await click(page.getByTestId('bulk-bar').getByRole('button', { name: 'Clear' }));
  // Drag a row down across 30 rows, recording the gaps between animation frames.
  await page.evaluate(() => { window.__gaps = []; let last = performance.now(); const tick = (t) => { window.__gaps.push(t - last); last = t; window.__raf = requestAnimationFrame(tick); }; window.__raf = requestAnimationFrame(tick); });
  const handle = page.getByTestId('drag-handle').nth(2);
  await handle.scrollIntoViewIfNeeded();
  const b = await handle.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  const d0 = Date.now();
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 8, b.y + b.height / 2 + 8, { steps: 3 });
  await page.getByTestId('drag-overlay').waitFor();
  out['pick up (to the overlay)'] = Date.now() - d0;
  for (let i = 1; i <= 90; i += 1) await page.mouse.move(b.x + b.width / 2 + 8, b.y + b.height / 2 + i * 6);
  const gaps = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__gaps; });
  const sorted = [...gaps].sort((x, y) => x - y);
  out['frames while dragging (count)'] = gaps.length;
  out['frame gap, median'] = sorted[Math.floor(sorted.length / 2)] ?? 0;
  out['frame gap, 95th percentile'] = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  out['frame gap, worst'] = sorted[sorted.length - 1] ?? 0;
  const drop0 = Date.now();
  await page.mouse.up();
  await page.getByTestId('toast').first().waitFor({ timeout: 10000 }).catch(() => undefined);
  out['drop to Undo toast'] = Date.now() - drop0;
  console.log('\n600-row tree in Chromium (ms):');
  for (const [k, v] of Object.entries(out)) console.log(`  ${k.padEnd(34)} ${typeof v === 'number' ? Math.round(v * 10) / 10 : v}`);
  if (out['frame gap, worst'] > 1500 || out['select all 600'] > 1500) throw new Error('a 600-row tree stalled for more than 1.5 s');
}

function pagesFor(ids) {
  return [
    { name: 'engagements', path: '/engagements' },
    ids.engagementId && { name: 'engagement', path: `/engagements/${ids.engagementId}` },
    { name: 'evidence-library', path: '/evidence' },
    { name: 'evidence-card-open', path: '/evidence', action: expandFirst },
    { name: 'evidence-requests', path: '/evidence', action: clickTab('Requests') },
    { name: 'my-requests', path: '/requests' },
    // Organization: two tabs (TASK-069). Institution holds Details, Logo and Org chart; Programs is the old Programs page.
    { name: 'settings-organization', path: '/settings/organization' },
    { name: 'settings-organization-programs', path: '/settings/organization?tab=programs' },
    { name: 'settings-programs-redirect', path: '/settings/programs' },
    { name: 'settings-organization-tab-keys', path: '/settings/organization', action: async (page) => { await page.getByRole('tab', { name: 'Institution' }).focus(); await page.keyboard.press('ArrowRight'); await page.getByRole('tab', { name: 'Programs', selected: true }).waitFor(); } },
    // The logo is uploaded here and stays for the pages after it (header and sidebar show it), then is removed.
    { name: 'settings-organization-logo-uploaded', path: '/settings/organization', action: async (page) => {
      await page.getByLabel('Logo file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: LOGO_PNG });
      await page.getByRole('button', { name: 'Change' }).waitFor();
    } },
    { name: 'login-with-logo', path: '/login', action: async (page) => { await page.getByTestId('institution-logo').waitFor(); } },
    { name: 'settings-organization-logo-removed', path: '/settings/organization', action: async (page) => {
      await page.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('button', { name: 'Upload logo' }).waitFor();
    } },
    { name: 'settings-quality-framework', path: '/settings/quality-framework' },
    { name: 'settings-external-standards', path: '/settings/external-standards' },
    { name: 'settings-ai', path: '/settings/ai' },
    { name: 'settings-ai-accounts', path: '/settings/ai', action: clickTab('Accounts') },
    { name: 'settings-ai-add-account', path: '/settings/ai', action: async (page) => { await clickTab('Accounts')(page); await page.getByRole('button', { name: 'Add account' }).first().click(); } },
    { name: 'settings-ai-limits', path: '/settings/ai', action: clickTab('Limits') },
    { name: 'version-requirements', path: `/settings/versions/${ids.versionId}`, action: expandFirst },
    { name: 'version-settings', path: `/settings/versions/${ids.versionId}?tab=settings` },
    ids.draftId && { name: 'version-sources', path: `/settings/versions/${ids.draftId}?tab=settings&section=sources` },
    ids.draftId && { name: 'version-report', path: `/settings/versions/${ids.draftId}?tab=report` },
    // F2: Create from files, and the split view of a draft's requirements (the viewer beside the list on wide screens, a bottom sheet on small ones).
    { name: 'create-from-files', path: '/settings/external-standards', action: openCreateFromFiles },
    { name: 'create-from-files-filled', path: '/settings/external-standards', action: async (page) => {
      await openCreateFromFiles(page);
      await page.getByLabel('Accreditor', { exact: true }).selectOption({ label: 'A new accreditor…' });
      await page.getByLabel('Accreditor name').fill('Responsive Check Accreditation Council with a long name');
      await page.getByLabel('Accreditor short name').fill('RCAC');
      await page.getByLabel('Standard name').fill('Institutional Standards for the responsive check');
      await page.getByLabel('Edition').fill('2027');
      await page.getByLabel('Choose files').setInputFiles(FILES);
      await page.getByTestId('chosen-file').first().waitFor();
    } },
    ids.draftId && { name: 'version-split-view', path: `/settings/versions/${ids.draftId}`, action: async (page) => {
      await page.getByTestId('requirement-card').first().getByRole('button', { expanded: false }).first().click();
      await page.getByRole('button', { name: /^Show the source of / }).first().click();
      await page.getByTestId('source-page-text').waitFor();
    } },
    ids.draftId && { name: 'version-needs-a-look', path: `/settings/versions/${ids.draftId}`, action: async (page) => {
      await page.getByRole('button', { name: /^Quote not found/ }).first().click();
    } },
    ids.draftId && { name: 'version-merge-dialog', path: `/settings/versions/${ids.draftId}`, action: async (page) => { await menuItem('Merge into another requirement')(page); await page.getByRole('dialog').waitFor(); } },
    // DEC-026: the Trash, the in-app confirm dialog (instead of the browser's) and the Undo toast.
    { name: 'settings-trash', path: '/settings/trash' },
    { name: 'settings-trash-contents', path: '/settings/trash', action: async (page) => { await page.getByRole('button', { name: /what is inside/ }).first().click(); await page.getByTestId('trash-contents').waitFor(); } },
    { name: 'settings-trash-empty-dialog', path: '/settings/trash', action: async (page) => { await page.getByRole('button', { name: 'Empty trash' }).click(); await page.getByRole('dialog', { name: 'Empty the Trash?' }).waitFor(); } },
    ids.draftId && { name: 'confirm-dialog-delete', path: `/settings/versions/${ids.draftId}`, action: async (page) => {
      await menuItem('Delete')(page);
      await page.getByRole('dialog', { name: /^Delete / }).waitFor();
    } },
    ids.draftId && { name: 'undo-toast', path: `/settings/versions/${ids.draftId}`, action: async (page) => {
      await menuItem('Delete')(page);
      const dialog = page.getByRole('dialog', { name: /^Delete / });
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByTestId('toast').first().waitFor();
    }, after: async (page) => { await page.getByRole('button', { name: 'Undo' }).first().click(); await page.getByText(/^Undone: /).first().waitFor(); } },
    // Multi-select, bulk delete and drag and drop of requirements (the quality framework and an external standard's draft).
    { name: 'iqf-select-bar', path: '/settings/quality-framework', action: async (page) => { await tickRows(page, 2, true); } },
    { name: 'iqf-bulk-delete-dialog', path: '/settings/quality-framework', action: async (page) => {
      await tickRows(page, 2, true);
      await page.getByTestId('bulk-bar').getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('dialog', { name: /^Delete / }).waitFor();
    } },
    { name: 'iqf-keyboard-drag', path: '/settings/quality-framework', action: async (page) => {
      const handle = page.getByTestId('drag-handle').first();
      await handle.focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.getByTestId('drag-overlay').waitFor();
    }, after: async (page) => { await page.keyboard.press('Escape'); } },
    { name: 'iqf-pointer-drag', path: '/settings/quality-framework', action: async (page) => { await pointerDragOver(page, 3); },
      after: async (page) => { await page.keyboard.press('Escape'); await page.mouse.up(); } },
    ids.draftId && { name: 'version-select-bar', path: `/settings/versions/${ids.draftId}`, action: async (page) => { await tickRows(page, 2, true); } },
    ids.draftId && { name: 'version-pointer-drag', path: `/settings/versions/${ids.draftId}`, action: async (page) => { await pointerDragOver(page, 1); },
      after: async (page) => { await page.keyboard.press('Escape'); await page.mouse.up(); } },
    // The in-app assistant (DEC-027): the bubble, the open panel (with a saved conversation, a "Remember this?" card and context chips), a new chat, history and the memory page.
    { name: 'assistant-bubble-closed', path: '/engagements', action: async (page) => { await page.getByTestId('assistant-bubble').waitFor(); } },
    { name: 'assistant-panel-new-chat', path: `/settings/versions/${ids.versionId}`, action: async (page) => {
      await page.getByTestId('assistant-bubble').click();
      await page.getByRole('dialog', { name: 'Assistant' }).waitFor();
      await page.getByTestId('assistant-empty').waitFor();
    } },
    { name: 'assistant-panel-open', path: `/settings/versions/${ids.versionId}`, action: async (page) => {
      await page.getByTestId('assistant-bubble').click();
      await page.getByRole('button', { name: 'Chat history' }).click();
      await page.getByRole('list', { name: 'Your chats' }).getByRole('button').first().click();
      await page.getByTestId('memory-card').waitFor();
      await page.getByTestId('assistant-steps').locator('summary').click();
    } },
    { name: 'assistant-change-proposal', path: '/engagements', action: async (page) => {
      await page.getByTestId('assistant-bubble').click();
      await page.getByRole('button', { name: 'Chat history' }).click();
      await page.getByRole('list', { name: 'Your chats' }).getByRole('button', { name: /^Put each indicator statement/ }).click();
      await page.getByTestId('change-card').waitFor();
      await page.getByTestId('change-skipped').locator('summary').click();
      await page.getByTestId('change-do-it').scrollIntoViewIfNeeded();
    } },
    { name: 'assistant-change-applied', path: '/engagements', action: async (page) => {
      await page.getByTestId('assistant-bubble').click();
      await page.getByRole('button', { name: 'Chat history' }).click();
      await page.getByRole('list', { name: 'Your chats' }).getByRole('button', { name: /^Delete the empty headings/ }).click();
      await page.getByTestId('change-result').waitFor();
    } },
    { name: 'assistant-panel-history', path: '/engagements', action: async (page) => {
      await page.getByTestId('assistant-bubble').click();
      await page.getByRole('button', { name: 'Chat history' }).click();
      await page.getByRole('list', { name: 'Your chats' }).getByRole('button').first().waitFor();
    } },
    { name: 'settings-assistant-memory', path: '/settings/assistant-memory', action: async (page) => { await page.getByTestId('memory-row').first().waitFor(); } },
    { name: 'settings-assistant-memory-shared', path: '/settings/assistant-memory', action: async (page) => { await clickTab('Shared')(page); await page.getByTestId('memory-row').first().waitFor(); } },
    { name: 'settings-assistant-memory-add', path: '/settings/assistant-memory', action: async (page) => { await page.getByRole('button', { name: 'Add memory' }).click(); await page.getByRole('dialog', { name: 'Add memory' }).waitFor(); } },
    { name: 'settings-ai-assistant', path: '/settings/ai', action: async (page) => { await clickTab('Models')(page); await page.getByRole('region', { name: 'Assistant model' }).scrollIntoViewIfNeeded(); } },
    ids.draftId && { name: 'version-split-dialog', path: `/settings/versions/${ids.draftId}`, action: async (page) => { await menuItem('Split')(page); await page.getByRole('dialog').waitFor(); } },
  ].filter(Boolean).filter((p) => !onlyPages || onlyPages.includes(p.name));
}

/** Runs in the page: horizontal overflow, and the elements that push past the viewport. */
function measure() {
  const vw = window.innerWidth;
  const scrollWidth = document.documentElement.scrollWidth;
  const label = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 4).map((c) => `.${c}`).join('') : '';
    const role = el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : '';
    const aria = el.getAttribute('aria-label') ? `[aria-label="${el.getAttribute('aria-label').slice(0, 40)}"]` : '';
    const text = (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${role}${aria}${cls}${text ? ` "${text}"` : ''}`;
  };
  // Inside a container that clips or scrolls horizontally and itself fits, an element cannot widen the page.
  const contained = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox !== 'visible' && p.getBoundingClientRect().right <= vw + 1) return true;
    }
    return false;
  };
  const offenders = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right <= vw + 1) continue;
    const parent = el.parentElement?.getBoundingClientRect();
    // Report where the overflow starts: the element sticks out of its parent (or its parent already sticks out less).
    if (parent && r.right <= parent.right + 1 && el.parentElement !== document.body) continue;
    if (contained(el)) continue;
    offenders.push({ right: Math.round(r.right), width: Math.round(r.width), el: label(el) });
  }
  offenders.sort((a, b) => b.right - a.right);
  // Elements that are themselves wider than the viewport, deepest first (none of their children is), e.g. a table,
  // a row of tabs that does not wrap, or a fixed-width column.
  const wide = [];
  for (const el of document.body.querySelectorAll('*')) {
    const w = el.getBoundingClientRect().width;
    if (w <= vw + 1 || contained(el)) continue;
    if ([...el.children].some((c) => c.getBoundingClientRect().width > vw + 1)) continue;
    wide.push({ right: Math.round(el.getBoundingClientRect().right), width: Math.round(w), el: label(el) });
  }
  wide.sort((a, b) => b.width - a.width);
  return { vw, scrollWidth, overflow: scrollWidth > vw + 1, offenders: offenders.slice(0, 5), wide: wide.slice(0, 3) };
}

async function settle(page) {
  await page.mouse.move(0, 0); // no hover tooltips left open from the last click
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
  await page.waitForFunction(() => !document.body.innerText.includes('Loading…'), null, { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(300);
}

async function main() {
  const { chromium } = await loadPlaywright();
  console.log('starting the app on a fresh test database…');
  const app = await startApp();
  const results = [];
  let browser;
  try {
    browser = await chromium.launch({ headless: !flag('headed'), ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
    rmSync(shotsDir, { recursive: true, force: true });
    const pages = pagesFor(app.ids);
    for (const width of widths) {
      const dir = join(shotsDir, String(width));
      mkdirSync(dir, { recursive: true });
      const context = await browser.newContext({ viewport: { width, height: width < 768 ? 812 : 900 }, baseURL: app.base });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));

      // Sign in through the login page, at this width.
      await page.goto('/login');
      await settle(page);
      results.push({ width, name: 'login', ...(await page.evaluate(measure)) });
      await page.screenshot({ path: join(dir, 'login.png'), fullPage: true });
      await page.locator('input[name="email"]').fill(EMAIL);
      await page.locator('input[name="password"]').fill(PASSWORD);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });

      for (const p of pages) {
        let note = '';
        try {
          await page.goto(p.path);
          await settle(page);
          if (p.action) {
            const did = await p.action(page);
            if (did === false) note = 'nothing to expand';
            await settle(page);
          }
          results.push({ width, name: p.name, note, ...(await page.evaluate(measure)) });
          await page.screenshot({ path: join(dir, `${p.name}.png`), fullPage: true });
          if (p.after) await p.after(page); // puts back what the page's action changed
        } catch (e) {
          results.push({ width, name: p.name, error: e.message.split('\n')[0] });
          await page.screenshot({ path: join(dir, `${p.name}.error.png`), fullPage: true }).catch(() => undefined); // to see where it stopped
        }
      }
      if (width === Math.max(...widths) && !onlyPages) {
        try { await perfCheck(page, app); } catch (e) { results.push({ width, name: 'perf-600-rows', error: e.message.split('\n')[0] }); }
      }
      if (errors.length) console.warn(`page errors at ${width}px:\n  ${[...new Set(errors)].join('\n  ')}`);
      await context.close();
    }
  } finally {
    await browser?.close();
    await app.stop();
  }

  // Summary table, then every overflow with its widest offenders.
  const names = [...new Set(results.map((r) => r.name))];
  const cell = (r) => (!r ? '-' : r.error ? 'ERROR' : r.overflow ? `OVERFLOW ${r.scrollWidth}px` : 'ok');
  const col = Math.max(...names.map((n) => n.length), 4);
  console.log(`\n${'page'.padEnd(col)}  ${widths.map((w) => `${w}px`.padEnd(16)).join('')}`);
  for (const n of names) console.log(`${n.padEnd(col)}  ${widths.map((w) => cell(results.find((r) => r.name === n && r.width === w)).padEnd(16)).join('')}`);
  const bad = results.filter((r) => r.overflow);
  const errored = results.filter((r) => r.error);
  for (const r of bad) {
    console.log(`\n${r.name} @ ${r.width}px scrolls horizontally (document ${r.scrollWidth}px > viewport ${r.vw}px)${r.note ? ` [${r.note}]` : ''}`);
    for (const o of r.offenders) console.log(`  sticks out: right=${o.right}px width=${o.width}px  ${o.el}`);
    for (const o of r.wide) console.log(`  wider than viewport: width=${o.width}px  ${o.el}`);
  }
  for (const r of errored) console.log(`\n${r.name} @ ${r.width}px failed: ${r.error}`);
  console.log(`\nscreenshots: ${relative(process.cwd(), shotsDir)}/<width>/<page>.png`);
  if (errored.length) process.exit(2);
  if (bad.length) {
    console.log(`${bad.length} page/width combination(s) overflow horizontally${reportOnly ? ' (--report-only: not failing)' : ''}`);
    process.exit(reportOnly ? 0 : 1);
  }
  console.log('no horizontal overflow');
}

main().catch((e) => fail(e.stack ?? String(e)));
