---
id: TASK-102
title: Sources by URL for every document import
description: >-
  Anywhere a document can be uploaded for AI import a URL can be added: the AMS fetches it, stores a snapshot with its
  address and time, and refresh keeps the old version.
status: pending
priority: P1
last_updated: '2026-10-21'
generated:
  by: agent/claude-code
  at: '2026-10-21T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
related_decisions:
  - id: DEC-033
    name: 'Every AI-powered document place also takes a URL; cycle templates take resources; programs and courses have schemas; every entity has a declared schema'
    url: /DECISIONS.md#DEC-033
modified:
  by: agent/claude-code
  at: '2026-10-21T12:00:00.000Z'
---
# TASK-102 — Sources by URL for every document import

Plan 2.1. One fetcher (one import point): HTTPS only, blocks private/loopback/link-local/metadata addresses (also after redirects and DNS), size/time/redirect limits, allowed content types incl. HTML (text extracted behind parseDocument()), no logins. `source_url`, `fetched_at`; Refresh. SSRF tests. Evidence is excluded (DEC-013).
