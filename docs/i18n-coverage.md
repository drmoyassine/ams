# Interface translation coverage (TASK-070, measured 2026-10-14)

How much of the web app's visible text goes through `t()` (and so can be shown in the institution's secondary language), what remains, and the order to convert it. Measured with `pnpm i18n:coverage` (`scripts/i18n-coverage.mjs`, TypeScript parser, no tests).

## How it is counted

Per area of `apps/web/src`: `t()` calls with a literal key, against hard-coded literals: JSX text with letters, visible attributes (`title`, `placeholder`, `aria-label`, `alt`, `label`), string literals written as JSX expressions, and object properties that carry wording (`label`, `title`, `message`, `hint`, ...). Coverage = t / (t + literals). It is an approximation: a long sentence counts once, strings built in logic (server error messages, template strings with data) are counted on neither side. The trend per area is what matters.

## Before and after

| Area | Before: t() / literals | After: t() / literals | Coverage after |
|---|---|---|---|
| Shell (layout, sign-in, Settings menu, router) | 14 / 21 (40%) | 34 / 3 | 91.9% |
| Shared chrome (confirm dialog, toasts, read-only note, badges, ...) | 0 / 38 | 21 / 23 | 47.7% |
| Assistant (launcher, panel) | 0 / 88 | 46 / 60 | 43.4% |
| Settings: Organization and Languages | 0 / 88 | 71 / 80 | 47% |
| Settings: other pages | 0 / 267 | 8 / 258 | 3% |
| Other shared components | 0 / 286 | 20 / 269 | 6.9% |
| Tree | 0 / 11 | 0 / 11 | 0% |
| Version pages | 0 / 590 | 0 / 590 | 0% |
| Engagement pages | 0 / 127 | 0 / 127 | 0% |
| Other pages | 1 / 201 | 1 / 201 | 0.5% |
| lib | 0 / 3 | 2 / 4 | 33% |
| **All** | **15 / 1,720 (0.9%)** | **203 / 1,626 (11.1%)** | |

The app was almost entirely hard-coded English before this task: 0.9% went through `t()`. It is now 11.1% by count, and the parts every person sees on every screen (sign-in page, header, sidebar, Settings menu and page titles, dialogs, the undo toast, the assistant's chrome, the language settings) are converted. The long tail is the pages themselves. Dates, numbers and sizes in the converted shared components use `Intl` with the active language (`lib/intl.ts`); pages not yet converted still format with fixed English locales.

## What remains, and the recommended order

1. **Engagement screens** (127 literals): the daily screens for most people. Roadmap, requirements tab, members, template update.
2. **Evidence and requests** (the `components/` group, 269 literals: evidence card, requests, dataset panel, forms).
3. **Settings pages** (258): glossary rows, Programs, IQF requirements editor, Trash rows, assistant memory, AI settings.
4. **Version pages** (590, the largest): requirements tabs, analysis panel and report, sources. Left alone on purpose in this task because another change is reworking the Docs tab and version page; convert after it lands.
5. **Tree** (11), **other pages** (201: standards list, workspace, create-from-files), remaining `lib` strings (error messages built in code).
6. **Org chart section** of Organization: left for the org chart builder work in progress.

Not translated by design: the product name (`appName`), public form and one-time response pages (external respondents, outside the institution's setting), server error messages (English; a later task may map error codes to keys), exports and reports (arrive with M4).

## Keeping converted areas converted

- Converted files are listed in `CONVERTED_UI` in `eslint.config.js`; the rule `ams/no-literal-ui-text` (`scripts/eslint-no-literal-ui-text.js`) warns about new JSX text literals and visible string attributes in them. It is a warning, not an error, and `apps/web/src/lint-rules.test.ts` checks that the listed files are clean today. When you convert a file, add it to the list.
- `pnpm i18n:extract` (needs `pnpm build`) lists keys used in code but missing from `packages/shared/src/locales/en.ts` (exit 1) and catalogue keys nothing uses.
- Add English only to `locales/en.ts`; never translate by hand in the repository. The secondary language is produced by the `translate` job and reviewed in Settings -> Organization -> Languages.
- Write strings without plural forms (`{{count}} items`-style text that reads right for any number) and keep `{{placeholders}}`; the job refuses a translation that drops or changes one.
