// A small, invented two-document source set and the canned model answers for it, for tests of the framework analysis
// (core, API and UI) without any network. The accreditor and its wording are made up.
//   * "Handbook of Standards" (English, 9 pages, role chosen by a person: standards): two windows, pages 1-8 and 8-9,
//     overlapping on page 8 where criterion 1.2 is proposed twice (cut short in the first window).
//   * "دليل الإرشادات" (Arabic, 1 page, role left to the analysis): a guidance note whose quote matches only after
//     Arabic normalisation (diacritics, tatweel, alef and taa marbuta forms).

export const FIXTURE_HANDBOOK = {
  title: 'Handbook of Standards',
  pages: [
    'Contents\nStandard 1: Mission and Purposes .... 2\nCriterion 1.1 Mission statement .... 3',
    'Standard 1: Mission and Purposes\nThe institution defines its purposes and establishes educational objectives aligned with its purposes.',
    'Criterion 1.1 Mission statement\nThe institution\'s formally approved statements of purpose are appropriate for an institution of higher education and clearly define its essential values and character.',
    '1.1.1 The mission statement is published on the institution\'s website and reviewed every five years.\nInstitutions must provide the board minutes approving the mission.',
    'Criterion 1.9 Records\nThe institution keeps complete records of its governance decisions.',
    'This page intentionally left blank.',
    'Glossary of terms used in this handbook.',
    'Criterion 1.2 Integrity\nThe institution publicly states its commitment to academic freedom for faculty, staff, and students, and acts accordingly.',
    '1.2.1 The institution has a policy on academic freedom that is reviewed annually.\n3.9.1 Graduates are surveyed one year after completion.',
  ],
};

const AR_SENTENCE = 'يَجِبُ عَلَى المؤسسة أنْ تُراجِعَ رسالتها كلَّ خمس سنوات وأن تنشـــرها على موقعها الإلكتروني.';
export const FIXTURE_GUIDE = {
  title: 'دليل الإرشادات',
  language: 'ar',
  pages: [`إرشادات المعيار الأول\n${AR_SENTENCE}`],
};

const item = (o: Record<string, unknown>) => ({
  parent_temp_id: null, code: null, parent_code: null, level_label: null, title: null, note_type: null, authority: null,
  is_assessable: true, confidence: 0.9, flags: [], ...o,
});

/** What the fake model answers, by task and by which document or window it was given. */
export function fixtureAnswers(opts: { revised?: boolean } = {}) {
  const criterion12 = 'The institution publicly states its commitment to academic freedom for faculty, staff, and students, and acts accordingly.';
  return {
    surveyHandbook: { role: 'standards', language: 'en', outline: [{ heading: 'Standard 1: Mission and Purposes', page: 2 }], confidence: 0.9 },
    surveyGuide: { role: 'guidance', language: 'ar', outline: [{ heading: 'إرشادات المعيار الأول', page: 1 }], confidence: 0.8 },
    structure: {
      level_labels: ['Standard', 'Criterion', 'Indicator'],
      numbering: [{ level_label: 'Standard', examples: ['1'] }, { level_label: 'Criterion', examples: ['1.1', '1.2'] }, { level_label: 'Indicator', examples: ['1.1.1'] }],
      key_terms: [{ term: 'mission statement', meaning: null }], scope: 'The institution as a whole.', confidence: 0.9,
    },
    window1: {
      items: [
        item({ kind: 'requirement', temp_id: 'r-1', code: '1', level_label: 'Standard', title: 'Mission and Purposes', text: 'The institution defines its purposes and establishes educational objectives aligned with its purposes.', source: { page: 2, quote: 'defines its purposes and establishes educational objectives' } }),
        item({ kind: 'requirement', temp_id: 'r-2', code: '1.1', parent_code: '1', level_label: 'Criterion', title: 'Mission statement', text: opts.revised ? 'The institution\'s formally approved statements of purpose are appropriate.' : 'The institution\'s formally approved statements of purpose are appropriate for an institution of higher education and clearly define its essential values and character.', source: { page: 3, quote: 'formally approved statements of purpose are appropriate' } }),
        // The parent is given by temp id only: resolved through r-2's code.
        item({ kind: 'requirement', temp_id: 'r-3', parent_temp_id: 'r-2', level_label: 'Indicator', code: '1.1.1', text: 'The mission statement is published on the institution\'s website and reviewed every five years.', source: { page: 4, quote: 'The mission statement is published on the institution\'s website' } }),
        item({ kind: 'note', temp_id: 'n-1', parent_code: '1.1.1', note_type: 'evidence_expectation', authority: 'required', text: 'Institutions must provide the board minutes approving the mission.', source: { page: 4, quote: 'Institutions must provide the board minutes approving the mission.' } }),
        // Not in the source at all: the quote cannot be verified, and the model was unsure.
        item({ kind: 'requirement', temp_id: 'r-5', code: '1.9', parent_code: '1', level_label: 'Criterion', title: 'Records', text: 'The institution must operate a research vessel.', source: { page: 5, quote: 'The institution must operate a research vessel.' }, confidence: 0.4 }),
        // Cut off at the end of the window (page 8 is shared with the next window, which has it in full).
        item({ kind: 'requirement', temp_id: 'r-4', code: '1.2', parent_code: '1', level_label: 'Criterion', title: 'Integrity', text: 'The institution publicly states its commitment to academic freedom', source: { page: 8, quote: 'publicly states its commitment to academic freedom' }, flags: ['possible_omission'] }),
      ],
    },
    window2: {
      items: [
        item({ kind: 'requirement', temp_id: 'r-1', code: '1.2', parent_code: '1', level_label: 'Criterion', title: opts.revised ? 'Integrity and academic freedom' : 'Integrity', text: criterion12, source: { page: 8, quote: 'publicly states its commitment to academic freedom for faculty' } }),
        item({ kind: 'requirement', temp_id: 'r-2', code: '1.2.1', parent_code: '1.2', level_label: 'Indicator', text: 'The institution has a policy on academic freedom that is reviewed annually.', source: { page: 9, quote: 'has a policy on academic freedom that is reviewed annually' } }),
        // "required", but the quote is not on the page: it is written as the AI's suggestion, flagged.
        item({ kind: 'note', temp_id: 'n-1', parent_code: '1.2.1', note_type: 'guidance', authority: 'required', text: 'Faculty handbooks should describe how the policy is applied.', source: { page: 9, quote: 'Faculty handbooks describe how the policy is applied' } }),
        // Its parent 3.9 is nowhere: an orphan, kept at the top level and flagged.
        item({ kind: 'requirement', temp_id: 'r-3', code: '3.9.1', parent_code: '3.9', level_label: 'Indicator', text: 'Graduates are surveyed one year after completion.', source: { page: 9, quote: 'Graduates are surveyed one year after completion.' } }),
      ],
    },
    guide: {
      items: [
        // The quote is written without diacritics, tatweel or hamza forms, and with ه / ي for ة / ى.
        item({ kind: 'note', temp_id: 'n-1', parent_code: '1.1', note_type: 'guidance', authority: 'required', text: AR_SENTENCE, source: { page: 1, quote: 'يجب علي المؤسسه ان تراجع رسالتها كل خمس سنوات وان تنشرها' } }),
        // A guidance document does not state requirements: this one is kept out.
        item({ kind: 'requirement', temp_id: 'r-1', code: '9', level_label: 'Standard', text: 'إرشادات المعيار الأول', source: { page: 1, quote: 'إرشادات المعيار الأول' } }),
      ],
    },
  };
}

/**
 * A reply function for createFakeAiModel: picks the canned answer from the prompt (which task) and the input (which
 * document or window), so the order of calls does not matter.
 */
export function fixtureResponder(opts: { revised?: boolean } = {}) {
  const a = fixtureAnswers(opts);
  return (options: unknown): object => {
    const s = JSON.stringify(options);
    if (s.includes('what the document is, one of')) return s.includes(FIXTURE_GUIDE.title) ? a.surveyGuide : a.surveyHandbook;
    if (s.includes('Work out how the accreditor organises its requirements')) return a.structure;
    if (s.includes('You are extracting an accreditation body')) {
      if (s.includes(FIXTURE_GUIDE.title)) return a.guide;
      return s.includes('This window: pages 8 to 9') ? a.window2 : a.window1;
    }
    throw new Error('the fixture has no answer for this prompt');
  };
}
