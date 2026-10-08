---
id: TASK-043
title: Read source files into page text (parseDocument and the extract_text job)
description: >-
  Step A of the framework analysis pipeline: a source's stored file becomes per-page text through the single
  parseDocument() entry point, queued from the Sources screen and run by the worker; no AI
status: completed
priority: P0
last_updated: '2026-10-08'
generated:
  by: agent/claude-code
  at: '2026-10-08T12:30:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-042
    name: Form builder for data items, with form and sheet views
    url: /TASKS.md#TASK-042
related_decisions:
  - id: DEC-011
    name: liteparse for document parsing, co-developed to AMS requirements
    url: /DECISIONS.md#DEC-011
modified:
  by: agent/claude-code
  at: '2026-10-08T12:30:00.000Z'
---
# TASK-043 — Read source files into page text (parseDocument and the extract_text job)

Built: `parseDocument()` in `packages/core/src/framework/parse-document.ts`, the only import of liteparse (`@llamaindex/liteparse`, native PDFium binding, works offline; its own OCR is off). PDF pages come from liteparse; a page with under 20 non-space characters, or a visibly corrupted text layer, is `needsOcr`. DOCX (a page per top-level heading, or per ~4000 characters), XLSX (a page per sheet, `a | b` rows), PPTX (a page per slide, with notes) and CSV (chunks of up to 100 rows with the header repeated) are read straight from their zip/XML with `fflate`, so LibreOffice is not needed. Output is `{pageNo, text, method: pdf_text|ocr|table|slide|sheet, needsOcr, warnings}`, NFC. OCR is not done here: an injected `ocrPage({pageNo, image (PNG), language, text})` hook is called for flagged pages; Step B's `aiOcr` fills it.

Job: `extract_text` (handler `extractText` in `framework/reading.ts`, registered in `jobs/handlers.ts`) loads the stored file (`loadSourceFile`, the permission-free half of `readSourceFile`: the worker cannot read role assignments, and the person's permission was checked when it was queued), upserts `source_page` rows and sets `text_status` (`extracted` or `ocr_needed`) and `page_count`. A page is replaced only while `from_file` is true and `reviewed` is false, so pages a person typed, corrected, imported or reviewed are never overwritten (`setSourcePage` clears `from_file`). An unreadable file gives `text_status = failed` and a job result `{ok: false, error}` rather than a retry. The job result records `pages`, `written`, `keptPages`, `needsOcr` and warnings. `runJob` now takes an optional object store, and the worker passes `s3Store(env)` (moved from apps/api to packages/core).

API/UI: `POST /api/source-documents/{id}/read` (`framework:write`, draft versions only) sets `text_status = queued` and enqueues; the Sources screen has "Read this file" with a status line (not read, reading, read N pages, N need OCR, could not be read), polling while queued. Pages that need OCR are marked in their tab. Uploads accept PDF, DOCX, XLSX, PPTX and CSV.

Migration 0035: `source_page.needs_ocr`, `source_page.from_file`, page methods `table`/`slide`/`sheet`, text status `queued`, worker UPDATE on the two new columns. Exchange files accept the new methods; export skips pages with no text.

Not done: deleting stale pages when a re-read file has fewer pages (the worker has no DELETE on `source_page`); legacy `.doc`, `.xls`, `.ppt` are stored but not read.
