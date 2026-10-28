// parseDocument(): the ONE place the AMS reads a file into per-page text (DEC-011, PRD 15.1 step 3).
//
// The parser is the owned @drmoyassine/liteparse (isomorphic, pure JS), imported only in this file:
//   - PDF: pdfjs-dist (its peer) gives the text layer; pages that have none are rendered (sharp + @napi-rs/canvas) and
//     read by the vision hook (`ocrPage`, i.e. aiOcr with our budget, logging and language hint) or, when switched on,
//     by local RapidOCR first. liteparse decides native / ocr / vlm per call, so this file calls it ONE PAGE AT A TIME:
//     the injected pdfjs shows it a single page (see `pageLibrary`). That gives true per-page method attribution and
//     per-page escalation, which its whole-document result does not (it joins a digital PDF into one page and decides
//     scanned-or-not once, from the first three pages).
//   - DOCX, XLSX, CSV/TSV and images: one liteparse call. It returns one page for each; XLSX sheets are split back
//     into pages here from its own "# Sheet" headers (the only structure it exposes). See
//     docs/liteparse-appendix-d-status.md for what it cannot do yet (DOCX pages/headings, table structure, ...).
//   - PowerPoint, OpenDocument, RTF and legacy DOC/XLS are NOT read by it: parse-document-fallback.ts (temporary).
// What this file adds on top: format detection and magic-number checks, typed errors, time and page limits, NFC, the
// one-page-per-call plumbing, a text-layer quality check (liteparse has none), line breaks kept in native text, UTF-16
// CSV and non-PNG image conversion, and the budget on AI-read pages. No model is called from here: the vision hook is
// injected by the caller. Host-agnostic: bytes in, pages out. Text is NFC (Arabic is first-class content).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { OcrEngine, PdfLibrary, RasterAdapter, VlmGateway } from '@drmoyassine/liteparse';
import { FALLBACK_PARSER, findLibreOffice, isFallbackFormat, readWithFallback, type FallbackPage } from './parse-document-fallback.js';
import { DocumentReadError, UnsupportedDocumentError } from './parse-errors.js';

export { DocumentReadError, UnsupportedDocumentError, findLibreOffice };
export type { DocumentReadErrorCode } from './parse-errors.js';

export type PageMethod = 'pdf_text' | 'ocr' | 'table' | 'slide' | 'sheet';
export type DocumentFormat =
  | 'pdf' | 'docx' | 'doc' | 'odt' | 'rtf' | 'xlsx' | 'xls' | 'ods' | 'csv' | 'tsv' | 'pptx' | 'ppt' | 'odp'
  | 'png' | 'jpg' | 'tiff' | 'webp' | 'bmp' | 'gif';

export interface ParsedDocumentPage {
  pageNo: number;
  text: string;
  /** pdf_text: the text layer (or the text of a Word document); slide/sheet/table: a presentation slide, a spreadsheet sheet, a CSV; ocr: read by local OCR or the vision hook. */
  method: PageMethod;
  /** The page has no usable text layer: it should be read by OCR (or a vision model). */
  needsOcr: boolean;
  warnings: string[];
}

/** What the OCR hook receives for a page that needs it. `image` is a PNG render of the page. */
export interface OcrPageRequest { pageNo: number; image: Uint8Array; language: string; text: string }
/** Returns the page's text, or null/empty when it could not be read. */
export type OcrPageHook = (page: OcrPageRequest) => Promise<string | null | undefined>;

export interface ParseDocumentInput {
  bytes: Uint8Array;
  mime?: string | null;
  fileName?: string | null;
  /** Language hint (e.g. 'en', 'ar'); passed on to the OCR hook. */
  language?: string;
  ocrPage?: OcrPageHook;
  /** Quarter turns clockwise (0, 90, 180, 270) applied to each page picture before the OCR hook sees it (a scan made sideways). */
  rotation?: number;
  /** At most this many pages are rendered and handed to the OCR hook; the rest stay flagged `needsOcr` with a warning. */
  ocrMaxPages?: number;
}

/** Who read the file, for the job result (there is no column for it on source_page). */
export interface ParserInfo {
  name: string;
  version: string;
  /** Hash of the settings that change what the parser returns (reproducibility, LP8). */
  configHash: string;
  /** True when the temporary fallback reader (not the owned parser) read this file. */
  fallback: boolean;
}

export interface ParsedDocument {
  format: DocumentFormat;
  pages: ParsedDocumentPage[];
  /** Document-level notes (e.g. pages beyond the page cap were not read). */
  warnings: string[];
  parser: ParserInfo;
}

/** A page with fewer non-space characters than this is treated as having no text layer. */
export const MIN_PAGE_TEXT_CHARS = 20;
/** Per-file limits (env-tunable on the parser service). */
const timeoutMs = () => Math.max(0.001, Number(process.env.PARSER_TIMEOUT_SECONDS ?? 300)) * 1000;
const maxPages = () => Math.max(1, Number(process.env.PARSER_MAX_PAGES ?? 1000));
const pageTimeoutMs = () => Math.max(1, Number(process.env.PARSER_PAGE_TIMEOUT_SECONDS ?? 120)) * 1000;
const rasterMaxEdge = () => Math.max(400, Number(process.env.PARSER_RASTER_MAX_EDGE ?? 2000));

type Kind = 'pdf' | 'docx' | 'sheet' | 'csv' | 'image' | 'fallback';
const FORMATS: Record<DocumentFormat, { kind: Kind; ext: string[]; mime: string[] }> = {
  pdf: { kind: 'pdf', ext: ['pdf'], mime: ['application/pdf'] },
  docx: { kind: 'docx', ext: ['docx'], mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
  doc: { kind: 'fallback', ext: ['doc'], mime: ['application/msword'] },
  odt: { kind: 'fallback', ext: ['odt'], mime: ['application/vnd.oasis.opendocument.text'] },
  rtf: { kind: 'fallback', ext: ['rtf'], mime: ['application/rtf', 'text/rtf'] },
  xlsx: { kind: 'sheet', ext: ['xlsx'], mime: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
  xls: { kind: 'fallback', ext: ['xls'], mime: ['application/vnd.ms-excel'] },
  ods: { kind: 'fallback', ext: ['ods'], mime: ['application/vnd.oasis.opendocument.spreadsheet'] },
  csv: { kind: 'csv', ext: ['csv'], mime: ['text/csv', 'application/csv'] },
  tsv: { kind: 'csv', ext: ['tsv'], mime: ['text/tab-separated-values'] },
  pptx: { kind: 'fallback', ext: ['pptx'], mime: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'] },
  ppt: { kind: 'fallback', ext: ['ppt'], mime: ['application/vnd.ms-powerpoint'] },
  odp: { kind: 'fallback', ext: ['odp'], mime: ['application/vnd.oasis.opendocument.presentation'] },
  png: { kind: 'image', ext: ['png'], mime: ['image/png'] },
  jpg: { kind: 'image', ext: ['jpg', 'jpeg'], mime: ['image/jpeg'] },
  tiff: { kind: 'image', ext: ['tif', 'tiff'], mime: ['image/tiff'] },
  webp: { kind: 'image', ext: ['webp'], mime: ['image/webp'] },
  bmp: { kind: 'image', ext: ['bmp'], mime: ['image/bmp'] },
  gif: { kind: 'image', ext: ['gif'], mime: ['image/gif'] },
};
const ALL = Object.keys(FORMATS) as DocumentFormat[];
const byExt = new Map(ALL.flatMap((f) => FORMATS[f].ext.map((e) => [e, f] as const)));
const byMime = new Map(ALL.flatMap((f) => FORMATS[f].mime.map((m) => [m, f] as const)));

/** The file types a source can be read from: used by the upload allowlist and the file pickers. */
export const SOURCE_EXTENSIONS = ALL.flatMap((f) => FORMATS[f].ext);
export const SOURCE_MIME_TYPES = ALL.flatMap((f) => FORMATS[f].mime);
export const UNSUPPORTED_FILE_MESSAGE = 'this file type cannot be read; use PDF, Word, Excel, PowerPoint, OpenDocument, RTF, CSV or an image (PNG, JPEG, TIFF, WebP)';

const has = (b: Uint8Array, s: string, at = 0) => s.split('').every((ch, i) => b[at + i] === ch.charCodeAt(0));
const contains = (b: Uint8Array, s: string) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).includes(s);

/** Decides the format from the file name, then the mime type, then the content itself. */
export function detectFormat(input: Pick<ParseDocumentInput, 'bytes' | 'mime' | 'fileName'>): DocumentFormat | null {
  const ext = input.fileName?.split('.').pop()?.toLowerCase();
  if (ext && byExt.has(ext)) return byExt.get(ext)!;
  const mime = input.mime?.split(';')[0]?.trim().toLowerCase();
  if (mime && byMime.has(mime)) return byMime.get(mime)!;
  const b = input.bytes;
  if (has(b, '%PDF-')) return 'pdf';
  if (has(b, '\x89PNG')) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (has(b, 'GIF8')) return 'gif';
  if (has(b, 'RIFF') && has(b, 'WEBP', 8)) return 'webp';
  if (has(b, '{\\rtf')) return 'rtf';
  if ((has(b, 'II') && b[2] === 42) || (has(b, 'MM') && b[3] === 42)) return 'tiff';
  if (has(b, 'PK')) {
    const head = b.subarray(0, Math.min(b.length, 1 << 20));
    if (contains(head, 'word/document.xml')) return 'docx';
    if (contains(head, 'xl/workbook.xml')) return 'xlsx';
    if (contains(head, 'ppt/presentation.xml')) return 'pptx';
    if (contains(head, 'application/vnd.oasis.opendocument.text')) return 'odt';
    if (contains(head, 'application/vnd.oasis.opendocument.spreadsheet')) return 'ods';
    if (contains(head, 'application/vnd.oasis.opendocument.presentation')) return 'odp';
  }
  return null;
}

/** Magic-number checks, so a renamed or truncated file is a clear error and not a mis-read (liteparse would treat plain text as a document). */
function checkSignature(format: DocumentFormat, b: Uint8Array) {
  const bad = (what: string) => new DocumentReadError('corrupt', `the ${format.toUpperCase()} file could not be read: it is not a valid ${what}`);
  if (format === 'pdf' && !contains(b.subarray(0, 1024), '%PDF-')) throw bad('PDF');
  if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(format) && !has(b, 'PK')) throw bad('Office/OpenDocument (zip) file');
  if (['doc', 'xls', 'ppt'].includes(format) && !(b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0)) throw bad('Office file');
  if (format === 'rtf' && !has(b, '{\\rtf')) throw bad('RTF file');
}

// ------------------------------------------------------------------------------------------ the owned parser

type Lite = typeof import('@drmoyassine/liteparse');
let liteLoad: Promise<Lite> | undefined;
/** Loads liteparse on first use (and keeps its one line of start-up logging out of the service log). */
function loadLiteparse(): Promise<Lite> {
  liteLoad ??= (async () => {
    const log = console.log;
    console.log = (...args: unknown[]) => { if (!(typeof args[0] === 'string' && args[0].startsWith('[ocr-worker]'))) log(...args); };
    try { return await import('@drmoyassine/liteparse'); } finally { console.log = log; }
  })();
  return liteLoad;
}

/** The structural slice of pdfjs this file uses (the library types are not imported: pdfjs is liteparse's optional peer). */
interface PdfTextItem { str?: string; hasEOL?: boolean }
interface PdfPageProxy {
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: Record<string, unknown>): { promise: Promise<void> };
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  cleanup?(): void;
}
interface PdfDocProxy { numPages: number; getPage(n: number): Promise<PdfPageProxy>; destroy?(): Promise<void> }
interface PdfJs { getDocument(p: Record<string, unknown>): { promise: Promise<PdfDocProxy> }; GlobalWorkerOptions?: { workerSrc?: string }; version?: string }

const require = createRequire(import.meta.url);
let pdfjsLoad: Promise<PdfJs> | undefined;
const loadPdfjs = () => (pdfjsLoad ??= (async () => {
  const spec = 'pdfjs-dist/legacy/build/pdf.mjs'; // the build for Node (the default build needs browser globals)
  return (await import(spec)) as PdfJs;
})());
const pdfjsRoot = () => dirname(require.resolve('pdfjs-dist/package.json'));

/** pdfjs drops a text-less item's line end unless it is marked; liteparse collapses all whitespace, so line ends travel as this character. */
const EOL = '\u0085';
const fromEol = (s: string) => s.replace(/[ \t]*\u0085[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
/** Stands in for the bytes of a PDF whose pages liteparse reads through the injected pdfjs: only the magic number is looked at. */
// (Copies into this realm's Uint8Array: liteparse checks `instanceof Uint8Array`, which fails for bytes from another realm, e.g. jsdom's.)
const PDF_STUB = new Uint8Array(new TextEncoder().encode('%PDF-1.7\n'));

interface PageView { library: PdfLibrary; plainText: () => Promise<string> }
/**
 * An injected pdfjs that shows liteparse a one-page document: page `pageNo` of the real, already opened file. liteparse
 * then classifies, extracts, renders and escalates THAT page alone. `blank` hides the text layer (a corrupted layer is
 * re-read as a scan). The text items are marked with line ends and the text the page has is kept for `plainText()`.
 */
function pageLibrary(pdfjs: PdfJs, doc: PdfDocProxy, pageNo: number, blank: boolean): PageView {
  let real: Promise<PdfPageProxy> | undefined;
  let content: Promise<string> | undefined;
  const page = () => (real ??= doc.getPage(pageNo));
  const text = () => (content ??= page().then((p) => p.getTextContent()).then((c) => c.items.map((i) => (i.str ?? '') + (i.hasEOL ? EOL : '')).join('')));
  const proxy = async (): Promise<PdfDocProxy> => {
    const p = await page();
    const shown: PdfPageProxy = {
      getViewport: (o) => p.getViewport(o),
      render: (o) => p.render(o),
      getTextContent: async () => {
        if (blank) return { items: [] };
        const c = await p.getTextContent();
        return { items: c.items.map((i) => (i.hasEOL ? { ...i, str: (i.str ?? '') + EOL } : i)) };
      },
    };
    return { numPages: 1, getPage: async () => shown };
  };
  const library = { getDocument: () => ({ promise: proxy() }), GlobalWorkerOptions: pdfjs.GlobalWorkerOptions } as unknown as PdfLibrary;
  return { library, plainText: async () => (blank ? '' : fromEol(await text())) };
}

// ---------------------------------------------------------------------------------------- text-layer quality

const nonSpace = (s: string) => s.replace(/\s/g, '').length;
/** Characters that do not belong inside a word of normal text: what a mis-mapped font puts in place of letters. */
const NOISE_IN_WORD = /\p{L}[€£¥¢§¤¦¬¨´^~|\\{}]|[€£¥¢§¤¦¬¨´^~|\\{}]\p{L}/u;

/**
 * Is this native text layer corrupted (LP3)? liteparse has no text-quality check, so this is ours: replacement
 * characters, private-use glyphs or control characters in bulk, or a tenth of the words holding a symbol where a letter
 * should be ("Asflranc€"). A letter swapped for another letter ("Accrtditation") cannot be seen without a dictionary.
 */
export function textLayerLooksCorrupt(text: string): boolean {
  const chars = [...text.replace(/\s/g, '')];
  if (chars.length < MIN_PAGE_TEXT_CHARS) return false;
  const bad = chars.filter((c) => c === '�' || (c >= '' && c <= '') || c.charCodeAt(0) < 32).length;
  if (bad / chars.length > 0.3) return true;
  const words = text.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  return words.length >= 20 && words.filter((w) => NOISE_IN_WORD.test(w)).length / words.length > 0.1;
}

// -------------------------------------------------------------------------------------------- configuration

interface Runtime { lite: Lite; raster?: RasterAdapter; localOcr?: OcrEngine }

let rasterLoad: Promise<{ raster?: RasterAdapter; note?: string }> | undefined;
/** The page renderer (sharp + @napi-rs/canvas); without it scanned pages cannot be sent to a vision model. */
function loadRaster(): Promise<{ raster?: RasterAdapter; note?: string }> {
  rasterLoad ??= (async () => {
    try {
      const { createSharpRaster } = await import('@drmoyassine/liteparse/raster/sharp');
      const base = await createSharpRaster();
      const raster: RasterAdapter = { ...base, rasterizePdfPage: (doc, i, o) => base.rasterizePdfPage(doc, i, { maxEdge: rasterMaxEdge(), ...o }) };
      return { raster };
    } catch (e) {
      return { note: `scanned pages cannot be rendered on this service (sharp or @napi-rs/canvas failed to load: ${(e as Error).message})` };
    }
  })();
  return rasterLoad;
}

const localOcrLoads = new Map<string, Promise<{ engine?: OcrEngine; note?: string }>>();
/**
 * Local OCR (RapidOCR on onnxruntime-node) before the vision model. OFF unless PARSER_LOCAL_OCR=rapidocr. It needs the
 * `onnxruntime-node` package and the three model files in RAPIDOCR_MODEL_PATH (ch_PP-OCRv4_det_infer.onnx,
 * en_PP-OCRv4_rec_infer.onnx, ppocr-en-dict.txt), baked into the image: nothing is downloaded at run time. The packaged
 * recognition model is English only, so it is used for English sources only (see docs/liteparse-appendix-d-status.md).
 */
function loadLocalOcr(): Promise<{ engine?: OcrEngine; note?: string }> {
  if (process.env.PARSER_LOCAL_OCR !== 'rapidocr') return Promise.resolve({});
  const modelPath = process.env.RAPIDOCR_MODEL_PATH;
  const key = modelPath ?? '';
  if (!localOcrLoads.has(key)) {
    localOcrLoads.set(key, (async () => {
      try {
        const { createRapidOcrServerEngine } = await import('@drmoyassine/liteparse/ocr/rapidocr-server');
        return { engine: await createRapidOcrServerEngine({ modelPath }) };
      } catch (e) {
        return { note: `local OCR (PARSER_LOCAL_OCR=rapidocr) is not available, scanned pages go to the vision model: ${(e as Error).message}` };
      }
    })());
  }
  return localOcrLoads.get(key)!;
}

/** Identifies the parser and the settings that decide what it returns, for the job result. */
function parserInfo(lite: Lite, local: boolean): ParserInfo {
  const settings = { parser: lite.VERSION, minPageTextChars: MIN_PAGE_TEXT_CHARS, rasterMaxEdge: rasterMaxEdge(), localOcr: local, eol: true };
  return { name: '@drmoyassine/liteparse', version: lite.VERSION, configHash: createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 16), fallback: false };
}

// ------------------------------------------------------------------------------------------------- parsing

const nfc = (s: string) => s.normalize('NFC');

/** Reads a file into ordered pages. Throws DocumentReadError (UnsupportedDocumentError for a type it cannot read). */
export async function parseDocument(input: ParseDocumentInput): Promise<ParsedDocument> {
  const format = detectFormat(input);
  if (!format) throw new UnsupportedDocumentError(UNSUPPORTED_FILE_MESSAGE);
  if (!input.bytes.byteLength) throw new UnsupportedDocumentError('the file is empty');
  checkSignature(format, input.bytes);
  const kind = FORMATS[format].kind;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs());
  try {
    const done = kind === 'fallback' ? await readFallback(format, input)
      : kind === 'pdf' ? await readPdf(input, abort.signal)
        : await readOther(format, kind, input, abort.signal);
    return { format, ...done, pages: done.pages.map((p) => ({ ...p, text: nfc(p.text) })) };
  } catch (e) {
    throw mapError(format, e, abort.signal);
  } finally {
    clearTimeout(timer);
  }
}

function mapError(format: DocumentFormat, e: unknown, signal: AbortSignal): DocumentReadError {
  if (e instanceof DocumentReadError) return e;
  const name = format.toUpperCase();
  const err = e as Error;
  if (signal.aborted || err?.name === 'AbortError') return new DocumentReadError('timeout', `the ${name} file took longer than ${Math.round(timeoutMs() / 1000)} seconds to read and was stopped`);
  if (err?.name === 'PasswordException') return new DocumentReadError('corrupt', `the ${name} file could not be read (it is password protected)`);
  return new DocumentReadError('corrupt', `the ${name} file could not be read (${err?.message ?? e})`);
}

type Done = Pick<ParsedDocument, 'pages' | 'warnings' | 'parser'>;

// ---------------------------------------------------------------------------------------------- fallback

async function readFallback(format: DocumentFormat, input: ParseDocumentInput): Promise<Done> {
  if (!isFallbackFormat(format)) throw new UnsupportedDocumentError(UNSUPPORTED_FILE_MESSAGE);
  const { pages, warnings } = await readWithFallback(format, input.bytes, { timeoutMs: timeoutMs(), maxPages: maxPages() });
  const method = { text: 'pdf_text', sheet: 'sheet', slides: 'slide' } as const;
  const lite = await loadLiteparse();
  return {
    pages: pages.map((p: FallbackPage) => ({ pageNo: p.pageNo, text: p.text, method: method[p.kind], needsOcr: false, warnings: p.warnings })),
    warnings,
    parser: { ...parserInfo(lite, false), name: FALLBACK_PARSER.name, version: FALLBACK_PARSER.version, fallback: true },
  };
}

// ------------------------------------------------------------------------------------------------- PDF

/** Pages the vision hook may read in one file (Settings -> AI -> Reading); liteparse asks the hook through `vlm`. */
interface Budget { used: number; limit: number }
/** What happened when the hook was asked about one page, for the page's warnings. */
interface HookNote { error?: string; empty?: boolean; limit?: number }

/** A page picture turned by the document's rotation (clockwise quarter turns); untouched when there is none. */
async function turned(png: Uint8Array, degrees: number | undefined): Promise<Uint8Array> {
  if (!degrees) return png;
  const { default: sharp } = await import('sharp');
  return new Uint8Array(await sharp(png).rotate(degrees).png().toBuffer());
}

/** liteparse's vision gateway, backed by the caller's OCR hook: counts pages against the budget and never throws. */
function hookGateway(input: ParseDocumentInput, pageNo: number, budget: Budget, note: HookNote, textOf: () => Promise<string>): VlmGateway | undefined {
  if (!input.ocrPage) return undefined;
  return {
    async readImage(png) {
      if (budget.used >= budget.limit) { note.limit = budget.limit; return ''; }
      budget.used++;
      try {
        const text = (await input.ocrPage!({ pageNo, image: await turned(png, input.rotation),  language: input.language ?? 'en', text: await textOf() }))?.trim() ?? '';
        if (!text) note.empty = true;
        return text;
      } catch (e) { note.error = (e as Error).message; return ''; }
    },
  };
}

/** Why a page that needs OCR was not read, as warnings. */
function ocrWarnings(note: HookNote, extra: string | undefined): string[] {
  if (note.error) return [`OCR failed: ${note.error}`];
  if (note.empty) return ['OCR returned no text'];
  if (note.limit !== undefined) return [`not read by AI: the limit of ${note.limit} AI-read pages per file is reached (Settings -> AI)`];
  return extra ? [extra] : [];
}

async function readPdf(input: ParseDocumentInput, signal: AbortSignal): Promise<Done> {
  const lite = await loadLiteparse();
  const [pdfjs, rasterLoaded, local] = await Promise.all([loadPdfjs(), loadRaster(), loadLocalOcr()]);
  const root = pdfjsRoot();
  let doc: PdfDocProxy;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(input.bytes), standardFontDataUrl: `${join(root, 'standard_fonts')}/`, cMapUrl: `${join(root, 'cmaps')}/`, cMapPacked: true,
      isEvalSupported: false, verbosity: 0,
    }).promise;
  } catch (e) {
    throw mapError('pdf', e, signal);
  }
  const warnings: string[] = [];
  const total = doc.numPages;
  const count = Math.min(total, maxPages());
  if (count < total) warnings.push(`only the first ${count} of ${total} pages were read (PARSER_MAX_PAGES)`);
  const budget: Budget = { used: 0, limit: input.ocrMaxPages ?? Number.POSITIVE_INFINITY };
  // The packaged recognition model reads English only: it is used when the caller says the source is English.
  const localOcr = input.language === 'en' ? local.engine : undefined;
  const rt: Runtime = { lite, raster: rasterLoaded.raster, localOcr };
  const pages: ParsedDocumentPage[] = [];
  try {
    for (let n = 1; n <= count; n++) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      pages.push(await readPdfPage(rt, pdfjs, doc, n, input, budget, signal, rasterLoaded.note));
    }
  } finally {
    await doc.destroy?.().catch(() => undefined);
  }
  if (local.note) warnings.push(local.note);
  return { pages, warnings, parser: parserInfo(lite, !!localOcr) };
}

/** One liteparse call on one page. `blank` hides the page's text layer, so it is read as a scan. */
async function liteparsePage(rt: Runtime, pdfjs: PdfJs, doc: PdfDocProxy, n: number, input: ParseDocumentInput, budget: Budget, signal: AbortSignal, blank: boolean) {
  const view = pageLibrary(pdfjs, doc, n, blank);
  const note: HookNote = {};
  const vlm = rt.raster ? hookGateway(input, n, budget, note, view.plainText) : undefined;
  const result = await rt.lite.parseDocument(PDF_STUB, {
    filename: 'page.pdf', mime: 'application/pdf', pdfjs: view.library, ...(rt.raster ? { raster: rt.raster } : {}),
    ...(vlm ? { vlm } : {}), ...(rt.localOcr ? { ocrEngine: rt.localOcr } : {}),
    maxBytes: Number.MAX_SAFE_INTEGER, maxChars: Number.MAX_SAFE_INTEGER, maxPages: 1, perPageTimeoutMs: pageTimeoutMs(), signal,
  });
  const page = result.pages[0];
  const text = page?.text.trim() ?? '';
  return { text: page && page.source === 'native' ? fromEol(text) : text, source: page && text ? page.source : 'none' as const, note, view };
}

/** One PDF page: native text when it has a usable layer, otherwise local OCR or the vision hook; always attributed. */
async function readPdfPage(rt: Runtime, pdfjs: PdfJs, doc: PdfDocProxy, n: number, input: ParseDocumentInput, budget: Budget, signal: AbortSignal, rasterNote: string | undefined): Promise<ParsedDocumentPage> {
  const warnings: string[] = [];
  const first = await liteparsePage(rt, pdfjs, doc, n, input, budget, signal, false);
  let { text, source, note } = first;
  // What the page's own text layer holds: kept when nothing better is read, and what makes a page "sparse".
  const layer = source === 'native' ? text : await first.view.plainText();
  const corrupt = textLayerLooksCorrupt(layer);
  const sparse = (source === 'native' || source === 'none') && nonSpace(layer) < MIN_PAGE_TEXT_CHARS;
  if (source === 'native' && (corrupt || sparse) && input.ocrPage && rt.raster) {
    // A corrupted layer is never trusted, and a page with almost no text is a picture: read it as a scan.
    const again = await liteparsePage(rt, pdfjs, doc, n, input, budget, signal, true);
    note = again.note;
    if (again.source === 'ocr' || again.source === 'vlm') {
      text = again.text; source = again.source;
      if (corrupt) warnings.push('the text layer looked corrupted; the page was read as a scan');
    } else if (corrupt) { text = ''; source = 'none'; }
  } else if (corrupt) { text = ''; source = 'none'; }
  if (source === 'none' && !corrupt) text = layer; // text under the OCR threshold is kept, flagged
  const needsOcr = source === 'none' || (source === 'native' && sparse);
  if (needsOcr) {
    warnings.push(`needs OCR: ${corrupt ? 'garbled' : text ? 'sparse-text' : 'no-text'}`);
    if (corrupt && source === 'none') warnings.push('the text layer looks corrupted');
    warnings.push(...ocrWarnings(note, input.ocrPage && !rt.raster ? rasterNote ?? 'the page cannot be rendered on this service' : undefined));
  }
  return { pageNo: n, text, method: source === 'ocr' || source === 'vlm' ? 'ocr' : 'pdf_text', needsOcr, warnings };
}

// ------------------------------------------------------------------------- DOCX, XLSX, CSV/TSV and images

async function readOther(format: DocumentFormat, kind: Kind, input: ParseDocumentInput, signal: AbortSignal): Promise<Done> {
  const lite = await loadLiteparse();
  let bytes = input.bytes;
  let filename = `file.${format === 'tsv' ? 'csv' : format}`;
  if (kind === 'csv') bytes = csvBytes(bytes); // liteparse finds the delimiter itself; a TSV is shown to it as a .csv
  const run = (extra: Record<string, unknown> = {}) => lite.parseDocument(new Uint8Array(bytes), {
    filename, maxBytes: Number.MAX_SAFE_INTEGER, maxChars: Number.MAX_SAFE_INTEGER, signal, perPageTimeoutMs: pageTimeoutMs(), ...extra,
  });

  if (kind !== 'image') {
    const info = parserInfo(lite, false);
    const r = await run();
    const failed = r.warnings.map((w) => /extractor failed: (.*)$/.exec(w)?.[1]).find(Boolean);
    if (failed) throw new DocumentReadError('corrupt', `the ${format.toUpperCase()} file could not be read (${failed})`);
    const text = (r.pages[0]?.text ?? '').trim();
    if (!text) return { pages: [], warnings: [`the ${format.toUpperCase()} file has no text`], parser: info };
    if (kind === 'sheet') {
      const sheets = splitSheets(text);
      return { pages: sheets.map((s, i) => ({ pageNo: i + 1, text: s, method: 'sheet', needsOcr: false, warnings: s.includes('\n') ? [] : ['the sheet has no cells'] })), warnings: [], parser: info };
    }
    const warnings = kind === 'docx' ? ['a Word document is read as one page: the parser does not report its page breaks or headings yet'] : [];
    return { pages: [{ pageNo: 1, text, method: kind === 'csv' ? 'table' : 'pdf_text', needsOcr: false, warnings: [] }], warnings, parser: info };
  }

  // An image is a one-page scan: local OCR (English sources, when switched on), then the vision hook.
  const converted = await toPng(format, bytes);
  if (converted) ({ bytes, filename } = converted); else filename = format === 'jpg' ? 'page.jpg' : 'page.png';
  const local = await loadLocalOcr();
  const localOcr = input.language === 'en' ? local.engine : undefined;
  const budget: Budget = { used: 0, limit: input.ocrMaxPages ?? Number.POSITIVE_INFINITY };
  const note: HookNote = {};
  const vlm = hookGateway(input, 1, budget, note, async () => '');
  const r = await run({ ...(vlm ? { vlm } : {}), ...(localOcr ? { ocrEngine: localOcr } : {}) });
  const text = r.pages[0]?.text.trim() ?? '';
  const parser = parserInfo(lite, !!localOcr);
  if (text) return { pages: [{ pageNo: 1, text, method: 'ocr', needsOcr: false, warnings: [] }], warnings: [], parser };
  return { pages: [{ pageNo: 1, text: '', method: 'pdf_text', needsOcr: true, warnings: ['needs OCR: no-text', ...ocrWarnings(note, undefined)] }], warnings: local.note ? [local.note] : [], parser };
}


/**
 * CSV text as UTF-8 with a byte-order mark, which is what liteparse (SheetJS) needs to read it as UTF-8: without the mark
 * it decodes UTF-8 as Windows-1252 (Arabic becomes mojibake), and a UTF-16 file (Excel's "Unicode text") is mistaken
 * for audio. A file that is not valid UTF-8 is read as Windows-1252, as Excel does.
 */
function csvBytes(b: Uint8Array): Uint8Array {
  let text: string;
  if (b[0] === 0xff && b[1] === 0xfe) text = new TextDecoder('utf-16le').decode(b.subarray(2));
  else if (b[0] === 0xfe && b[1] === 0xff) text = new TextDecoder('utf-16be').decode(b.subarray(2));
  else {
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b); } catch { text = new TextDecoder('windows-1252').decode(b); }
  }
  return new TextEncoder().encode(`\ufeff${text.replace(/^\ufeff/, '')}`);
}

/** The image formats a vision model may not accept (TIFF, BMP, GIF, WebP) become PNG, the first frame only. */
async function toPng(format: DocumentFormat, bytes: Uint8Array): Promise<{ bytes: Uint8Array; filename: string } | null> {
  if (format === 'png' || format === 'jpg') return null;
  try {
    const { default: sharp } = await import('sharp');
    return { bytes: new Uint8Array(await sharp(bytes).png().toBuffer()), filename: 'page.png' };
  } catch (e) {
    throw new DocumentReadError('corrupt', `the ${format.toUpperCase()} image could not be read (${(e as Error).message})`);
  }
}

/**
 * liteparse writes a workbook with several sheets as "# Sheet name" followed by that sheet's rows as CSV, and a workbook
 * with one sheet without any header. So the sheets are split back at the "# name" lines. A first-column cell that is
 * itself "# something" with no comma on its row would be taken for a sheet header (a limit of the format; the page text
 * keeps everything either way). A single sheet's name is not available.
 */
function splitSheets(text: string): string[] {
  if (!text.startsWith('# ')) return [text];
  const sheets: string[][] = [];
  for (const line of text.split('\n')) {
    if (/^# [^,]*$/.test(line)) sheets.push([line]);
    else sheets.at(-1)!.push(line);
  }
  return sheets.map((s) => s.join('\n').trim());
}
