// The cycle templates the product ships (TASK-079, DEC-029): annual program report, periodic program review, administrative unit
// review, internal audit, semesterly course assessment and a blank custom template. They are DATA, never code per accreditor
// (DEC-002): each is a plain stage list (inputs -> process -> outputs) that `installDefaultTemplates` writes into the institution's
// own templates as published ones with origin "default"; from then on the institution edits (revises) them like any other.
// Review is only stages whose output is an approval, worded "Internally approved" when decided (DEC-005): nothing here says met,
// compliant or a score. Every default passes `validateTemplateStages` (the unit test checks it).
import type { CreateCycleTemplate, InputDef, OutputDef, PersonRule, StageDef, UnitRule } from './cycles.js';

/** What the author of a default writes; the rest (empty process, no checklist, the cycle's own unit and lead) is filled in. */
interface StageSpec {
  key: string; name: string; nameAr: string; process: string; checklist?: string[]; unit?: UnitRule; owner?: PersonRule;
  start: number; days: number; outputs: OutputDef[]; inputs?: InputDef[];
}
const stage = (s: StageSpec): StageDef => ({
  key: s.key, name: s.name, nameAr: s.nameAr, process: s.process, checklist: s.checklist ?? [], unit: s.unit ?? { kind: 'cycle' }, owner: s.owner ?? { kind: 'cycle_lead' },
  startOffsetDays: s.start, lengthDays: s.days, outputs: s.outputs, inputs: s.inputs ?? [],
});
const out = (key: string, name: string, nameAr: string, kind: OutputDef['kind'], more: Partial<OutputDef> = {}): OutputDef => ({ key, name, nameAr, kind, required: true, ...more });
const inp = (key: string, name: string, nameAr: string, from: InputDef['from'], required = true): InputDef => ({ key, name, nameAr, from, required });
const fromStage = (stageKey: string, output: string): InputDef['from'] => ({ stage: stageKey, output });
const previous = (stageKey: string, output: string): InputDef['from'] => ({ previousCycle: { stage: stageKey, output } });
const pick = (kind: 'document' | 'evidence' | 'requirement' | 'any'): InputDef['from'] => ({ pick: kind });

const SUBJECT: UnitRule = { kind: 'subject' };
const PARENT: UnitRule = { kind: 'parent_of_subject' };
const HEAD: PersonRule = { kind: 'head_of_unit' };
const HEAD_ABOVE: PersonRule = { kind: 'head_of_parent_unit' };
const LEAD_ROLE: PersonRule = { kind: 'role', role: 'lead' };
const EVIDENCE_HEAD: PersonRule = { kind: 'head_of_evidence_unit' };

/**
 * Evidence collection (DEC-030): the one cycle the screens offer. Collect (the owner gets a new version of the evidence item; uploading one
 * to the item during the stage writes the note below and makes it final) -> Review (a named approver signs it off internally).
 */
const EVIDENCE_COLLECTION: CreateCycleTemplate = {
  key: 'evidence_collection', name: 'Evidence collection', nameAr: 'جمع الأدلة', origin: 'default',
  description: 'Collect a new version of one piece of evidence on a regular basis and have it reviewed: the owner gets the new version, then a named reviewer approves it internally.',
  anchorKinds: ['evidence_item'],
  stages: [
    stage({
      key: 'collect', name: 'Collect', nameAr: 'الجمع', start: 0, days: 30,
      process: 'Get the new version of this evidence item and upload it to the item on the Evidence page. When you do, the output below is filled in and made final for you. If there is nothing new, write a note saying why and mark it final.',
      checklist: ['Get the new version from its source', 'Upload it to the evidence item', 'Check that it covers the period'],
      outputs: [out('evidence_version', 'New version of the evidence', 'النسخة الجديدة من الدليل', 'note')],
    }),
    stage({
      key: 'review', name: 'Review', nameAr: 'المراجعة', start: 30, days: 14,
      process: 'The reviewer reads the new version and either approves it internally, approves it with conditions or returns it for changes.',
      outputs: [out('review_signoff', 'Review sign-off', 'اعتماد المراجعة', 'approval', { approver: EVIDENCE_HEAD })],
      inputs: [inp('collected', 'New version of the evidence', 'النسخة الجديدة من الدليل', fromStage('collect', 'evidence_version'))],
    }),
  ],
};

/** Annual program report: Collect (evidence, data) -> Self-evaluation (report) -> head of the unit (approval) -> QA review (approval) -> Final report. */
const ANNUAL_PROGRAM_REPORT: CreateCycleTemplate = {
  key: 'annual_program_report', name: 'Annual program report', nameAr: 'التقرير السنوي للبرنامج', origin: 'default',
  description: 'The yearly report of a program: collect the year\'s evidence and data, write the self-evaluation, have it reviewed by the head of the unit and by quality assurance, and issue the final report.',
  anchorKinds: ['program', 'org_unit', 'framework_version', 'requirement'],
  stages: [
    stage({
      key: 'collect', name: 'Collect', nameAr: 'جمع الأدلة والبيانات', unit: SUBJECT, owner: HEAD, start: 0, days: 30,
      process: 'Gather the evidence and the data for the period: enrolment, results, surveys and the documents the report will cite. Read last year\'s final report first, so that what was promised can be followed up.',
      checklist: ['Read last year\'s final report', 'Attach the evidence for the period', 'Attach the data for the period', 'Note what is missing and why'],
      outputs: [out('collection_summary', 'Collection summary', 'ملخص ما تم جمعه', 'note')],
      inputs: [
        inp('last_final', 'Last year\'s final report', 'التقرير النهائي للعام الماضي', previous('final', 'final_report'), false),
        inp('evidence', 'Evidence for the period', 'أدلة الفترة', pick('evidence')),
        inp('data', 'Data for the period', 'بيانات الفترة', pick('document')),
      ],
    }),
    stage({
      key: 'self_evaluation', name: 'Self-evaluation', nameAr: 'التقييم الذاتي', unit: SUBJECT, owner: HEAD, start: 30, days: 30,
      process: 'Write the self-evaluation from what was collected: what the program did, what the evidence shows, strengths, weaknesses and the actions planned.',
      checklist: ['Describe the year', 'Cite the evidence', 'List strengths and areas to improve', 'List the actions planned'],
      outputs: [out('self_evaluation_report', 'Self-evaluation report', 'تقرير التقييم الذاتي', 'report', { reportTemplateKey: 'annual_program_report' })],
      inputs: [inp('summary', 'Collection summary', 'ملخص ما تم جمعه', fromStage('collect', 'collection_summary'))],
    }),
    stage({
      key: 'unit_review', name: 'Review by the head of the unit', nameAr: 'مراجعة رئيس الوحدة', unit: SUBJECT, owner: HEAD, start: 60, days: 10,
      process: 'The head of the unit reads the self-evaluation and either approves it internally, approves it with conditions or returns it for changes.',
      outputs: [out('unit_signoff', 'Head of the unit sign-off', 'اعتماد رئيس الوحدة', 'approval', { approver: HEAD })],
      inputs: [inp('report', 'Self-evaluation report', 'تقرير التقييم الذاتي', fromStage('self_evaluation', 'self_evaluation_report'))],
    }),
    stage({
      key: 'qa_review', name: 'QA review', nameAr: 'مراجعة ضمان الجودة', owner: LEAD_ROLE, start: 70, days: 14,
      process: 'Quality assurance checks that the report is complete, that its claims point to evidence and that the planned actions are specific, then approves it internally or returns it.',
      checklist: ['Check completeness', 'Check that claims cite evidence', 'Check the planned actions'],
      outputs: [out('qa_signoff', 'QA sign-off', 'اعتماد ضمان الجودة', 'approval', { approver: LEAD_ROLE })],
      inputs: [
        inp('report', 'Self-evaluation report', 'تقرير التقييم الذاتي', fromStage('self_evaluation', 'self_evaluation_report')),
        inp('unit_signoff', 'Head of the unit sign-off', 'اعتماد رئيس الوحدة', fromStage('unit_review', 'unit_signoff')),
      ],
    }),
    stage({
      key: 'final', name: 'Final report', nameAr: 'التقرير النهائي', owner: HEAD, unit: SUBJECT, start: 84, days: 14,
      process: 'Issue the final report with the reviewers\' changes made, and keep a copy of the published pack. Next year\'s cycle starts from it.',
      outputs: [
        out('final_report', 'Final report', 'التقرير النهائي', 'report', { reportTemplateKey: 'annual_program_report' }),
        out('final_pack', 'Report pack (signed copy)', 'حزمة التقرير (نسخة موقعة)', 'document', { required: false }),
      ],
      inputs: [
        inp('report', 'Self-evaluation report', 'تقرير التقييم الذاتي', fromStage('self_evaluation', 'self_evaluation_report')),
        inp('qa_signoff', 'QA sign-off', 'اعتماد ضمان الجودة', fromStage('qa_review', 'qa_signoff')),
      ],
    }),
  ],
};

/** Periodic program review (every few years): prepare, self-study, external review, response, committee, final review report. */
const PERIODIC_PROGRAM_REVIEW: CreateCycleTemplate = {
  key: 'periodic_program_review', name: 'Periodic program review', nameAr: 'المراجعة الدورية للبرنامج', origin: 'default',
  description: 'The full review of a program every few years: prepare the evidence, write the self-study, receive the reviewers\' report, respond to it, have a committee approve the outcome and issue the review report.',
  anchorKinds: ['program'],
  stages: [
    stage({
      key: 'prepare', name: 'Prepare', nameAr: 'التحضير', unit: SUBJECT, owner: HEAD, start: 0, days: 60,
      process: 'Set up the review: confirm the scope and the period, gather the program\'s evidence and data, and read the previous review\'s report and its action plan.',
      checklist: ['Confirm the scope and the period', 'Read the previous review report', 'Attach the evidence', 'Attach the data'],
      outputs: [out('review_scope', 'Scope and period of the review', 'نطاق المراجعة وفترتها', 'note')],
      inputs: [
        inp('last_review', 'Previous review report', 'تقرير المراجعة السابقة', previous('final', 'review_report'), false),
        inp('evidence', 'Evidence', 'الأدلة', pick('evidence')),
        inp('data', 'Data', 'البيانات', pick('document')),
      ],
    }),
    stage({
      key: 'self_study', name: 'Self-study', nameAr: 'الدراسة الذاتية', unit: SUBJECT, owner: HEAD, start: 60, days: 90,
      process: 'Write the self-study: the program\'s aims, curriculum, students, staff, resources and results, with the evidence behind each statement.',
      outputs: [out('self_study_report', 'Self-study report', 'تقرير الدراسة الذاتية', 'report', { reportTemplateKey: 'program_self_study' })],
      inputs: [inp('scope', 'Scope and period of the review', 'نطاق المراجعة وفترتها', fromStage('prepare', 'review_scope'))],
    }),
    stage({
      key: 'external_review', name: 'Independent review', nameAr: 'المراجعة المستقلة', owner: LEAD_ROLE, start: 150, days: 45,
      process: 'Reviewers from outside the program read the self-study and report back. Upload their report when it arrives.',
      outputs: [out('reviewers_report', 'Reviewers\' report', 'تقرير المراجعين', 'document')],
      inputs: [inp('self_study', 'Self-study report', 'تقرير الدراسة الذاتية', fromStage('self_study', 'self_study_report'))],
    }),
    stage({
      key: 'response', name: 'Response and action plan', nameAr: 'الرد وخطة العمل', unit: SUBJECT, owner: HEAD, start: 195, days: 30,
      process: 'Answer each point of the reviewers\' report and agree an action plan with owners and dates.',
      outputs: [out('action_plan', 'Action plan', 'خطة العمل', 'report', { reportTemplateKey: 'action_plan' })],
      inputs: [
        inp('reviewers_report', 'Reviewers\' report', 'تقرير المراجعين', fromStage('external_review', 'reviewers_report')),
        inp('self_study', 'Self-study report', 'تقرير الدراسة الذاتية', fromStage('self_study', 'self_study_report')),
      ],
    }),
    stage({
      key: 'committee', name: 'Committee approval', nameAr: 'اعتماد اللجنة', owner: LEAD_ROLE, start: 225, days: 21,
      process: 'The review committee considers the self-study, the reviewers\' report and the action plan and records its decision.',
      outputs: [out('committee_signoff', 'Committee sign-off', 'اعتماد اللجنة', 'approval', { approver: LEAD_ROLE })],
      inputs: [
        inp('action_plan', 'Action plan', 'خطة العمل', fromStage('response', 'action_plan')),
        inp('reviewers_report', 'Reviewers\' report', 'تقرير المراجعين', fromStage('external_review', 'reviewers_report')),
      ],
    }),
    stage({
      key: 'final', name: 'Final review report', nameAr: 'تقرير المراجعة النهائي', owner: LEAD_ROLE, start: 246, days: 21,
      process: 'Issue the final review report with the committee\'s decision and the agreed action plan. The next review starts from it.',
      outputs: [out('review_report', 'Review report', 'تقرير المراجعة', 'report', { reportTemplateKey: 'program_review' })],
      inputs: [
        inp('signoff', 'Committee sign-off', 'اعتماد اللجنة', fromStage('committee', 'committee_signoff')),
        inp('action_plan', 'Action plan', 'خطة العمل', fromStage('response', 'action_plan')),
      ],
    }),
  ],
};

/** Administrative unit review: collect, self-assessment, review by the unit above, QA review, final report. */
const ADMIN_UNIT_REVIEW: CreateCycleTemplate = {
  key: 'admin_unit_review', name: 'Administrative unit review', nameAr: 'مراجعة الوحدة الإدارية', origin: 'default',
  description: 'The review of an administrative or support unit: gather what the unit did and how it is measured, assess itself, have the unit above and quality assurance review it, and issue the report.',
  anchorKinds: ['org_unit'],
  stages: [
    stage({
      key: 'collect', name: 'Collect', nameAr: 'جمع الأدلة والبيانات', unit: SUBJECT, owner: HEAD, start: 0, days: 30,
      process: 'Gather the unit\'s plan, the services it gives, the measures it keeps and the evidence of what was done in the period.',
      checklist: ['Attach the unit\'s plan', 'Attach the evidence of services given', 'Attach the measures for the period'],
      outputs: [out('collection_summary', 'Collection summary', 'ملخص ما تم جمعه', 'note')],
      inputs: [
        inp('last_final', 'Previous review report', 'تقرير المراجعة السابقة', previous('final', 'final_report'), false),
        inp('evidence', 'Evidence', 'الأدلة', pick('evidence')),
      ],
    }),
    stage({
      key: 'self_assessment', name: 'Self-assessment', nameAr: 'التقييم الذاتي', unit: SUBJECT, owner: HEAD, start: 30, days: 30,
      process: 'The unit assesses its own work against its plan and its measures: what went well, what did not, and what it will change.',
      outputs: [out('self_assessment_report', 'Self-assessment report', 'تقرير التقييم الذاتي', 'report', { reportTemplateKey: 'unit_self_assessment' })],
      inputs: [inp('summary', 'Collection summary', 'ملخص ما تم جمعه', fromStage('collect', 'collection_summary'))],
    }),
    stage({
      key: 'parent_review', name: 'Review by the unit above', nameAr: 'مراجعة الوحدة الأعلى', unit: PARENT, owner: HEAD, start: 60, days: 14,
      process: 'The head of the unit above reads the self-assessment and approves it internally, approves it with conditions or returns it.',
      outputs: [out('parent_signoff', 'Sign-off of the unit above', 'اعتماد الوحدة الأعلى', 'approval', { approver: HEAD })],
      inputs: [inp('report', 'Self-assessment report', 'تقرير التقييم الذاتي', fromStage('self_assessment', 'self_assessment_report'))],
    }),
    stage({
      key: 'qa_review', name: 'QA review', nameAr: 'مراجعة ضمان الجودة', owner: LEAD_ROLE, start: 74, days: 14,
      process: 'Quality assurance checks the report and the unit\'s actions, then approves it internally or returns it.',
      outputs: [out('qa_signoff', 'QA sign-off', 'اعتماد ضمان الجودة', 'approval', { approver: LEAD_ROLE })],
      inputs: [
        inp('report', 'Self-assessment report', 'تقرير التقييم الذاتي', fromStage('self_assessment', 'self_assessment_report')),
        inp('parent_signoff', 'Sign-off of the unit above', 'اعتماد الوحدة الأعلى', fromStage('parent_review', 'parent_signoff')),
      ],
    }),
    stage({
      key: 'final', name: 'Final report', nameAr: 'التقرير النهائي', unit: SUBJECT, owner: HEAD, start: 88, days: 14,
      process: 'Issue the final report with the reviewers\' changes made and the unit\'s action plan.',
      outputs: [out('final_report', 'Final report', 'التقرير النهائي', 'report', { reportTemplateKey: 'unit_review' })],
      inputs: [
        inp('report', 'Self-assessment report', 'تقرير التقييم الذاتي', fromStage('self_assessment', 'self_assessment_report')),
        inp('qa_signoff', 'QA sign-off', 'اعتماد ضمان الجودة', fromStage('qa_review', 'qa_signoff')),
      ],
    }),
  ],
};

/** Internal audit: plan, fieldwork, draft report, response of the audited unit, sign-off, follow-up. */
const INTERNAL_AUDIT: CreateCycleTemplate = {
  key: 'internal_audit', name: 'Internal audit', nameAr: 'التدقيق الداخلي', origin: 'default',
  description: 'An internal audit of a unit, a program or a process: plan it, carry out the fieldwork, write the draft report, take the audited unit\'s response, sign it off and follow up the corrective actions.',
  anchorKinds: [],
  stages: [
    stage({
      key: 'plan', name: 'Plan', nameAr: 'التخطيط', owner: LEAD_ROLE, start: 0, days: 14,
      process: 'Define what is audited, against what, by whom and when, and tell the audited unit.',
      checklist: ['Define the scope and criteria', 'Name the auditors', 'Tell the audited unit'],
      outputs: [out('audit_plan', 'Audit plan', 'خطة التدقيق', 'document')],
      inputs: [inp('last_report', 'Previous audit report', 'تقرير التدقيق السابق', previous('draft_report', 'audit_report'), false)],
    }),
    stage({
      key: 'fieldwork', name: 'Fieldwork', nameAr: 'العمل الميداني', owner: LEAD_ROLE, start: 14, days: 21,
      process: 'Examine the evidence, interview the people concerned and record the findings: what was found, against which criterion, and the proof.',
      outputs: [out('findings', 'Findings', 'النتائج', 'note')],
      inputs: [
        inp('plan', 'Audit plan', 'خطة التدقيق', fromStage('plan', 'audit_plan')),
        inp('evidence', 'Evidence examined', 'الأدلة التي تم فحصها', pick('evidence'), false),
      ],
    }),
    stage({
      key: 'draft_report', name: 'Draft report', nameAr: 'مسودة التقرير', owner: LEAD_ROLE, start: 35, days: 14,
      process: 'Write the audit report from the findings, with a recommendation for each.',
      outputs: [out('audit_report', 'Audit report', 'تقرير التدقيق', 'report', { reportTemplateKey: 'audit_report' })],
      inputs: [inp('findings', 'Findings', 'النتائج', fromStage('fieldwork', 'findings'))],
    }),
    stage({
      key: 'response', name: 'Response of the audited unit', nameAr: 'رد الوحدة المدققة', unit: SUBJECT, owner: HEAD, start: 49, days: 14,
      process: 'The audited unit answers each finding and proposes corrective actions with owners and dates.',
      outputs: [out('corrective_actions', 'Corrective actions', 'الإجراءات التصحيحية', 'note')],
      inputs: [inp('report', 'Audit report', 'تقرير التدقيق', fromStage('draft_report', 'audit_report'))],
    }),
    stage({
      key: 'signoff', name: 'Closing sign-off', nameAr: 'الاعتماد الختامي', owner: LEAD_ROLE, start: 63, days: 7,
      process: 'The audit lead records the outcome after reading the report and the response.',
      outputs: [out('closing_signoff', 'Closing sign-off', 'الاعتماد الختامي', 'approval', { approver: LEAD_ROLE })],
      inputs: [
        inp('report', 'Audit report', 'تقرير التدقيق', fromStage('draft_report', 'audit_report')),
        inp('actions', 'Corrective actions', 'الإجراءات التصحيحية', fromStage('response', 'corrective_actions')),
      ],
    }),
    stage({
      key: 'follow_up', name: 'Follow-up', nameAr: 'المتابعة', owner: LEAD_ROLE, start: 120, days: 30,
      process: 'Check that the corrective actions were carried out and note what remains open.',
      outputs: [out('follow_up_note', 'Follow-up note', 'ملاحظة المتابعة', 'note')],
      inputs: [inp('actions', 'Corrective actions', 'الإجراءات التصحيحية', fromStage('response', 'corrective_actions'))],
    }),
  ],
};

/** Course assessment, every semester: collect course results, analyse, report, close the loop. */
const COURSE_ASSESSMENT: CreateCycleTemplate = {
  key: 'course_assessment', name: 'Course assessment (every semester)', nameAr: 'تقييم المقررات (كل فصل دراسي)', origin: 'default',
  description: 'The assessment of the courses of a program each semester: collect the course results, analyse them, report, and close the loop by acting on what was found.',
  anchorKinds: ['program', 'framework_version', 'requirement', 'evidence_item'],
  stages: [
    stage({
      key: 'collect', name: 'Collect course results', nameAr: 'جمع نتائج المقررات', unit: SUBJECT, owner: HEAD, start: 0, days: 21,
      process: 'Collect the results of the semester\'s courses: grade distributions, the assessment of each learning outcome and the student feedback.',
      checklist: ['Grade distributions', 'Assessment of each learning outcome', 'Student feedback'],
      outputs: [out('results_summary', 'Course results', 'نتائج المقررات', 'note')],
      inputs: [
        inp('last_report', 'Last semester\'s report', 'تقرير الفصل السابق', previous('report', 'assessment_report'), false),
        inp('data', 'Course data', 'بيانات المقررات', pick('any')),
      ],
    }),
    stage({
      key: 'analyse', name: 'Analyse', nameAr: 'التحليل', unit: SUBJECT, owner: HEAD, start: 21, days: 14,
      process: 'Analyse the results: where students did well, where they did not and why, and how this compares with last semester.',
      outputs: [out('analysis', 'Analysis', 'التحليل', 'note')],
      inputs: [inp('results', 'Course results', 'نتائج المقررات', fromStage('collect', 'results_summary'))],
    }),
    stage({
      key: 'report', name: 'Report', nameAr: 'التقرير', unit: SUBJECT, owner: HEAD, start: 35, days: 14,
      process: 'Write the assessment report with the analysis and the improvements proposed.',
      outputs: [out('assessment_report', 'Assessment report', 'تقرير التقييم', 'report', { reportTemplateKey: 'course_assessment' })],
      inputs: [inp('analysis', 'Analysis', 'التحليل', fromStage('analyse', 'analysis'))],
    }),
    stage({
      key: 'close_loop', name: 'Close the loop', nameAr: 'إغلاق الحلقة', unit: SUBJECT, owner: HEAD, start: 49, days: 14,
      process: 'Agree what will change next semester because of the report, and record who does it. The head of the unit approves the plan internally.',
      outputs: [
        out('improvements', 'Improvements for next semester', 'التحسينات للفصل القادم', 'note'),
        out('loop_signoff', 'Head of the unit sign-off', 'اعتماد رئيس الوحدة', 'approval', { approver: HEAD_ABOVE }),
      ],
      inputs: [inp('report', 'Assessment report', 'تقرير التقييم', fromStage('report', 'assessment_report'))],
    }),
  ],
};

/** A blank starting point: one stage with one note, to be shaped by the institution. */
const CUSTOM: CreateCycleTemplate = {
  key: 'custom', name: 'Custom (blank)', nameAr: 'مخصص (فارغ)', origin: 'default',
  description: 'A blank template with one stage. Revise it to add the stages, owners, inputs and outputs of your own process, or duplicate it first to keep the blank one.',
  anchorKinds: [],
  stages: [
    stage({ key: 'work', name: 'Work', nameAr: 'العمل', start: 0, days: 30, process: 'Describe what is done in this stage.', outputs: [out('result', 'Result', 'النتيجة', 'note')] }),
  ],
};

/** The shipped templates, in the order they are listed. */
export const DEFAULT_CYCLE_TEMPLATES: readonly CreateCycleTemplate[] = [EVIDENCE_COLLECTION, ANNUAL_PROGRAM_REPORT, PERIODIC_PROGRAM_REVIEW, ADMIN_UNIT_REVIEW, INTERNAL_AUDIT, COURSE_ASSESSMENT, CUSTOM];
export const DEFAULT_CYCLE_TEMPLATE_KEYS: readonly string[] = DEFAULT_CYCLE_TEMPLATES.map((t) => t.key);
