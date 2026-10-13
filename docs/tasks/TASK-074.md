---
id: TASK-074
title: Org chart: directory sync (LDAP)
description: >-
  A read-only LDAP/LDAPS connector keeps the chart in step with a directory, with a what-would-change list, scheduled
  runs and locks on units a person edited
status: pending
priority: P3
last_updated: '2026-10-13'
generated:
  by: agent/claude-code
  at: '2026-10-13T13:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-072
    name: Org chart: visual builder (tree and chart view)
    url: /TASKS.md#TASK-072
modified:
  by: agent/claude-code
  at: '2026-10-13T13:00:00.000Z'
---
# TASK-074 — Org chart: directory sync (LDAP)

Step 6 of docs/organization-plan.md. Settings (server, bind account encrypted at rest, base DN, filters, attribute mapping); a scheduled job in the general worker service; diff shown before apply (or automatic apply switched on); never deletes (Trash); sign-in through the directory is a separate question. Needs the owner to say which directory is used.
