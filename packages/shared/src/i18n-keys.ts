// Helpers for translation keys and placeholders, shared by the web app, the extract script (`pnpm i18n:extract`), the
// translation job's validator and the lint rule's tests.

/** Keys used as t('literal.key') or i18n.t('literal.key') in a source file (a key built at run time cannot be found). */
export function findTranslationKeys(source: string): string[] {
  const keys = new Set<string>();
  const re = /(?<![\w$])t\(\s*(['"`])([A-Za-z][A-Za-z0-9_.-]*)\1/g;
  for (let m = re.exec(source); m; m = re.exec(source)) keys.add(m[2]!);
  return [...keys];
}

/** Placeholders such as {{count}} in a string, in order of first appearance, without duplicates. */
export function placeholdersOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/**
 * Why `translated` cannot stand in for `source`, or null when it can. Deterministic: every {{placeholder}} of the
 * English must be present, written exactly (not translated, spaced or renamed) and no other one may appear; the text
 * must not be empty; it must not introduce HTML the English does not have.
 */
export function translationProblem(source: string, translated: string): string | null {
  if (translated.trim() === '') return 'the translation is empty';
  const want = placeholdersOf(source);
  const got = placeholdersOf(translated);
  const missing = want.filter((p) => !got.includes(p));
  if (missing.length) return `placeholder ${missing.map((p) => `{{${p}}}`).join(', ')} is missing or was changed`;
  const extra = got.filter((p) => !want.includes(p));
  if (extra.length) return `placeholder ${extra.map((p) => `{{${p}}}`).join(', ')} is not in the English`;
  // Spelled exactly: {{ count }} is accepted by i18next but a translation must keep the English form.
  for (const p of want) if (source.includes(`{{${p}}}`) && !translated.includes(`{{${p}}}`)) return `placeholder {{${p}}} must be written exactly as in the English`;
  if (/<\/?[a-z][^>]*>/i.test(translated) && !/<\/?[a-z][^>]*>/i.test(source)) return 'the translation contains HTML that the English does not';
  return null;
}

export interface CatalogueCheck {
  /** Keys used in the code that the English catalogue lacks, with the files that use them. */
  missing: { key: string; files: string[] }[];
  /** Catalogue keys no file uses (informational: dynamic keys cannot be seen). */
  unused: string[];
  /** Sign-in keys that are not in the catalogue. */
  publicMissing: string[];
}

/** `pnpm i18n:extract`: compares the keys the code uses (key -> files) with the English catalogue. */
export function checkCatalogue(used: ReadonlyMap<string, string[]>, catalogue: Readonly<Record<string, string>>, publicKeys: readonly string[] = []): CatalogueCheck {
  return {
    missing: [...used].filter(([key]) => !(key in catalogue)).map(([key, files]) => ({ key, files })).sort((a, b) => a.key.localeCompare(b.key)),
    unused: Object.keys(catalogue).filter((k) => !used.has(k)).sort(),
    publicMissing: publicKeys.filter((k) => !(k in catalogue)),
  };
}
