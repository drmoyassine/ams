import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** The browser's own dialogs: never in the web app (DEC-026). Use `useConfirm()` from components/confirm-dialog. */
const inApp = 'Use the in-app dialog: `const confirm = useConfirm()` from components/confirm-dialog (a Dialog with focus handling), never the browser\'s.';
const BROWSER_DIALOGS = ['confirm', 'alert', 'prompt'];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-types/**', '**/node_modules/**', '.vef/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
