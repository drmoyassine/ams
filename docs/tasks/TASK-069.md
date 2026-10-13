---
id: TASK-069
title: Organization screen: Institution and Programs tabs, institution logo, read-only Settings
description: >-
  Organization becomes one screen with two tabs, Institution (details, logo, Languages, Org chart) and Programs; the
  institution logo is uploaded and shown in the app; Settings are readable by every role
status: completed
priority: P2
last_updated: '2026-10-13'
generated:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
related_decisions:
  - id: DEC-028
    name: Organization has two tabs; one secondary language; translations of standards are unofficial; per-person UI language; org-chart images may go to the vision model; every AI-import place gets a Docs tab
    url: /DECISIONS.md#DEC-028
modified:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
---
# TASK-069 — Organization screen: Institution and Programs tabs, institution logo, read-only Settings

Step 1 of docs/organization-plan.md. Two tabs only: Institution (details and logo, then the Languages and Org chart sections as they arrive) and Programs. Programs leaves the Settings sidebar (old address redirects). Institution logo reusing the accreditor-logo upload rules and shown in the header and sign-in page. Settings visible read-only to all roles, editing unchanged.

Done 2026-10-13. Settings -> Organization is one screen with two deep-linkable tabs (`/settings/organization?tab=institution|programs`): Institution (Details, Logo, Org chart) and Programs; `/settings/programs` redirects and the sidebar entry is gone. Institution logo: PNG/JPEG/WebP by magic bytes, 512 KB, no SVG, one shared helper with the accreditor logo (`framework/logo-image.ts`), migration 0052, `PUT/GET/DELETE /api/institution/logo`, shown in the app header and on the sign-in page; the sign-in page reads the one public route `GET /api/public/branding` (display name, accent colour, logo URL only; `GET /api/public/branding/logo` serves the bytes). Settings is visible to everyone who holds `org:read` and every page is read-only (with a one-line note) for people who cannot edit; Trash (editors) and AI (administrators) stay hidden.
