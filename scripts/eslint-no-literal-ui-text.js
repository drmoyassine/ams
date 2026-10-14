// ESLint rule `ams/no-literal-ui-text` (TASK-070): in files whose text already goes through t() (the converted list in
// eslint.config.js), new hard-coded English in JSX is flagged so converted areas do not regress. Warning level: the rest of the
// app is converted area by area (docs/i18n-coverage.md). Flags JSX text with letters, and string-literal values of the
// attributes people see or hear (title, placeholder, aria-label, alt, label). `{t('key')}` and text inside <code> are fine.
const ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label']);
const hasLetters = (s) => /\p{L}{2,}/u.test(s);

export default {
  rules: {
    'no-literal-ui-text': {
      meta: { type: 'suggestion', schema: [], messages: {
        text: 'Hard-coded UI text "{{text}}": use t(\'area.key\') and add the English to packages/shared/src/locales/en.ts (docs/i18n-coverage.md).',
        attr: 'Hard-coded {{name}} "{{text}}": use t(\'area.key\') and add the English to packages/shared/src/locales/en.ts.',
      } },
      create(context) {
        return {
          JSXText(node) {
            const text = node.value.replace(/\s+/g, ' ').trim();
            if (!hasLetters(text)) return;
            const parent = node.parent;
            const tag = parent?.openingElement?.name?.name;
            if (tag === 'code' || tag === 'pre' || tag === 'kbd') return;
            context.report({ node, messageId: 'text', data: { text: text.length > 40 ? `${text.slice(0, 40)}…` : text } });
          },
          JSXAttribute(node) {
            const name = node.name?.name;
            if (typeof name !== 'string' || !ATTRS.has(name) || node.value?.type !== 'Literal' || typeof node.value.value !== 'string') return;
            if (!hasLetters(node.value.value)) return;
            context.report({ node, messageId: 'attr', data: { name, text: node.value.value } });
          },
        };
      },
    },
  },
};
