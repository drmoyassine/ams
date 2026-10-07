---
id: TASK-041
title: Evidence requests with one-time links
description: >-
  Ask a person by email for evidence on an internal standard; AMS users answer from Requests, others through a one-time
  link; the answer becomes proposed evidence
status: completed
priority: P0
last_updated: '2026-10-07'
generated:
  by: agent/claude-code
  at: '2026-10-07T09:55:21.170Z'
roadmap_item:
  id: ROADMAP-004
  name: M3 — Evidence and datasets
  url: /ROADMAP.md#ROADMAP-004
depends_on:
  - id: TASK-039
    name: Evidence repository, versions and reasoned links
    url: /TASKS.md#TASK-039
related_decisions:
  - id: DEC-018
    name: Evidence requests can be answered through a one-time link by people without an AMS account
    url: /DECISIONS.md#DEC-018
  - id: DEC-019
    name: Evidence may be shared with a connected BI product whose AI may process it
    url: /DECISIONS.md#DEC-019
modified:
  by: agent/claude-code
  at: '2026-10-07T09:55:21.170Z'
---
# TASK-041 — Evidence requests with one-time links

Built: evidence_request (migrations 0024-0025) with tenant RLS, audit, a trigger that keeps the target fixed and closed requests closed, and `app_resolve_request_link`, the only lookup made before an institution is known. The one-time link's secret is random (32 bytes), stored only as its SHA-256, expires after 30 days, and stops working once used, cancelled or replaced. The API's third access kind, `responseLink()`, authenticates and scopes by the link and still runs the transaction step; the route coverage test allows it only on `/api/response-links/{token}`. The answer becomes a document with a proposed link to the internal item, which a reviewer approves. UI: "Request evidence" in a standard's ⋯ menu, Requests on the expanded card, a Requests page (Asked of me / All requests), and `/respond/{token}` outside the signed-in app. No email is sent yet: the requester copies the link (SMTP later).
