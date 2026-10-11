# @drmoyassine/liteparse 0.5.0 against PRD Appendix D

Status of the owned parser (`@drmoyassine/liteparse` 0.5.0, https://github.com/drmoyassine/liteparse) against the requirements LP1–LP10 and the D.3 test corpus, as found on 2026-10-11 while switching the AMS to it (TASK-053, DEC-011). It is written for the liteparse repository: each gap ends in a proposed change with a title, a short description and a test to add, ordered by importance.

How this was checked: the library's source and its published package were read, then run through `parseDocument()` and through the AMS wrapper (`packages/core/src/framework/parse-document.ts`) on generated files (tiny PDFs, DOCX, XLSX, CSV, PNG; an Arabic DOCX converted to PDF with LibreOffice; a 140-page PDF). The accreditor documents of D.3 were **not** available here, so the corpus rows are judged on look-alike files and on the source; they need a real run in the AMS private fixtures. Nothing was run against a real vision model, and local OCR (RapidOCR) could not be evaluated (see "Local OCR").

Legend: **met**, **partly**, **not met** describe what the library does today by itself. "Wrapper" is what the AMS does to compensate (all in `parse-document.ts`; liteparse is imported nowhere else except the temporary fallback, below).

## How the AMS uses it

| Format | Reader | Pages the AMS stores |
|---|---|---|
| PDF | liteparse, **one page per call**: the AMS opens the file with pdfjs once and injects a pdfjs that shows liteparse a one-page document, so it classifies, extracts, renders (sharp + @napi-rs/canvas) and escalates (injected vision hook) that page alone | one per PDF page; method `pdf_text` (native) or `ocr` (local OCR or vision hook) |
| DOCX | liteparse (mammoth) | **one page** for the whole file |
| XLSX | liteparse (SheetJS) | one page per sheet, split by the wrapper at liteparse's `# Sheet name` lines (multi-sheet files only) |
| CSV, TSV | liteparse (SheetJS), after the wrapper re-encodes the bytes (below) | one page, method `table`; delimiter detected by SheetJS (`;` and tab are returned as commas) |
| PNG, JPEG | liteparse image path: no text layer, straight to the vision hook | one page |
| TIFF, BMP, GIF, WebP | converted to PNG by the wrapper (sharp, first frame only), then as above | one page |
| PPTX, PPT, ODT, ODS, ODP, RTF, legacy DOC, XLS | **not read by liteparse**; temporary fallback `parse-document-fallback.ts` (upstream `@llamaindex/liteparse` + LibreOffice) | a page per slide / per printed page / per sheet; no OCR |
| anything else | typed `unsupported` error | none |

Why not hand the format straight to liteparse: it reports legacy OLE files as unsupported but, for anything it cannot type (RTF, TSV, an ODT), it falls to a plain-text decode of the raw bytes (RTF comes back as `{\rtf1\ansi ...}`, an OLE file as binary noise), and, **if a vision gateway is configured, sends the bytes of an unknown kind to the vision model**. The wrapper therefore never passes it a format it does not read.

## Settings and limits (parser service environment)

`PARSER_TIMEOUT_SECONDS` (300, whole file), `PARSER_MAX_PAGES` (1000), `PARSER_PAGE_TIMEOUT_SECONDS` (120, one render + recognise), `PARSER_RASTER_MAX_EDGE` (2000 px, the image sent to the vision model; liteparse's own default is 1600), `PARSER_LOCAL_OCR=rapidocr` + `RAPIDOCR_MODEL_PATH` (off by default). The job result of `extract_text` now carries `parser: { name, version, configHash, fallback }`; `source_page` has no column for it and none was added (no migration).

## Requirement status

### LP1 — no hard output caps, results per page — **partly**

Evidence (source and experiment): `maxBytes` 20 MB, `maxChars` 50 000, `maxPages` 20 (OCR/VLM pages) are options, but the defaults truncate: a 30 000-row CSV came back cut to 50 000 characters with only a `truncated_chars:120003_to_50000` warning, and a 25-page scanned PDF returned **20 pages** (`page_budget: capped OCR/VLM at 20 of 25 pages`): pages 21–25 are absent from `pages`, not present-and-flagged. There is no async iterator and no page range; the whole document is held in memory and returned at once.
Wrapper: raises every cap to the maximum, calls the library one page at a time (its own streaming, bounded memory: 140 pages in about 0.35 s and 234 MB RSS), applies `PARSER_MAX_PAGES` itself and says how many pages were read.

### LP2 — stable per-page output — **not met** for most inputs

`Page` is `{ index (0-based), text, source }`. No label, confidence, language, quality or per-page warnings. For a **digital PDF the result is one page** holding every page's text (3 digital pages came back as `pages.length === 1`, `meta.totalPages: 1`), and the same for every Office file. Only the scanned-PDF path (rasterise + OCR/VLM) returns one entry per page. Per-page `source` is therefore informative only for scans.
Wrapper: the one-page-per-call plumbing above gives true page numbers and a method per page; labels, confidence and language are not available and not stored.

### LP3 — text-layer quality check and escalation — **not met**

`classifyDocument` decides scanned vs digital from the first three pages' non-space character counts (≥ 100 on page 1 means digital for the whole file, < 10 means scanned for the whole file). Consequences, both observed: a PDF whose first page is a scan and whose next two pages are digital had **all three pages sent to the vision model**; and nothing looks at the quality of an existing text layer, so the NBAQ-style corrupted layer is trusted. There is no `forceMethod`.
Wrapper: judges each page on its own (page 1 being a scan no longer affects page 2), treats a page with fewer than 20 non-space characters as a picture, and runs `textLayerLooksCorrupt()`: replacement/private-use/control characters in bulk, or at least a tenth of the words holding a symbol where a letter should be (`Asflranc€`, `Acc{ed|tation`). A corrupt page is re-read as a scan (the same one-page call with its text layer hidden, which routes it to rasterise + hook) or, with no hook or budget, left empty and flagged `needsOcr` with a warning. Cannot be detected without a dictionary: a letter swapped for another letter (`Accrtditation`). The AMS "quote must be verified" rule is the backstop.

### LP4 — Arabic — **partly** (diacritics met; order, OCR and routing not met)

- Diacritics (tashkeel) are **kept** for documents. The README line "Arabic diacritics are stripped by default (`keepDiacritics: true` to keep)" is about speech-to-text only (`src/engines/moonshine/shared/tokens.ts`); there is no `keepDiacritics` option on `parseDocument()` and nothing strips text from PDFs, DOCX or the vision gateway. Verified: an Arabic DOCX with full vocalisation, and text returned by the injected vision hook, both reach the AMS with every mark. Nothing in the library tests this for documents.
- NFC: the library never normalises (no `.normalize()` in `src`). Wrapper normalises to NFC.
- Logical (reading) order: **not met for native PDF text**. An Arabic DOCX converted to PDF with LibreOffice came back with chunks in visual (left-to-right) order and with unmapped glyphs as control characters (`U+0010` inside `المؤسسة`), e.g. `سسة هي التمزي في التعليم \u0010 ؤرسالة الم`. pdfjs itself returns the items in that order with `dir: "rtl"` and the x position; liteparse concatenates them in stream order. DOCX text is in logical order (read from the XML).
- Arabic OCR: **not met**. The only OCR engine is RapidOCR PP-OCRv4 with the **English** recognition model and the 94-character English dictionary; there is no Arabic model. The router has script-based placement but `classify` takes the script from native text, so a scanned page is `unknown`, treated as Latin; if a local engine is configured, its (Latin) output for an Arabic page is accepted as soon as it has 3 characters and the vision model is never asked.
- Routing Arabic pages to the VLM automatically: **not met** (no language option on `parseDocument()`).
Wrapper: scanned pages go to the vision hook with the source's language hint; local OCR is used only when the caller says the source is English; NFC; no reordering of native Arabic text (a visual-to-logical reorder of RTL items in the injected pdfjs is possible but was judged too risky without real Arabic PDFs to test; it belongs in the library).

### LP5 — injectable VLM — **met**

`vlm.readImage(png, { pageIndex, totalPages, hint, signal, mime })`; no network call of its own. The AMS passes its `ocrPage` hook (aiOcr: budget, logging, language hint) through it and counts pages against `ocrMaxPages`. Small gaps: no language in the options (the AMS uses its own hint), the MIME is sniffed only for JPEG/PNG/WebP (GIF, BMP, TIFF are labelled `image/png`, hence the wrapper's conversion), and a gateway that throws turns into a warning string rather than an error (the AMS gateway catches its own errors).

### LP6 — Office pseudo-pages — **not met**

DOCX: mammoth `extractRawText`: one page; no headings, no page breaks, tables flattened to one paragraph per cell separated by blank lines (`Code\n\nTitle\n\n1.1\n\nMission`). XLSX: one page; sheets joined as `# Sheet name\n<csv rows>` only when there is more than one sheet; a one-sheet workbook has no name at all; an empty sheet leaves a bare `# name` line. CSV: one page.
Wrapper: splits XLSX at lines matching `# <name>` with no comma (a first-column cell that itself reads `# something` on a one-column row would be mistaken for a sheet; documented in the code) and gives each sheet a page whose text starts with its `# name` line (that line is the only label we can store; there is no label column). DOCX stays one page with a document warning.

### LP7 — table-aware PDF text — **partly**

Raw library output joins every text item with no separator, so line ends vanish and words fuse across lines (`...every year.The institution publishes...`). Rows of a table stay together only because everything is on one line.
Wrapper: marks pdfjs `hasEOL` items so each line survives as a newline (verified: a three-column table row is `Code Title Rating\n1.1 Mission statement Met`). Cell boundaries are a single space (no tab or pipe), so columns are not recoverable; multi-column page layouts were not tested.

### LP8 — reproducibility — **not met**

Results have no `parserVersion` or `configHash`; the package exports `VERSION` only. Wrapper: `parser.version` from `VERSION` plus its own `configHash` (parser version, text threshold, raster size, local OCR on/off) in the `extract_text` job result. No page-level record.

### LP9 — server performance — **partly**

Pure JS on Node; per-page timeout (`perPageTimeoutMs`, default 30 s) and `AbortSignal` work; 140 digital pages took ≈ 0.35 s. Gaps found:
- no process isolation: pdfjs runs on the caller's thread, so a pathological page blocks the event loop and timeouts only act between awaits (the previous upstream package ran in a killable worker process);
- every internal `loadPdf` copies the whole file (`bytes.slice()`) and a page is text-extracted twice (classify, then extract), so per-call overhead grows with file size (the wrapper keeps the file in the injected pdfjs and passes an 8-byte stub, so the copies are of the stub);
- `import "@drmoyassine/liteparse"` prints `[ocr-worker] NOT a worker scope ...` with `console.log` (the wrapper filters it);
- pdfjs is given no `standardFontDataUrl` / `cMapUrl`, so non-embedded standard fonts fail to load (warnings, dropped glyph paths) and rendering text pages fails (wrapper opens the file itself with both set);
- `@napi-rs/canvas` 1.x breaks pdfjs 4.10 page rendering (`Value is none of these types String, Path`); 0.1.100 works and is pinned;
- text that runs past the right page edge was not returned by pdfjs (observed: a 232-character test line was cut at 106 characters, the same text wrapped into lines was complete); this matters only for badly generated PDFs.

### LP10 — licence and packaging — **partly**

MIT; `pdfjs-dist`, `onnxruntime-node`, `onnxruntime-web` are optional peers. Gaps: `sharp` and `@napi-rs/canvas`, required by `raster/sharp`, are only devDependencies (they resolve today only because pnpm hoists everything into its virtual store; declare them as optional peers); `xlsx` is a dependency on `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, which an install behind an egress proxy or an offline mirror cannot fetch (the AMS overrides it to the same release published on npm as `@e965/xlsx@0.20.3`, in `pnpm-workspace.yaml`); the `postinstall` scripts (`copy-ort-wasm`, `copy-pdfjs-worker`) are not run by pnpm 10 and nothing needed them on Node; the RapidOCR model files are not packaged anywhere on npm (they are fetched from Hugging Face by the runner's Dockerfile).

## D.3 corpus

| Case | Library alone | With the AMS wrapper | Needs |
|---|---|---|---|
| WSCUC 2023 Handbook, text-layer PDF, 26 pp | **not met**: all pages come back as one page; words fuse at line ends | **met** on look-alike files: 26 native pages, lines kept, verbatim sentences found per page | real file |
| ABET APPM, 69 pp, ≈ 130k characters | **not met**: output cut at 50 000 characters by default; no streaming | **met**: no truncation, page by page (140-page look-alike in 0.35 s) | real file |
| NBAQ Handbook 2017, corrupted layer | **not met**: layer trusted | **partly**: symbol-substitution corruption detected and the page re-read by the vision hook; letter-swap corruption (`Accrtditation`) is not detected | real file, dictionary check |
| Scanned Arabic (PUC guide 2019, letter 2022) | **partly**: the VLM path works per scanned page, but only when no local OCR engine is configured, and only the first 20 pages | **partly**: every scanned page goes to the vision hook with the language hint, no page cap beyond `ocrMaxPages`; `1-1-1` codes and Arabic order depend on the model | real file, real model |
| ABET E002 Self-Study Questionnaire, DOCX | **not met**: one page, no headings | **not met**: the same | LP6 in the library |
| ABET Supplement Tables 5-1, 6-1, 6-2, XLSX | **partly**: one blob, `# Sheet` headers for 2+ sheets, headers intact as CSV | **met** for 2+ sheets (a page per sheet, headers intact); a one-sheet workbook has no sheet name | real file |

## What is worse and better than the upstream package (`@llamaindex/liteparse`, PDFium + LibreOffice)

Better: no LibreOffice, ImageMagick or child processes for PDF, Word, Excel, CSV and images; DOCX text and Arabic DOCX in **logical** order (upstream returned visual order with swapped lam-alef pairs); spreadsheets as CSV rows with sheet names instead of space-aligned print layout and spill-over pages; CSV delimiters, quotes, BOM and encodings handled; no process start per file (a 140-page text PDF takes about 0.35 s here; the upstream package was not timed); an injectable vision gateway; honest per-page attribution once called a page at a time.
Worse: DOCX has no page structure (upstream: printed pages), no tables, no headings; single-sheet names are lost; no PowerPoint, OpenDocument, RTF, legacy Word/Excel (still read by the upstream fallback); no per-page result for digital PDFs and a document-level scan decision (compensated); no text-quality check (compensated for symbol corruption); native Arabic PDF text is in visual order; scanned pages need native `sharp` + `@napi-rs/canvas`; no killable worker process, so a runaway page is not interrupted.

## Local OCR (RapidOCR) — not enabled

Evaluated: **no**, because it could not be run offline here. `onnxruntime-node`'s install step fetches binaries from `api.nuget.org` and the model files come from `huggingface.co`; both are blocked in this environment, so `npm i onnxruntime-node` failed and no model could be loaded. What it would take, and what the code already supports behind `PARSER_LOCAL_OCR=rapidocr`:
1. add `onnxruntime-node` to the parser image (the install script needs egress to nuget at build time, or an image build that has it);
2. bake `ch_PP-OCRv4_det_infer.onnx`, `en_PP-OCRv4_rec_infer.onnx` and `ppocr-en-dict.txt` into the image (the liteparse runner's Dockerfile fetches and checksums them from Hugging Face at build time; the dictionary is in `apps/runner/models/` of the liteparse repository) and set `RAPIDOCR_MODEL_PATH`;
3. accept that the recognition model is **English only**: the AMS uses it only for sources whose language is English; Arabic scans stay on the vision model.
If the package or models are missing the switch logs a document warning ("local OCR ... is not available, scanned pages go to the vision model") and nothing else changes. Quality gate to add upstream: an engine confidence floor, because any 3 characters of output end the cascade.

## Proposed changes for the liteparse repository, by importance

1. **Per-page results for every PDF, with page-wise escalation** (LP1, LP2, LP3). `parseDocument` returns one `Page` per PDF page also when the text layer is digital, and decides native / OCR / VLM **per page**, not from pages 1–3. Add `parsePages(input, opts): AsyncIterable<ParsedPage>` and `pages: [from, to]`. A page beyond a budget is returned flagged (`warnings: ["not read: page budget"]`), never dropped. Test: a 4-page PDF (scan, digital, digital, blank) yields four pages with sources `vlm, native, native, none` and exactly two gateway calls; a 30-page digital PDF yields 30 pages with default options.
2. **Keep line breaks and spacing in native PDF text** (LP7). Use pdfjs `hasEOL` and item y/x positions: newline between lines, a tab (or two spaces) between cells whose x gap exceeds a threshold, never fuse the last word of a line with the first of the next. Test: a PDF with two lines (`...every year.` / `The institution...`) returns them on separate lines; a three-column row returns `Code\tTitle\tRating`.
3. **Text-layer quality score and `forceMethod`** (LP3). Score each native page (share of dictionary words for the detected script, symbol-inside-word rate, replacement and private-use characters, control characters) and escalate low scores; expose `quality: { textLayerScore, escalated, reason }` and `forceMethod: 'native' | 'ocr' | 'vlm'` per call. Test: a PDF whose text layer is `Asflranc€ of Inst|tut|on` is escalated and the gateway text is returned; a clean page is not escalated; `forceMethod: 'vlm'` reads a digital page with the gateway.
4. **Read PPTX, ODT/ODS/ODP, RTF, legacy DOC/XLS/PPT** (formats gap). PPTX: a page per slide in presentation order with title as label and notes included; ODT/ODS/ODP: the same structure from `content.xml` (pure JS, a zip reader and XML); XLS and ODS: SheetJS already reads them (the sniffer rejects OLE before it gets there); RTF: a small RTF-to-text reader; DOC: a word-extractor, or report unsupported. Meanwhile **never decode an unknown kind as text and never send it to the VLM**: return `{ text: "", warnings: ["unsupported_kind:<mime>"] }`. Test: one fixture per format with expected pages; an RTF input returns `unsupported_kind` (today its markup is returned as text); an unknown binary with a gateway configured makes no gateway call.
5. **DOCX and XLSX pseudo-pages with labels** (LP6). DOCX: one page per page break (`w:br type=page`, `w:lastRenderedPageBreak`, section breaks) or top-level heading, `label` = the heading text, tables rendered as pipe or TSV rows (use mammoth's HTML conversion, not raw text). XLSX: one page per sheet always, `label` = sheet name (also for one-sheet workbooks), rows as TSV, empty sheets still listed. CSV: one page. Test: a DOCX with Heading 1 `Criterion 1`, a page break, Heading 1 `Criterion 2` yields two pages labelled by those headings; a two-column table keeps its cells on one line; a one-sheet XLSX returns its sheet name; an XLSX cell `# of seats` is not read as a sheet header.
6. **Arabic reading order and cleanliness** (LP4). Order RTL runs of native PDF text logically using each item's `dir` and x position (verified case: LibreOffice-made Arabic PDF, items arrive left-to-right); drop glyphs without a Unicode mapping (`U+0010`) or return them as `U+FFFD` and lower the page quality score; normalise output to NFC; document that `keepDiacritics` concerns speech only and add a document test that tashkeel survives. Add a `languages` option so an Arabic page skips a Latin OCR engine and goes to the gateway (script from the option, not from absent native text), and an Arabic recognition model for the local engine. Test: an Arabic DOCX converted to PDF returns `رسالة المؤسسة` in logical order with no control characters; a vocalised DOCX and a vocalised gateway answer both keep U+064B–U+0652; `languages: ['ar']` with a Latin engine configured calls the gateway.
7. **Caps become warnings, defaults generous** (LP1). `maxBytes`, `maxChars`, `maxPages` default to unlimited or very large; when a cap applies, return what was read plus a flag, never a silently shorter result. Test: a 120 000-character CSV returns all characters by default and, with `maxChars: 50000`, returns the first 50 000 with `truncated: true`.
8. **Reproducibility fields** (LP8). Return `parser: { version, configHash, engines: { native: 'pdfjs-dist@x', ocr: 'rapidocr@y', vlm: 'gateway' } }` per result and the same `configHash` for the same options; per page, the engine that produced it. Test: two runs of the same file and options give equal `configHash` and text; changing `ocrFloor` changes the hash.
9. **Packaging for a strict installer** (LP9, LP10). Declare `sharp` and `@napi-rs/canvas` as optional peers; pin the supported `@napi-rs/canvas` range (0.1.x works with pdfjs 4.10, 1.x does not); pass `standardFontDataUrl` and `cMapUrl` to pdfjs on Node; depend on `xlsx` from the npm registry (`@e965/xlsx`) instead of the cdn.sheetjs.com tarball; do not `console.log` at import; ship or document a model package for RapidOCR. Test: `pnpm install` with `hoist=false` and no network except the registry succeeds and a scanned PDF page rasterises; the first import writes nothing to stdout.
10. **Process-level isolation option** (LP9). An option to run extraction in a `worker_threads` worker that can be terminated on timeout, or at least yield to the event loop between pages and honour `signal` inside pdfjs calls. Test: a PDF with a page that takes seconds to parse is stopped within the configured timeout while other timers keep firing.
11. **Local OCR confidence floor** (LP3/LP4). Take the engine's confidence into account: below a configurable floor the cascade continues to the gateway instead of accepting 3 characters. Test: an engine returning `{ text: 'x1~', confidence: 0.2 }` escalates to the gateway.

## Unfinished here

Real D.3 documents and a real vision model were not run; Arabic native-PDF reordering is not implemented in the AMS; RapidOCR was not run; the Docker build was not run (see the parser image notes in `Dockerfile`: after the first deploy check `docker compose logs parser` for "libreoffice found", then read a text PDF, a scanned PDF, an Arabic DOCX, an XLSX with two sheets and a PPTX from the Sources screen, and confirm the job result carries `parser.version`).
