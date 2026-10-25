---
id: TASK-070
title: 'Languages: secondary language, UI language and content switchers'
description: >-
  An administrator chooses one secondary language; each person picks the interface language; library screens switch
  between original, English and the secondary language; primary is always English
status: completed
priority: P2
last_updated: '2026-10-14'
generated:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-069
    name: 'Organization screen: Institution and Programs tabs, institution logo, read-only Settings'
    url: /TASKS.md#TASK-069
related_decisions:
  - id: DEC-028
    name: Organization has two tabs; one secondary language; translations of standards are unofficial; per-person UI language; org-chart images may go to the vision model; every AI-import place gets a Docs tab
    url: /DECISIONS.md#DEC-028
modified:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
---
# TASK-070 — Languages: secondary language, UI language and content switchers

Section D of docs/organization-plan.md. Language registry (direction, font, native name), institution secondary-language setting (Institution tab, Languages section), per-person UI language (default from the institution), UI catalogues (English in the repository, the secondary produced by the translation job and reviewable), content switcher with fallback to English, right-to-left and CJK visual pass.

**Done (2026-10-14).** Built: language registry (31 languages) in packages/shared; `institution.secondary_language` and `app_user.ui_locale` (migration 0057; `default_locale` now means the default interface language, English or the secondary); Languages section in Institution; header language menu with `PATCH /api/me/preferences`; the English catalogue (packages/shared/src/locales/en.ts), `ui_translation`, `GET /api/i18n/{language}` and the sign-in page's `GET /api/public/i18n`; the generic `translate` job (kind `ui`) in the agent service; RTL and script font stacks; `pnpm i18n:extract`, `pnpm i18n:coverage`, the `ams/no-literal-ui-text` lint warning and docs/i18n-coverage.md. Not in this task: the content switcher on library screens and content translation (TASK-071; the `useContentLanguage()` hook is in place), and converting the rest of the hard-coded English (see docs/i18n-coverage.md).
