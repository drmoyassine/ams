// Invented policy, report-template and Arabic documents and the canned model answers for them, for tests of the configuration
// stages (step H) in core, the API and the UI without any network. The accreditor, its process and its wording are made up.
//   * "Accreditation Process Guide" (English, role policy_procedure, 6 pages): a lifecycle (with a self-study due "no later
//     than July 1 ...", a yearly report), decisions, findings, a response type and a rating scale that does not say how the
//     ratings are combined. One proposed milestone is not in the text at all.
//   * "Self-Study Report Form" (English, role report_template, 3 pages): sections A, B, B.1, tables and an attestation.
//   * "دليل إجراءات الاعتماد" (Arabic, role policy_procedure, 2 pages): a lifecycle step with diacritics on the page, and decisions.

export const FIXTURE_POLICY = {
  title: 'Accreditation Process Guide',
  pages: [
    'Accreditation Process Guide\nChapter 1: Becoming eligible\nAn institution is eligible once it has graduated at least one cohort of students.',
    'Chapter 2: The self-study\nThe institution submits its Self-Study Report no later than July 1 of the calendar year of the visit.\nA draft of the report is approved internally before it is submitted.',
    'Chapter 3: The review\nA review team makes a site visit during the autumn term.',
    'Chapter 4: Decisions\nThe Council may take one of these actions: Full Accreditation, Interim Report, or Not Accredited.\nFull Accreditation is granted for a term of six years.\nA finding is a Deficiency, which requires action, or an Observation, which requires no action.',
    'Chapter 5: After a decision\nEach institution submits an Annual Report every year after its decision.\nThe Council sends a Draft Letter, and the institution replies within 30 days.',
    'Appendix: Rating scale\nSelf-ratings use the Rating Scale: 0 Absent, 1 Partial, 2 Established, 3 Strong. Each indicator is rated.',
  ],
};

export const FIXTURE_TEMPLATE_DOC = {
  title: 'Self-Study Report Form',
  pages: [
    'Self-Study Report Form\nSection A: Introduction\nDescribe the institution and its context. Maximum 500 words.\nSection B: Standards\nB.1 Mission\nAnswer for each standard.',
    'Table 1: Enrolment by year\nColumns: Year, Headcount\nTable 2: Staff by rank\nSection C: Appendices\nAttach the course syllabi.',
    'Attestation\nThe President signs a statement affirming the accuracy of this report.',
  ],
};

export const FIXTURE_ARABIC_POLICY = {
  title: 'دليل إجراءات الاعتماد',
  language: 'ar',
  pages: [
    'دليل إجراءات الاعتماد\nيُقدِّمُ المعهد تقرير الدراسة الذاتية قبل زيارة الفريق بثلاثين يومًا.\nيُرفع تقرير سنوي كل عام بعد صدور القرار.',
    'قرارات المجلس: اعتماد كامل، أو اعتماد مشروط، أو عدم اعتماد.',
  ],
};

const SURVEY_MARK = 'You are helping an institution read the process documents';
const LIFECYCLE_MARK = 'extracting the accreditation PROCESS';
const VOCAB_MARK = 'extracting the VOCABULARIES';
const TEMPLATE_MARK = 'extracting the OUTLINE of a report';

const base = { temp_id: '', text: null, confidence: 0.9, flags: [] };
const src = (page: number, quote: string) => ({ page, quote });
const life = (o: Record<string, unknown>) => ({ ...base, phase_temp_id: null, phase_type: null, milestone_type: null, applies_to: null, required: null, due_text: null, repeat_text: null, deliverable_name: null, ...o });
const voc = (o: Record<string, unknown>) => ({
  ...base, printed_code: null, outcome: null, term_years: null, term_options: null, requires_action: null, reply_required: null, reply_window_days: null, reply_kind: null,
  is_decision: null, scale: null, labels: null, rated_level: null, aggregate: null, ...o,
});
const sec = (o: Record<string, unknown>) => ({ kind: 'report_section', ...base, parent_temp_id: null, number: null, parent_number: null, prompt: null, word_limit: null, columns: null, ...o });

/** What the configuration stages' fake model answers, by task and document. */
export function configAnswers() {
  const part = (pages: number[]) => ({ present: pages.length > 0, pages });
  return {
    nothing: { lifecycle: part([]), vocab: part([]), template: { ...part([]), name: null, kind: null }, note: 'Nothing about the process here.' },
    surveyPolicy: { lifecycle: part([1, 2, 3, 4, 5]), vocab: part([4, 5, 6]), template: { ...part([]), name: null, kind: null }, note: null },
    surveyTemplate: { lifecycle: part([]), vocab: part([]), template: { ...part([1, 2, 3]), name: 'Self-Study Report Form', kind: 'self_study' }, note: null },
    surveyArabic: { lifecycle: part([1]), vocab: part([2]), template: { ...part([]), name: null, kind: null }, note: null },
    lifecyclePolicy: {
      items: [
        life({ kind: 'phase', temp_id: 'p-1', phase_type: 'eligibility', name: 'Becoming eligible', source: src(1, 'Chapter 1: Becoming eligible') }),
        life({ kind: 'milestone', temp_id: 'm-1', phase_temp_id: 'p-1', phase_type: 'eligibility', name: 'has graduated at least one cohort of students', milestone_type: 'task', text: 'An institution is eligible once it has graduated at least one cohort of students.', source: src(1, 'eligible once it has graduated at least one cohort of students') }),
        life({ kind: 'phase', temp_id: 'p-2', phase_type: 'self_study', name: 'The self-study', source: src(2, 'Chapter 2: The self-study') }),
        life({
          kind: 'milestone', temp_id: 'm-2', phase_temp_id: 'p-2', phase_type: 'self_study', name: 'Self-Study Report', milestone_type: 'submission',
          due_text: 'no later than July 1 of the calendar year of the visit', deliverable_name: 'Self-Study Report',
          text: 'The institution submits its Self-Study Report no later than July 1 of the calendar year of the visit.', source: src(2, 'submits its Self-Study Report no later than July 1'),
        }),
        life({ kind: 'milestone', temp_id: 'm-3', phase_temp_id: 'p-2', phase_type: 'self_study', name: 'approved internally', milestone_type: 'task', source: src(2, 'A draft of the report is approved internally before it is submitted') }),
        life({ kind: 'phase', temp_id: 'p-3', phase_type: 'review', name: 'The review', source: src(3, 'Chapter 3: The review') }),
        life({ kind: 'milestone', temp_id: 'm-4', phase_temp_id: 'p-3', phase_type: 'review', name: 'site visit', milestone_type: 'external_event', due_text: 'during the autumn term', source: src(3, 'A review team makes a site visit during the autumn term') }),
        life({ kind: 'phase', temp_id: 'p-5', phase_type: 'maintenance', name: 'After a decision', source: src(5, 'Chapter 5: After a decision') }),
        life({ kind: 'milestone', temp_id: 'm-6', phase_temp_id: 'p-5', phase_type: 'maintenance', name: 'Annual Report', milestone_type: 'submission', due_text: 'after its decision', repeat_text: 'every year', source: src(5, 'Each institution submits an Annual Report every year after its decision') }),
        // Not in the document at all: kept out, listed.
        life({ kind: 'milestone', temp_id: 'm-9', phase_temp_id: 'p-2', phase_type: 'self_study', name: 'Pay the processing fee', milestone_type: 'task', confidence: 0.4, source: src(2, 'The institution pays the processing fee with its application') }),
      ],
    },
    vocabPolicy: {
      items: [
        voc({ kind: 'decision', temp_id: 'd-1', label: 'Full Accreditation', outcome: 'accredited', term_years: 6, source: src(4, 'Full Accreditation is granted for a term of six years') }),
        // No outcome could be chosen: kept out.
        voc({ kind: 'decision', temp_id: 'd-2', label: 'Interim Report', source: src(4, 'Full Accreditation, Interim Report, or Not Accredited') }),
        voc({ kind: 'decision', temp_id: 'd-3', label: 'Not Accredited', outcome: 'not_accredited', source: src(4, 'Full Accreditation, Interim Report, or Not Accredited') }),
        voc({ kind: 'finding_severity', temp_id: 'f-1', label: 'Deficiency', requires_action: true, source: src(4, 'A finding is a Deficiency, which requires action') }),
        voc({ kind: 'finding_severity', temp_id: 'f-2', label: 'Observation', requires_action: false, source: src(4, 'an Observation, which requires no action') }),
        voc({ kind: 'response_type', temp_id: 'r-1', label: 'Draft Letter', reply_required: true, reply_window_days: 30, reply_kind: 'report', source: src(5, 'The Council sends a Draft Letter, and the institution replies within 30 days') }),
        // The scale and labels are given, how ratings are combined is not: kept out, listed.
        voc({
          kind: 'rating_method', temp_id: 'x-1', label: 'Rating Scale', scale: [0, 1, 2, 3], labels: ['Absent', 'Partial', 'Established', 'Strong'], rated_level: 'indicator',
          source: src(6, 'Self-ratings use the Rating Scale: 0 Absent, 1 Partial, 2 Established, 3 Strong'),
        }),
      ],
    },
    templateForm: {
      items: [
        sec({ temp_id: 's-1', number: 'A', title: 'Introduction', prompt: 'Describe the institution and its context.', block_type: 'narrative', word_limit: 500, source: src(1, 'Section A: Introduction') }),
        sec({ temp_id: 's-2', number: 'B', title: 'Standards', block_type: 'narrative', source: src(1, 'Section B: Standards') }),
        sec({ temp_id: 's-3', parent_temp_id: 's-2', number: 'B.1', title: 'Mission', block_type: 'narrative', source: src(1, 'B.1 Mission') }),
        sec({
          temp_id: 's-4', number: 'Table 1', title: 'Enrolment by year', block_type: 'data_table', columns: [{ label: 'Year', type: 'number' }, { label: 'Headcount', type: 'number' }],
          source: src(2, 'Table 1: Enrolment by year'),
        }),
        // A table whose columns the form does not print: a data table needs them, so it is kept out and listed.
        sec({ temp_id: 's-5', number: 'Table 2', title: 'Staff by rank', block_type: 'data_table', source: src(2, 'Table 2: Staff by rank') }),
        sec({ temp_id: 's-6', number: 'C', title: 'Appendices', block_type: 'appendix', source: src(2, 'Section C: Appendices') }),
        sec({ temp_id: 's-7', title: 'Attestation', prompt: 'The President signs a statement affirming the accuracy of this report.', block_type: 'attestation', source: src(3, 'The President signs a statement affirming the accuracy') }),
      ],
    },
    lifecycleArabic: {
      items: [
        life({
          kind: 'milestone', temp_id: 'm-1', phase_type: 'self_study', name: 'تقرير الدراسة الذاتية', milestone_type: 'submission', due_text: 'قبل زيارة الفريق بثلاثين يومًا',
          // Written without the vowel marks of the page.
          source: src(1, 'يقدم المعهد تقرير الدراسة الذاتية قبل زيارة الفريق'),
        }),
      ],
    },
    vocabArabic: {
      items: [
        voc({ kind: 'decision', temp_id: 'd-1', label: 'اعتماد كامل', outcome: 'accredited', source: src(2, 'قرارات المجلس: اعتماد كامل') }),
        voc({ kind: 'decision', temp_id: 'd-2', label: 'عدم اعتماد', outcome: 'not_accredited', source: src(2, 'أو عدم اعتماد') }),
      ],
    },
  };
}

export type ConfigAnswers = ReturnType<typeof configAnswers>;

/**
 * A reply function for createFakeAiModel for the configuration stages: picks the canned answer from the prompt (which task) and
 * the input (which document). Anything else goes to `rest` (for example fixtureResponder), and without it throws.
 * `fail` makes the first call of that task fail once (a crashed job); `calls` records the tasks asked, in order.
 */
export function configResponder(rest?: (options: unknown) => object, opts: { failOnce?: 'lifecycle' | 'vocab' | 'template' | 'config_survey'; answers?: Partial<ConfigAnswers> } = {}) {
  const a = { ...configAnswers(), ...opts.answers };
  const tasks: string[] = [];
  let failed = false;
  const failFor = (task: string) => {
    tasks.push(task);
    if (opts.failOnce === task && !failed) { failed = true; throw new Error('the model is overloaded'); }
  };
  const reply = (options: unknown): object => {
    const s = JSON.stringify(options);
    const doc = (title: string) => s.includes(`Document: ${title}`);
    // The first survey (what a document is) and the structure stage, for versions that hold only these documents.
    if (s.includes('what the document is, one of')) {
      if (doc(FIXTURE_POLICY.title)) return { role: 'policy_procedure', language: 'en', outline: [{ heading: 'Chapter 4: Decisions', page: 4 }], confidence: 0.9 };
      if (doc(FIXTURE_TEMPLATE_DOC.title)) return { role: 'report_template', language: 'en', outline: [{ heading: 'Section A: Introduction', page: 1 }], confidence: 0.9 };
      if (doc(FIXTURE_ARABIC_POLICY.title)) return { role: 'policy_procedure', language: 'ar', outline: [{ heading: 'قرارات المجلس', page: 2 }], confidence: 0.8 };
    }
    if (s.includes('Work out how the accreditor organises its requirements') && !rest) {
      return { level_labels: ['Standard'], numbering: [], key_terms: [], scope: null, confidence: 0.5 };
    }
    if (s.includes(SURVEY_MARK)) {
      failFor('config_survey');
      if (doc(FIXTURE_POLICY.title)) return a.surveyPolicy;
      if (doc(FIXTURE_TEMPLATE_DOC.title)) return a.surveyTemplate;
      if (doc(FIXTURE_ARABIC_POLICY.title)) return a.surveyArabic;
      return a.nothing;
    }
    if (s.includes(LIFECYCLE_MARK)) {
      failFor('lifecycle');
      return doc(FIXTURE_ARABIC_POLICY.title) ? a.lifecycleArabic : a.lifecyclePolicy;
    }
    if (s.includes(VOCAB_MARK)) {
      failFor('vocab');
      return doc(FIXTURE_ARABIC_POLICY.title) ? a.vocabArabic : a.vocabPolicy;
    }
    if (s.includes(TEMPLATE_MARK)) {
      failFor('template');
      return a.templateForm;
    }
    if (rest) return rest(options);
    throw new Error('the fixture has no answer for this prompt');
  };
  return { reply, tasks };
}
