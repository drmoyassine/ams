// A small, invented policy document and the canned model answers for an analysis of the INTERNAL quality framework
// (TASK-107), for tests without any network. The institution and its wording are made up. The v2 prompts of the
// survey, structure, extract and recover stages are matched by their own phrases; the wording stage (wording.v1) runs
// last, over the same window the extraction read, and proposes for one item a person wrote.
export const FIXTURE_MANUAL = {
  title: 'Quality Policy Manual',
  pages: [
    'Quality Policy\nThe institution reviews its mission every five years and publishes the review on its website.',
    'The institution evaluates programme learning outcomes annually and acts on the findings.',
  ],
};

const item = (o: Record<string, unknown>) => ({
  parent_temp_id: null, code: null, parent_code: null, level_label: null, title: null, note_type: null, authority: null,
  is_assessable: true, confidence: 0.9, flags: [], ...o,
});

export function internalAnswers(opts: { wordingText?: string } = {}) {
  const wordingText = opts.wordingText ?? 'The institution defines its mission, reviews it every five years and publishes the review on its website.';
  return {
    survey: { role: 'standards', language: 'en', outline: [{ heading: 'Quality Policy', page: 1 }], confidence: 0.9 },
    structure: {
      level_labels: ['Policy', 'Section'],
      numbering: [{ level_label: 'Policy', examples: ['QP-1'] }, { level_label: 'Section', examples: ['QP-1.1'] }],
      key_terms: [], scope: 'The institution as a whole.', confidence: 0.9,
    },
    window: {
      items: [
        item({ kind: 'requirement', temp_id: 'r-1', code: 'QM-1', level_label: 'Policy', title: 'Mission review', text: 'The institution reviews its mission every five years and publishes the review on its website.', source: { page: 1, quote: 'reviews its mission every five years and publishes the review' } }),
        item({ kind: 'requirement', temp_id: 'r-2', code: 'QM-2', level_label: 'Policy', title: 'Learning outcomes', text: 'The institution evaluates programme learning outcomes annually and acts on the findings.', source: { page: 2, quote: 'evaluates programme learning outcomes annually' } }),
      ],
    },
    wording: {
      items: [
        // The one that checks out: item 1.1 is a person's, the quote is on page 1, and the proposal is complete wording.
        { temp_id: 'w-1', code: '1.1', source: { page: 1, quote: 'reviews its mission every five years' }, proposed_text: wordingText, reason: 'The policy adds that the review is published.' },
        // Not on page 2: refused by the word-for-word check.
        { temp_id: 'w-2', code: '1.1', source: { page: 2, quote: 'The institution holds a grand ceremony every year' }, proposed_text: 'The institution holds a grand ceremony every year.', reason: null },
        // The run's own item, not a person's: not offered for wording at all, and dropped.
        { temp_id: 'w-3', code: 'QM-1', source: { page: 1, quote: 'reviews its mission every five years' }, proposed_text: 'The institution reviews its mission.', reason: null },
      ],
    },
  };
}

/**
 * A reply function for createFakeAiModel for an internal-framework analysis: picks the canned answer from the prompt
 * (which task and which prompt version) and the input (which window), so the order of calls does not matter.
 */
export function internalResponder(opts: { wordingText?: string } = {}) {
  const a = internalAnswers(opts);
  return (options: unknown): object => {
    const s = JSON.stringify(options);
    if (s.includes('improve the wording of its internal quality framework')) return a.wording;
    if (s.includes('You are checking an extraction')) {
      return { answers: [...s.matchAll(/- id (q\d+):/g)].map((m) => ({ id: m[1]!, found: false, reason: 'It is not on these pages.', items: [] })) };
    }
    if (s.includes('extracting an institution\'s internal quality framework')) return a.window;
    if (s.includes('Work out how the institution organises its requirements')) return a.structure;
    if (s.includes('what the document is, one of')) return a.survey;
    throw new Error('the internal fixture has no answer for this prompt');
  };
}
