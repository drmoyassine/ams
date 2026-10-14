#!/usr/bin/env node
/* global process, console, URL */
// How much of the web app's visible text goes through t()? (`pnpm i18n:coverage`)
//
// Counts, per area (directory) of apps/web/src, using the TypeScript parser (no tests, no .d.ts):
//   t       calls of t('literal.key') (and i18n.t)
//   text    JSX text with letters in it                          <p>Save the draft</p>
//   attr    string attributes people see or hear                   title= placeholder= aria-label= alt= label=
//   expr    string literals written as JSX expressions            {'Save'}  {x ? 'On' : 'Off'}
//   prop    object properties that carry UI wording               label: 'Save'  title: ...  message: ...  hint: ...
// Coverage = t / (t + text + attr + expr + prop). It is an honest approximation: each hard-coded literal counts once
// however long it is, and strings built in logic (error messages from the server, template strings with data) are not
// counted at all, on either side. The point is the trend per area, not an exact number.
//
// Flags: --json (machine-readable), --areas=shell,components (subset).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'apps', 'web', 'src');

const ATTRS = new Set(['title', 'placeholder', 'aria-label', 'aria-description', 'alt', 'label']);
const PROPS = new Set(['label', 'title', 'hint', 'message', 'description', 'placeholder', 'confirmLabel', 'cancelLabel', 'emptyText', 'text', 'caption']);
const hasLetters = (s) => /\p{L}{2,}/u.test(s);

/** Areas, in the order they are reported. The first matching prefix wins. */
export const AREAS = [
  ['shell', ['pages/layout.tsx', 'pages/login.tsx', 'router.tsx', 'main.tsx', 'pages/settings/layout.tsx']],
  ['components/ui', ['components/ui/']],
  ['components/shared chrome', ['components/dialog.tsx', 'components/confirm-dialog.tsx', 'components/undo-toaster.tsx', 'components/bottom-sheet.tsx', 'components/read-only-note.tsx', 'components/badges.tsx', 'components/institution-mark.tsx', 'components/accordion.tsx', 'components/term-mode.tsx', 'components/content-text.tsx']],
  ['components/assistant', ['components/assistant/']],
  ['components/tree', ['components/tree/']],
  ['components/other', ['components/']],
  ['pages/settings (Organization, Languages)', ['pages/settings/organization', 'pages/settings/languages', 'pages/settings/programs']],
  ['pages/settings (other)', ['pages/settings/']],
  ['pages/version', ['pages/version']],
  ['pages/engagement', ['pages/engagement']],
  ['pages/other', ['pages/']],
  ['lib', ['lib/']],
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) yield p;
  }
}

export function countFile(text, fileName = 'x.tsx') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const c = { t: 0, text: 0, attr: 0, expr: 0, prop: 0 };
  const inJsx = (n) => { for (let p = n.parent; p; p = p.parent) if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p)) return true; return false; };
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      const first = n.arguments[0];
      if (name === 't' && first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) c.t++;
    } else if (ts.isJsxText(n)) {
      if (hasLetters(n.getText(sf))) c.text++;
    } else if (ts.isJsxAttribute(n)) {
      const nm = n.name.getText(sf);
      const init = n.initializer;
      if (ATTRS.has(nm) && init) {
        if (ts.isStringLiteral(init) && hasLetters(init.text)) c.attr++;
        else if (ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression)) && hasLetters(init.expression.text)) c.attr++;
        else if (ts.isJsxExpression(init) && init.expression && ts.isTemplateExpression(init.expression) && hasLetters(init.expression.head.text)) c.attr++;
      }
    } else if (ts.isJsxExpression(n) && n.expression && !ts.isJsxAttribute(n.parent)) {
      const lits = [];
      const collect = (e) => {
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) lits.push(e.text);
        else if (ts.isTemplateExpression(e)) lits.push(e.head.text, ...e.templateSpans.map((s) => s.literal.text));
        else if (ts.isConditionalExpression(e)) { collect(e.whenTrue); collect(e.whenFalse); }
        else if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) { collect(e.right); }
        else if (ts.isParenthesizedExpression(e)) collect(e.expression);
      };
      collect(n.expression);
      c.expr += lits.filter(hasLetters).length > 0 ? 1 : 0;
    } else if (ts.isPropertyAssignment(n) && n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && PROPS.has(n.name.text)) {
      const v = n.initializer;
      if ((ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) && hasLetters(v.text) && /\s|^[A-Z]/.test(v.text)) c.prop++;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  void inJsx;
  return c;
}

export function measure() {
  const out = new Map(AREAS.map(([name]) => [name, { t: 0, text: 0, attr: 0, expr: 0, prop: 0, files: 0 }]));
  for (const file of walk(src)) {
    const rel = relative(src, file).split(sep).join('/');
    const area = AREAS.find(([, prefixes]) => prefixes.some((p) => rel === p || rel.startsWith(p)));
    if (!area) continue;
    const c = countFile(readFileSync(file, 'utf8'), file);
    const o = out.get(area[0]);
    for (const k of Object.keys(c)) o[k] += c[k];
    o.files++;
  }
  return out;
}

const literal = (c) => c.text + c.attr + c.expr + c.prop;
const pct = (c) => (c.t + literal(c) === 0 ? 100 : (100 * c.t) / (c.t + literal(c)));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const only = process.argv.find((a) => a.startsWith('--areas='))?.split('=')[1]?.split(',');
  const m = measure();
  const total = { t: 0, text: 0, attr: 0, expr: 0, prop: 0, files: 0 };
  const rows = [];
  for (const [name, c] of m) {
    if (only && !only.some((o) => name.includes(o))) continue;
    rows.push({ area: name, ...c, literal: literal(c), coverage: Math.round(pct(c) * 10) / 10 });
    for (const k of Object.keys(total)) total[k] += c[k];
  }
  const all = { area: 'ALL', ...total, literal: literal(total), coverage: Math.round(pct(total) * 10) / 10 };
  if (process.argv.includes('--json')) console.log(JSON.stringify({ rows, total: all }, null, 2));
  else {
    console.log(['area', 'files', 't()', 'text', 'attr', 'expr', 'prop', 'literal', 'coverage'].join('\t'));
    for (const r of [...rows, all]) console.log([r.area, r.files, r.t, r.text, r.attr, r.expr, r.prop, r.literal, `${r.coverage}%`].join('\t'));
  }
}
