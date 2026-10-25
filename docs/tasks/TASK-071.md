---
id: TASK-071
title: Translate the IQF and the standards into the secondary language
description: >-
  A background translation job and a side-by-side review screen store translations beside the English, flag them out of
  date when the English changes, and label external-standard translations as not the official wording
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
  - id: TASK-070
    name: 'Languages: secondary language, UI language and content switchers'
    url: /TASKS.md#TASK-070
related_decisions:
  - id: DEC-028
    name: Organization has two tabs; one secondary language; translations of standards are unofficial; per-person UI language; org-chart images may go to the vision model; every AI-import place gets a Docs tab
    url: /DECISIONS.md#DEC-028
  - id: DEC-021
    name: Framework analysis may send the institution's IQF text to the AI
    url: /DECISIONS.md#DEC-021
modified:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
---
# TASK-071 — Translate the IQF and the standards into the secondary language

Section D of docs/organization-plan.md. content_translation table (entity, language, field, text, origin, reviewed, source hash); translate job in the agent service (framework text only, DEC-021; glossary-aware; spend cap; progress); review screen (accept, edit, retranslate; filters needs review and out of date); the existing translation_en becomes the English row; the assistant can offer to translate a selection.

**Done (2026-10-14).** Built: `content_translation` (migration 0057: institution, kind `iqf`|`standard`, framework version, entity id, field `title`|`statement`|`note`, language, source hash, text, origin ai|person, reviewed, run; tenant RLS, audit; the worker may only add unreviewed AI rows and change the text of an unreviewed AI row, as for `ui_translation`); `translation_run.kind` also `iqf` and `standard` (scope = the framework version); two registered TranslationSources (requirement title, statement, note text; a requirement already in the secondary language is skipped; a non-English standard uses `translation_en` for the statement) through the unchanged engine; stale detection by source hash (changed English -> "Out of date", re-translated only on request and only if unreviewed AI); routes under `/api/framework-versions/{id}/translations` (status, map, review items, edit, mark reviewed, translate, cancel, resume; read `framework:read`, change `framework:write`); on the version page a content switcher English | secondary language (`useContentLanguage`) that shows the translation beside the English with English as the fallback, a Translate action with progress, cancel and resume, and a review dialog (filters, edit, mark reviewed, mark all, re-translate out-of-date). Translations of an external standard are labelled "Unofficial translation" wherever shown (DEC-028); English is never replaced and nothing here feeds quote matching or exports. Arabic is stored NFC and shown with `dir="auto"`. The glossary is not a source: it already keeps its Arabic label and definition beside the English and is the vocabulary the translator is given. Frozen versions: the frozen-version triggers guard requirement, requirement_note and the other version tables, not `content_translation` (no foreign key to the entity or version, so it is also kept through the Trash), so a published version can still get translations while its English stays immutable (tested at database level). Not in this task: translating reports, templates and lifecycle labels; the assistant offering to translate a selection; carrying translations over to a new version's copied requirements.
