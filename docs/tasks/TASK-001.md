---
id: TASK-001
title: Scaffold pnpm workspace
description: apps/web, apps/api, apps/worker, packages/core, packages/db, packages/shared; TypeScript, lint, Vitest
status: completed
priority: P0
assignee: ''
tags:
  - ams
last_updated: '2026-10-05'
generated:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:45.685Z'
roadmap_item:
  id: ROADMAP-001
  name: M0 — Scaffold and integrity foundation
  url: /ROADMAP.md#ROADMAP-001
depends_on: []
related_bugs: []
related_decisions:
  - id: DEC-009
    name: React SPA (Vite) + Hono API on Node; not Next.js; Frontbase not used for the core
    url: /DECISIONS.md#DEC-009
modified:
  by: agent/claude-code
  at: '2026-10-05T08:17:08.149Z'
---
# TASK-001 — Scaffold pnpm workspace

Create the layout in PRD §18.3. Strict TypeScript, ESLint + Prettier, Vitest at the root, path aliases. No business logic outside packages/core.
