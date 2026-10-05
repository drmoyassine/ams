---
id: integrity-by-construction
title: Integrity is enforced by the system, not by discipline
status: active
description: >-
  Permissions, row-level security, audit and immutability are enforced at one checkpoint and in the database; the system
  runs on any host using open standards.
tags:
  - ams
generated:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:10.038Z'
modified:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:30.131Z'
related_decisions:
  - id: DEC-007
    name: One PostgreSQL database; not a database per accreditation standard
    url: /DECISIONS.md#DEC-007
  - id: DEC-008
    name: Host-agnostic deployment on open standards
    url: /DECISIONS.md#DEC-008
  - id: DEC-009
    name: React SPA (Vite) + Hono API on Node; not Next.js; Frontbase not used for the core
    url: /DECISIONS.md#DEC-009
  - id: DEC-010
    name: One middleware chain for every request and background job
    url: /DECISIONS.md#DEC-010
  - id: DEC-015
    name: Better Auth for authentication (OIDC/SAML + password)
    url: /DECISIONS.md#DEC-015
related_roadmap_items:
  - id: ROADMAP-001
    name: M0 — Scaffold and integrity foundation
    url: /ROADMAP.md#ROADMAP-001
---
# integrity-by-construction — Integrity is enforced by the system, not by discipline

One middleware chain for every request and background job; RLS via session settings; triggers for immutability and audit; host-agnostic packaging. Success: a route without a permission declaration cannot ship, and every change is attributable. PRD §6.9, §17, §18.
