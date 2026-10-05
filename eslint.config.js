import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-types/**', '**/node_modules/**', '.vef/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
