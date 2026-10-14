#!/usr/bin/env node
/* global process, console, URL */
// `pnpm i18n:extract` (needs `pnpm build`): finds every t('literal.key') in apps/web/src, checks each key exists in the English
// catalogue (packages/shared/src/locales/en.ts) and lists the missing ones. Exit 1 when a key used in the code is missing (the
// app would show the key itself). Also lists catalogue keys nothing uses (information; a key built at run time cannot be seen).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EN_CATALOGUE, PUBLIC_UI_KEYS, checkCatalogue, findTranslationKeys } from '../packages/shared/dist/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
// I18N_WEB_SRC points the check at another folder (the script's own test uses it).
const src = process.env.I18N_WEB_SRC ?? join(root, 'apps', 'web', 'src');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) yield p;
  }
}

const used = new Map();
for (const file of walk(src)) {
  for (const key of findTranslationKeys(readFileSync(file, 'utf8'))) {
    const files = used.get(key) ?? [];
    files.push(relative(process.env.I18N_WEB_SRC ? src : root, file));
    used.set(key, files);
  }
}
const result = checkCatalogue(used, EN_CATALOGUE, PUBLIC_UI_KEYS);
console.log(`${used.size} keys used in the code, ${Object.keys(EN_CATALOGUE).length} in the English catalogue.`);
if (result.unused.length) console.log(`\nIn the catalogue but not used by a literal t() call (${result.unused.length}):\n  ${result.unused.join('\n  ')}`);
if (result.publicMissing.length) console.log(`\nSign-in keys missing from the catalogue:\n  ${result.publicMissing.join('\n  ')}`);
if (result.missing.length) {
  console.log(`\nMISSING from packages/shared/src/locales/en.ts (${result.missing.length}):`);
  for (const m of result.missing) console.log(`  ${m.key}   (${m.files.join(', ')})`);
}
process.exit(result.missing.length || result.publicMissing.length ? 1 : 0);
