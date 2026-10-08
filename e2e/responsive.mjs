#!/usr/bin/env node
/* global process, console, fetch, TextEncoder, URL, window, document, getComputedStyle */
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
    return { base, ids, stop };
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
  const warn = (what, e) => console.warn(`seed: ${what} skipped (${e.message})`);
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
  return ids;
}

/** Clicks the first closed accordion/disclosure inside the main content. */
async function expandFirst(page) {
  const btn = page.locator('main button[aria-expanded="false"]:not([aria-haspopup])').first();
  if (await btn.count()) { await btn.click(); return true; }
  return false;
}
const clickTab = (name) => async (page) => { await page.getByRole('tab', { name }).first().click(); };

function pagesFor(ids) {
  return [
    { name: 'engagements', path: '/engagements' },
    ids.engagementId && { name: 'engagement', path: `/engagements/${ids.engagementId}` },
    { name: 'evidence-library', path: '/evidence' },
    { name: 'evidence-card-open', path: '/evidence', action: expandFirst },
    { name: 'evidence-requests', path: '/evidence', action: clickTab('Requests') },
    { name: 'my-requests', path: '/requests' },
    { name: 'settings-organization', path: '/settings/organization' },
    { name: 'settings-programs', path: '/settings/programs' },
    { name: 'settings-quality-framework', path: '/settings/quality-framework' },
    { name: 'settings-external-standards', path: '/settings/external-standards' },
    { name: 'settings-ai', path: '/settings/ai' },
    { name: 'version-requirements', path: `/settings/versions/${ids.versionId}`, action: expandFirst },
    { name: 'version-settings', path: `/settings/versions/${ids.versionId}?tab=settings` },
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
        } catch (e) {
          results.push({ width, name: p.name, error: e.message.split('\n')[0] });
        }
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
