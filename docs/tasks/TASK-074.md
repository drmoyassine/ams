---
id: TASK-074
title: Org chart: directory sync (LDAP first, QuickLaunch and Active Directory to be confirmed)
description: >-
  A read-only directory connector keeps the chart in step with a directory, with a what-would-change list, scheduled
  runs and locks on units a person edited
status: pending
priority: P3
last_updated: '2026-10-13'
generated:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-072
    name: Org chart: visual builder (tree and chart view)
    url: /TASKS.md#TASK-072
related_decisions:
  - id: DEC-028
    name: Organization has two tabs; one secondary language; translations of standards are unofficial; per-person UI language; org-chart images may go to the vision model; every AI-import place gets a Docs tab
    url: /DECISIONS.md#DEC-028
modified:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
---
# TASK-074 — Org chart: directory sync (LDAP first, QuickLaunch and Active Directory to be confirmed)

Section E.3 and E.4 of docs/organization-plan.md. Connector interface with LDAP/LDAPS first; settings (server, bind account encrypted at rest, base DN, filters, attribute mapping); a scheduled job in the general worker service; diff before apply (or automatic apply); never deletes (Trash). Blocked on the owner: ask IT which protocols QuickLaunch exposes (SAML or OIDC for sign-in, SCIM, LDAP or an export for users and units) and request Active Directory access; a CSV import through the Docs pattern is the fallback.
