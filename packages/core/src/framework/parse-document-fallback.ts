// TEMPORARY (DEC-011 amendment): the formats the owned parser (@drmoyassine/liteparse) does not read yet.
//
// parseDocument() reads everything it can with the owned @drmoyassine/liteparse. That package has no reader for
// PowerPoint (PPTX/PPT), OpenDocument (ODT/ODS/ODP), RTF or the legacy binary Word and Excel files (DOC/XLS): it
// reports legacy Office as unsupported and would decode the rest as plain text. Until the owner adds them to the
// library (see docs/liteparse-appendix-d-status.md, "Formats"), exactly those formats are read here with the upstream
// @llamaindex/liteparse, which converts them to PDF with LibreOffice. This is the ONLY file that imports that package
// and the ONLY reason the parser image carries LibreOffice and ImageMagick. When the owned library reads these
// formats, delete this file, the dependency, the image packages and the CI install step.
//
// It does not run OCR: Office documents have a real text layer; a slide with only pictures is reported as empty.
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import { LiteParse, ParseTimeoutError, type LiteParseConfig } from '@llamaindex/liteparse';
import { DocumentReadError } from './parse-errors.js';

/** Who reads these files, for the job result. */
export const FALLBACK_PARSER = { name: '@llamaindex/liteparse', version: ((): string => {
  try { return (createRequire(import.meta.url)('@llamaindex/liteparse/package.json') as { version: string }).version; } catch { return 'unknown'; }
})() };

/** The formats this file reads, with what a page of each is. */
export const FALLBACK_FORMATS = {
  doc: 'text', odt: 'text', rtf: 'text',
  xls: 'sheet', ods: 'sheet',
  ppt: 'slides', pptx: 'slides', odp: 'slides',
} as const;
export type FallbackFormat = keyof typeof FALLBACK_FORMATS;
export const isFallbackFormat = (f: string): f is FallbackFormat => f in FALLBACK_FORMATS;

export interface FallbackPage { pageNo: number; text: string; kind: 'text' | 'sheet' | 'slides'; warnings: string[] }
export interface FallbackLimits { timeoutMs: number; maxPages: number }

/** The LibreOffice binary the fallback uses (`soffice` or `libreoffice` on PATH), or null. Used for the startup log. */
export async function findLibreOffice(): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of ['libreoffice', 'soffice']) {
      try { await access(join(dir, name), constants.X_OK); return join(dir, name); } catch { /* next */ }
    }
  }
  return null;
}

/** Reads one file of a fallback format into pages. Throws DocumentReadError (corrupt, converter_missing, timeout). */
export async function readWithFallback(format: FallbackFormat, bytes: Uint8Array, limits: FallbackLimits): Promise<{ pages: FallbackPage[]; warnings: string[] }> {
  const kind = FALLBACK_FORMATS[format];
  const parser = new LiteParse({
    ocrEnabled: false, quiet: true, continueOnPageError: true, outputFormat: 'json',
    maxPages: limits.maxPages, poolSize: 1, parseTimeoutMs: limits.timeoutMs,
  } as Partial<LiteParseConfig>);
  let result;
  try {
    result = await parser.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch (e) {
    throw mapError(format, e);
  } finally {
    parser.close();
  }
  const errors = new Map(result.pageErrors.map((e) => [e.pageNum, e.message]));
  const pages = result.pages.map((p): FallbackPage => {
    const text = kind === 'sheet' ? tidySheet(p.text ?? '') : (p.text ?? '').trim();
    const warnings: string[] = [];
    const error = errors.get(p.pageNum);
    if (error) warnings.push(`page could not be read: ${error}`);
    if (!text) warnings.push(kind === 'slides' ? 'the slide has no text (it may hold only pictures)' : 'the page has no text');
    return { pageNo: p.pageNum, text, kind, warnings };
  });
  const warnings: string[] = [];
  if (result.totalPages > result.pages.length) warnings.push(`only the first ${result.pages.length} of ${result.totalPages} pages were read (PARSER_MAX_PAGES)`);
  return { pages, warnings };
}

function mapError(format: FallbackFormat, e: unknown): DocumentReadError {
  if (e instanceof DocumentReadError) return e;
  const name = format.toUpperCase();
  if (e instanceof ParseTimeoutError) return new DocumentReadError('timeout', `the ${name} file took longer than ${Math.round(e.timeoutMs / 1000)} seconds to read and was stopped`);
  const msg = String((e as Error)?.message ?? e).replace(/^liteparse worker process died while parsing [^:]*: /, '');
  if (/libreoffice is not installed/i.test(msg)) {
    return new DocumentReadError('converter_missing', `LibreOffice is not installed on the parser service, so ${name} files cannot be read (install libreoffice-core with writer, calc and impress; the parser image includes them)`);
  }
  if (/magick/i.test(msg)) return new DocumentReadError('converter_missing', `ImageMagick is not installed on the parser service, so ${name} files cannot be read (the parser image includes it): ${msg}`);
  return new DocumentReadError('corrupt', `the ${name} file could not be read (${msg})`);
}

/** The printed page of a sheet: drops LibreOffice's default "Page N" footer and the alignment indent of each line. */
function tidySheet(text: string): string {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const trim = () => { while (lines.length && !lines.at(-1)) lines.pop(); while (lines.length && !lines[0]) lines.shift(); };
  trim();
  if (lines.length && /^\s*Page \d+$/.test(lines.at(-1)!)) { lines.pop(); trim(); }
  return lines.map((l) => l.trim()).join('\n');
}
