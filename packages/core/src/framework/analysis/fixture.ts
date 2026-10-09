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
    // Step D: nothing more is in these sources; every question is answered "not there".
    if (s.includes(RECOVER_MARK)) return { answers: questionIds(s).map((id) => ({ id, found: false, reason: 'It is not on these pages.', items: [] })) };
    throw new Error('the fixture has no answer for this prompt');
  };
}

// ---- Step D: a source with gaps the first extraction leaves ---------------------------------------------------------
//   * 2.3 is on page 3 but the extraction misses it: the numbering gap 2.2 -> 2.4 asks for it and it is recovered.
//   * 2.5 does not exist (the numbering skips from 2.4 to 2.6): the model confirms it is absent.
//   * 2.4 is extracted with a quote that is not on the page: re-cited wrongly in the first round, rightly in the second.
//   * Page 1 is a table of contents: never asked about.

export const FIXTURE_GAPPY = {
  title: 'Standards for Teaching',
  pages: [
    'Contents\nStandard 2 Teaching and Learning .... 2\n2.1 Curriculum .... 2\n2.2 Assessment .... 3\n2.3 Feedback .... 3\n2.4 Support .... 4\n2.6 Facilities .... 5',
    'Standard 2: Teaching and Learning\nThe institution designs, delivers and reviews its programmes so that students achieve the intended learning outcomes.\n2.1 Curriculum\nEach programme has a curriculum with published learning outcomes that are reviewed at least every five years.',
    '2.2 Assessment\nAssessment methods are aligned with the learning outcomes and are applied consistently across sections.\n2.3 Feedback\nStudents receive timely feedback on assessed work so that they can improve their learning.',
    '2.4 Support\nThe institution provides academic advising and learning support services that are available to all students.\nProgrammes should publish the advising hours each term.',
    '2.6 Facilities\nTeaching spaces, laboratories and libraries are adequate for the number of students enrolled.',
  ],
};
const RECOVER_MARK = 'You are checking an extraction';
/** The ids of the questions in a recovery call ("- id q1: ..."). */
export const questionIds = (s: string) => [...s.matchAll(/- id (q\d+):/g)].map((m) => m[1]!);
const questionText = (s: string, id: string) => (s.split(`- id ${id}: `)[1] ?? '').split('- id q')[0]!;

export function gappyAnswers() {
  const p = FIXTURE_GAPPY.pages;
  const line = (page: number, n: number) => p[page - 1]!.split('\n')[n]!;
  return {
    survey: { role: 'standards', language: 'en', outline: [{ heading: 'Standard 2: Teaching and Learning', page: 2 }], confidence: 0.9 },
    structure: {
      level_labels: ['Standard', 'Criterion'],
      numbering: [{ level_label: 'Standard', examples: ['2'] }, { level_label: 'Criterion', examples: ['2.1', '2.2'] }],
      key_terms: [], scope: 'Programmes.', confidence: 0.9,
    },
    window: {
      items: [
        item({ kind: 'requirement', temp_id: 'r-1', code: '2', level_label: 'Standard', title: 'Teaching and Learning', text: line(2, 1), source: { page: 2, quote: 'designs, delivers and reviews its programmes' } }),
        item({ kind: 'requirement', temp_id: 'r-2', code: '2.1', parent_code: '2', level_label: 'Criterion', title: 'Curriculum', text: line(2, 3), source: { page: 2, quote: 'a curriculum with published learning outcomes' } }),
        item({ kind: 'requirement', temp_id: 'r-3', code: '2.2', parent_code: '2', level_label: 'Criterion', title: 'Assessment', text: line(3, 1), source: { page: 3, quote: 'Assessment methods are aligned with the learning outcomes' } }),
        // 2.3 is missed. 2.4's quote is not on the page.
        item({ kind: 'requirement', temp_id: 'r-4', code: '2.4', parent_code: '2', level_label: 'Criterion', title: 'Support', text: line(4, 1), source: { page: 4, quote: 'The institution offers advising to every single student enrolled' } }),
        item({ kind: 'note', temp_id: 'n-1', parent_code: '2.4', note_type: 'guidance', authority: 'suggested', text: line(4, 2), source: { page: 4, quote: 'Programmes should publish the advising hours each term.' } }),
        item({ kind: 'requirement', temp_id: 'r-5', code: '2.6', parent_code: '2', level_label: 'Criterion', title: 'Facilities', text: line(5, 1), source: { page: 5, quote: 'laboratories and libraries are adequate for the number of students' } }),
      ],
    },
    recovered23: item({ kind: 'requirement', temp_id: 'r-1', code: '2.3', parent_code: '2', level_label: 'Criterion', title: 'Feedback', text: line(3, 3), source: { page: 3, quote: 'Students receive timely feedback on assessed work' } }),
    recited24: (right: boolean) => item({
      kind: 'requirement', temp_id: 'r-1', code: '2.4', parent_code: '2', level_label: 'Criterion', title: 'Support', text: line(4, 1),
      source: { page: 4, quote: right ? 'provides academic advising and learning support services' : 'Advising is offered to every student in every term of study' },
    }),
  };
}

/**
 * The fake model for FIXTURE_GAPPY. `questions` records every recovery question asked, in order. With `absent23` the
 * model says 2.3 is not there either; with `failRecover` the first recovery call fails (a crashed job).
 */
export function gappyResponder(opts: { absent23?: boolean; failRecover?: boolean } = {}) {
  const a = gappyAnswers();
  const questions: string[] = [];
  let recites = 0;
  let failures = 0;
  const reply = (options: unknown): object => {
    const s = JSON.stringify(options);
    if (s.includes('what the document is, one of')) return a.survey;
    if (s.includes('Work out how the accreditor organises its requirements')) return a.structure;
    if (s.includes('You are extracting an accreditation body')) return a.window;
    if (s.includes(RECOVER_MARK)) {
      if (opts.failRecover && failures < 1) { failures++; throw new Error('the model is overloaded'); }
      return {
        answers: questionIds(s).map((id) => {
          const q = questionText(s, id);
          questions.push(q);
          if (q.includes('coded \\"2.3\\"') && !opts.absent23) return { id, found: true, reason: null, items: [a.recovered23] };
          if (q.includes('Re-cite the requirement coded \\"2.4\\"')) return { id, found: true, reason: null, items: [a.recited24(recites++ > 0)] };
          return { id, found: false, reason: q.includes('2.5') ? 'The numbering goes from 2.4 to 2.6; there is no 2.5.' : 'It is not on these pages.', items: [] };
        }),
      };
    }
    throw new Error('the fixture has no answer for this prompt');
  };
  return { reply, questions };
}
