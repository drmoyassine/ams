---
id: TASK-052
title: Every format is read by liteparse; the parser image includes LibreOffice and ImageMagick
description: >-
  parseDocument() routes PDF, Word, Excel, PowerPoint, OpenDocument, RTF, CSV/TSV and images through liteparse; the
  home-made DOCX/XLSX/PPTX/CSV readers and fflate are removed; the parser Docker target installs LibreOffice and
  ImageMagick; CI installs them for the tests
status: completed
priority: P1
last_updated: '2026-10-11'
generated:
  by: agent/claude-code
  at: '2026-10-11T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-043
    name: Read source files into page text (parseDocument and the extract_text job)
    url: /TASKS.md#TASK-043
related_decisions:
  - id: DEC-011
    name: liteparse for document parsing, co-developed to AMS requirements
    url: /DECISIONS.md#DEC-011
modified:
  by: agent/claude-code
  at: '2026-10-11T12:00:00.000Z'
---
# TASK-052 — Every format is read by liteparse; the parser image includes LibreOffice and ImageMagick

Owner decision: all media are parsed with liteparse (DEC-011, one import point). TASK-043 had read DOCX/XLSX/PPTX/CSV with a small `fflate`/XML reader to avoid LibreOffice; that is reversed.

Built:
- `parseDocument()` (`packages/core/src/framework/parse-document.ts`) hands every supported file to liteparse: PDF, DOC/DOCX/ODT/RTF, XLS/XLSX/ODS, CSV/TSV, PPT/PPTX/ODP, PNG/JPEG/TIFF/WebP/BMP/GIF. The home-made readers, `parseCsvRecords` and the `fflate` dependency are gone. Public shape unchanged (`{pageNo, text, method, needsOcr, warnings}`, NFC); methods: `pdf_text` (PDF, documents, images), `slide`, `sheet` (spreadsheets), `table` (CSV/TSV), `ocr` (after the hook). No migration needed.
- Pages are what liteparse returns (see log.md 2026-10-11): printed pages for documents and sheets, a page per slide, one page per image. Sheet pages lose LibreOffice's "Page N" footer and the temp-file header.
- `needsOcr` from liteparse's per-page reasons (`complexity`): `scanned`/`garbled`, or fewer than 20 characters for PDFs and images; the reason is added as a warning ("needs OCR: scanned"). A corrupted PDF text layer is still blanked. liteparse's own OCR stays off; the injected `ocrPage` hook (aiOcr) still gets a PNG of the page (a second liteparse call with screenshots for just those pages).
- Safety: each file runs in a killable liteparse worker process with a time limit (`PARSER_TIMEOUT_SECONDS`, 300) and a page cap (`PARSER_MAX_PAGES`, 1000; the document warning says how many pages were read); `MAX_SOURCE_BYTES` is unchanged. Magic-number checks reject a file that is not what its name says before any converter runs. Failures are `DocumentReadError` (`unsupported`, `corrupt`, `converter_missing`, `timeout`); `extract_text` records `textStatus = failed` and the message ("LibreOffice is not installed on the parser service, so DOCX files cannot be read ...").
- `findLibreOffice()`; the worker entry point logs `libreoffice found` (or a warning that it is not) when it takes `extract_text`.
- Docker: the `parser` target alone installs `libreoffice-core`, `-writer`, `-calc`, `-impress`, `imagemagick`, `fonts-noto-core`, `fonts-liberation`, with `HOME=/home/node`. CI installs the same before the tests; the Office tests skip with a console message when `soffice` is absent.
- Upload picker and API description list the new types. Fixtures (`parse-fixtures.ts`) build PDF, DOCX, XLSX, PPTX and PNG in code with a stored-zip writer (no library).

Worse than the old readers: Arabic word order in converted Office files (liteparse returns visual order); spreadsheets are space-aligned text (no `a | b`), wide sheets spill onto extra pages, and sheet names appear only if the file prints them; speaker notes are not read; DOCX pages follow the printed layout instead of headings; page fonts matter (a missing font changes the text).

Not done: the Docker build was not run here (no registry); nothing in the OCR path was run against a real provider; an orphaned `soffice` after a timeout kill was not seen in tests but is not guarded against.
