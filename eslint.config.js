import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import noLiteralUiText from './scripts/eslint-no-literal-ui-text.js';

/** The browser's own dialogs: never in the web app (DEC-026). Use `useConfirm()` from components/confirm-dialog. */
const inApp = 'Use the in-app dialog: `const confirm = useConfirm()` from components/confirm-dialog (a Dialog with focus handling), never the browser\'s.';
const BROWSER_DIALOGS = ['confirm', 'alert', 'prompt'];

/**
 * Files whose visible text already goes through t() (TASK-070, docs/i18n-coverage.md). New hard-coded English in them is a
 * warning. Add a file or directory here when it is converted.
 */
export const CONVERTED_UI = [
  'apps/web/src/pages/layout.tsx', 'apps/web/src/pages/login.tsx', 'apps/web/src/pages/settings/layout.tsx',
  'apps/web/src/pages/settings/languages-section.tsx', 'apps/web/src/pages/version/translations.tsx',
  'apps/web/src/components/confirm-dialog.tsx', 'apps/web/src/components/undo-toaster.tsx', 'apps/web/src/components/read-only-note.tsx',
  'apps/web/src/components/term-mode.tsx', 'apps/web/src/components/json-editor.tsx', 'apps/web/src/components/data-grid.tsx',
  'apps/web/src/components/evidence-links.tsx', 'apps/web/src/components/badges.tsx',
  'apps/web/src/components/assistant/launcher.tsx', 'apps/web/src/components/assistant/panel.tsx',
  'apps/web/src/pages/settings/quality-management/templates-page.tsx', 'apps/web/src/pages/settings/quality-management/template-editor.tsx',
  'apps/web/src/pages/settings/quality-management/stage-card.tsx', 'apps/web/src/pages/settings/quality-management/stage-timeline.tsx',
  'apps/web/src/components/cycles/launch-cycle-dialog.tsx', 'apps/web/src/components/cycles/labels.tsx', 'apps/web/src/components/standard-ops/create-cycle-dialog.tsx',
  'apps/web/src/pages/quality-management.tsx', 'apps/web/src/pages/cycles/cycles-tab.tsx', 'apps/web/src/pages/cycles/my-work.tsx', 'apps/web/src/pages/cycles/cycle-page.tsx',
  'apps/web/src/pages/cycles/stage-card.tsx', 'apps/web/src/pages/cycles/cycle-timeline.tsx', 'apps/web/src/pages/cycles/output-slot.tsx', 'apps/web/src/pages/cycles/input-row.tsx',
  'apps/web/src/pages/cycles/dialogs.tsx', 'apps/web/src/pages/cycles/draft-dialogs.tsx',
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-types/**', '**/node_modules/**', '.vef/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: CONVERTED_UI,
    plugins: { ams: noLiteralUiText },
    rules: { 'ams/no-literal-ui-text': 'warn' },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': ['error', ...BROWSER_DIALOGS.map((name) => ({ name, message: inApp }))],
      'no-restricted-properties': ['error',
        ...['window', 'globalThis', 'self'].flatMap((object) => BROWSER_DIALOGS.map((property) => ({ object, property, message: inApp }))),
      ],
    },
  },
);
