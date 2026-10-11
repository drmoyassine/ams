---
id: TASK-053
title: The owned @drmoyassine/liteparse is the parser; a temporary fallback reads the formats it lacks
description: >-
  parseDocument() uses @drmoyassine/liteparse 0.5.0 (one page per call, injected vision hook) for PDF, DOCX, XLSX, CSV
  and images; PowerPoint, OpenDocument, RTF and legacy DOC/XLS go through a temporary upstream fallback; Appendix D
  status and proposed liteparse changes are written down
status: completed
priority: P1
last_updated: '2026-10-11'
generated:
  by: agent/claude-code
  at: '2026-10-11T15:00:00.000Z'
roadmap_item:
  id: ROADMAP-008
  name: L — liteparse readiness (parallel track)
  url: /ROADMAP.md#ROADMAP-008
depends_on:
  - id: TASK-052
    name: Every format is read by liteparse; the parser image includes LibreOffice and ImageMagick
    url: /TASKS.md#TASK-052
related_decisions:
  - id: DEC-011
    name: liteparse for document parsing, co-developed to AMS requirements
    url: /DECISIONS.md#DEC-011
modified:
  by: agent/claude-code
  at: '2026-10-11T15:00:00.000Z'
---
# TASK-053 — The owned @drmoyassine/liteparse is the parser; a temporary fallback reads the formats it lacks

Owner decision: switch from the unrelated upstream `@llamaindex/liteparse` (steps A–D, TASK-043/052) to the owned `@drmoyassine/liteparse` that DEC-011 and PRD Appendix D name. Supersedes the "LibreOffice for everything" part of TASK-052. Full findings: `docs/liteparse-appendix-d-status.md`.

Built:
- `parseDocument()` (`packages/core/src/framework/parse-document.ts`, the only import of the owned package) reads PDF, DOCX, XLSX, CSV/TSV and images with it. Public output unchanged (`{pageNo, text, method, needsOcr, warnings}`, NFC; no migration); `ParsedDocument` gains `parser: { name, version, configHash, fallback }`, copied into the `extract_text` job result (there is no `source_page` column for it).
- PDF: opened once with pdfjs-dist; liteparse is then called ONE PAGE AT A TIME through an injected pdfjs that shows it a one-page document. That gives real page numbers, a method per page, and per-page escalation (the library alone returns a digital PDF as one page and judges scanned-or-not once, from the first three pages). Scanned pages are rendered with sharp + @napi-rs/canvas (largest edge `PARSER_RASTER_MAX_EDGE`, 2000) and read by the injected `ocrPage` hook (aiOcr, with its budget, logging and language hint); `ocrMaxPages` is honoured and a page past it keeps `needsOcr` with the reason. `vlm`/`ocr` pages are method `ocr`. Line ends are kept (liteparse alone fuses the last word of a line with the next). A page with fewer than 20 non-space characters is treated as a picture; a corrupted layer (`textLayerLooksCorrupt`: replacement/private-use/control characters or symbols inside words) is re-read as a scan or left empty and flagged.
- DOCX is one page (the library reports no page breaks or headings; a document warning says so). XLSX: a page per sheet, split at the library's `# Sheet name` lines (multi-sheet only). CSV/TSV: one `table` page; the wrapper re-encodes the bytes as UTF-8 with a BOM (UTF-16 files were taken for audio, BOM-less UTF-8 was read as Windows-1252). TIFF/BMP/GIF/WebP become PNG (sharp) before reading. Formats it does not read are never passed to it (it would decode RTF as text and send unknown bytes to the vision model).
- `parse-document-fallback.ts` (temporary, marked as such; the only other parser import, `@llamaindex/liteparse`): PowerPoint, OpenDocument, RTF, legacy DOC/XLS via LibreOffice; `converter_missing` error kept; no OCR. The one-import-point test now allows exactly these two libraries, each in its own file, and pdfjs-dist only in `parse-document.ts`.
- Typed `DocumentReadError` codes, `PARSER_TIMEOUT_SECONDS` (abort signal; cooperative, there is no killable process any more), `PARSER_MAX_PAGES` (read first N pages, warning says how many), `PARSER_PAGE_TIMEOUT_SECONDS`, magic-number checks and `MAX_SOURCE_BYTES` kept.
- Local OCR (RapidOCR) behind `PARSER_LOCAL_OCR=rapidocr` + `RAPIDOCR_MODEL_PATH`, OFF and not installed: it could not be evaluated offline here (onnxruntime-node's install and the model files need nuget / Hugging Face), the packaged recognition model is English only (used only for English sources), and a missing package or model is a document warning. What it would take is in the status document.
- Dependencies: `@drmoyassine/liteparse` 0.5.0, `pdfjs-dist` 4.10.38, `sharp`, `@napi-rs/canvas` 0.1.100 (1.x breaks pdfjs 4.10 page rendering); `xlsx` overridden to `@e965/xlsx@0.20.3` in `pnpm-workspace.yaml` (the library's own dependency is a cdn.sheetjs.com tarball).
- Docker/CI: the parser image keeps LibreOffice (writer, calc, impress) and the Noto/Liberation fonts only for the fallback and drops ImageMagick; app, worker and agent images unchanged. CI installs the same reduced list. The worker's start-up log says which formats need LibreOffice.
- Tests (no network): rebuilt around the new package: text PDF with line breaks, mixed scan/digital pages, hook path (language, PNG, ocrMaxPages, failures), Arabic diacritics kept and NFC, corrupted layer, sparse page, DOCX (Arabic with tashkeel), XLSX (two sheets, empty sheet, one sheet), CSV (comma, semicolon, tab, BOM, no BOM, UTF-16, Arabic), images (PNG and converted formats), corrupt files, timeout, page cap, local-OCR switch, PPTX and RTF through the fallback, unsupported format, import points. `reading.test.ts` and the framework UI test follow the new CSV text.

Worse than before: DOCX has no page structure or table layout; single-sheet names are lost; native Arabic PDF text is in visual order (not reordered here); a hung page cannot be killed. Better: Arabic DOCX in logical order, spreadsheets as CSV rows with sheet names, no LibreOffice for Word/Excel/CSV/images.

Not done: the Docker build was not run (no registry); the D.3 corpus and a real vision model were not run; Appendix D remains open until the changes proposed in `docs/liteparse-appendix-d-status.md` land in a released liteparse.
