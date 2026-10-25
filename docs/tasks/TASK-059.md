---
id: TASK-059
title: Production check of the three background services and the parser image
description: >-
  After the redeploy: the parser image builds and logs LibreOffice, the worker, parser and agent start with the right
  queues, Garage is prepared by the app, and one file of each kind is read
status: pending
priority: P0
last_updated: '2026-10-12'
generated:
  by: agent/claude-code
  at: '2026-10-12T09:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-049
    name: Background work as three services (worker, parser, agent); app prepares Garage
    url: /TASKS.md#TASK-049
  - id: TASK-053
    name: The owned @drmoyassine/liteparse is the parser; a temporary fallback reads the formats it lacks
    url: /TASKS.md#TASK-053
related_decisions:
  - id: DEC-024
    name: 'Background work runs as three services from one codebase: worker, parser, agent'
    url: /DECISIONS.md#DEC-024
  - id: DEC-011
    name: liteparse for document parsing, co-developed to AMS requirements
    url: /DECISIONS.md#DEC-011
modified:
  by: agent/claude-code
  at: '2026-10-12T09:00:00.000Z'
---
# TASK-059 — Production check of the three background services and the parser image

Owner and build-sandbox check; nothing here has been run on a real build because the sandbox cannot build Docker images.
- `docker compose logs parser` shows "libreoffice found" (needed only for the temporary fallback formats). Run `soffice --version` as the node user in the parser container.
- worker, parser and agent each log `worker started` with their queues (worker: export, notify; parser: extract_text; agent: analyse, ai_extract, ocr). The domain maps to `app:3000` only.
- The app prepares Garage on first start (GARAGE_ADMIN_URL is in compose.yaml); `garage-init` is gone; the first start can take longer.
- APP_SECRET is set and never changes (it encrypts saved AI keys; a change makes them unreadable).
- iqf_item_proposal exists (migration 0044 was re-dated to run after 0043).
- Read a text PDF, a scanned PDF, an Arabic Word file, a two-sheet Excel file and a PowerPoint file from Sources; the job result's `parser` field records the library version. Check memory and time on the first conversion, and that no `soffice` process is left over.
- Turn on Easypanel log collection so the build sandbox can read logs when something fails.
