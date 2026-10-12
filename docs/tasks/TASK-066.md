---
id: TASK-066
title: In-app assistant, phase 1 (plumbing, conversations, memory, read-only answers)
description: >-
  The assistant bubble and panel, conversations kept per person, the `assistant` job in the agent service, read-only tools over
  framework content, scoped memory with confirmation, and the Settings role and memory page; no write tools yet
status: completed
priority: P2
last_updated: '2026-10-12'
generated:
  by: agent/claude-code
  at: '2026-10-12T18:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-064
    name: In-app assistant for bulk edits (plan)
    url: /TASKS.md#TASK-064
related_decisions:
  - id: DEC-027
    name: The in-app assistant is a companion that inherits the user's privileges, edits only drafts, and keeps scoped memory
    url: /DECISIONS.md#DEC-027
modified:
  by: agent/claude-code
  at: '2026-10-12T18:00:00.000Z'
---
# TASK-066 — In-app assistant, phase 1

Built from docs/assistant-plan.md, phase 1. See the plan's Status section for what is where.

- Migrations 0048-0049: `assistant_conversation`, `assistant_message`, `memory_item` (tenant RLS, owner-only conversations, private/shared memory, worker grants, audit of metadata only, the audited administrator functions).
- `aiAgent` in the one AI import point, prompt `assistant.v1`, an Assistant role in Settings -> AI -> Models, job type `assistant` in the agent group.
- Read tools over framework content and `propose_memory`; memory retrieval (words only, no embeddings); API under `/api/assistant`; bubble, panel, chips, memory cards and the Settings -> Assistant memory page.
- Not in this task: write tools and in-chat confirmation of edits (phase 2), a nightly memory clean-up job, embedding-based memory retrieval (needs a DEC-023 amendment).
