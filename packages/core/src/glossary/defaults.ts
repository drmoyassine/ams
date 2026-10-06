// The starter glossary and the structural rules that propose how a standard's terms map onto it. Nothing here looks at
// which accreditor a standard belongs to (DEC-002): a term is classified by where its requirements sit in the tree.
import type { CreateTerm } from '@ams/shared';

/**
 * Level terms are not starter terms: they are the level names of the institution's quality framework, kept in step with
 * it (see `syncLevelTerms`). Level N of the framework is the term `level_N`.
 */
export const LEVEL_KEY = /^level_(\d+)$/;
export const levelKey = (position: number) => `level_${position}`;

export const DEFAULT_TERMS: (CreateTerm & { key: string })[] = [
  // The building blocks of the quality management system (fixed; the institution renames and defines them).
  { key: 'policy', kind: 'block', labelEn: 'Policy', definitionEn: 'A statement of intent approved by leadership that sets direction for an area of work.' },
  { key: 'objective', kind: 'block', labelEn: 'Objective', definitionEn: 'A result to achieve, set to carry out a policy or answer a risk or opportunity.' },
  { key: 'risk', kind: 'block', labelEn: 'Risk', definitionEn: 'Something uncertain that could stop an objective being achieved.' },
  { key: 'opportunity', kind: 'block', labelEn: 'Opportunity', definitionEn: 'Something that could help achieve an objective or improve beyond it.' },
  { key: 'measure', kind: 'block', labelEn: 'Measure / KPI', definitionEn: 'How progress on an objective is measured, with a target and a frequency.' },
  { key: 'procedure', kind: 'block', labelEn: 'Procedure', definitionEn: 'The agreed way a piece of work is carried out.' },
  { key: 'evidence', kind: 'block', labelEn: 'Evidence', definitionEn: 'A document or data set that shows how a requirement is addressed.' },
  { key: 'internal_review', kind: 'block', labelEn: 'Internal review', definitionEn: 'A planned check, such as an internal audit or a program review, of whether things work as intended.' },
  { key: 'management_review', kind: 'block', labelEn: 'Management review', definitionEn: 'Leadership\'s periodic review of the whole system and its results.' },
  { key: 'corrective_action', kind: 'block', labelEn: 'Corrective action', definitionEn: 'An action that removes the cause of a gap so that it does not happen again.' },
  { key: 'owner', kind: 'attribute', labelEn: 'Owner', definitionEn: 'The person, role or unit accountable for an item.' },
  { key: 'scope', kind: 'attribute', labelEn: 'Scope', definitionEn: 'The programs and units an item applies to.' },
  { key: 'required_action', kind: 'finding', labelEn: 'Required action', definitionEn: 'A finding the institution must act on and answer: a deficiency, weakness, concern, recommendation or condition.' },
  { key: 'observation', kind: 'finding', labelEn: 'Observation', definitionEn: 'A finding that needs no action: a commendation or an observation.' },
  { key: 'self_study_report', kind: 'report', labelEn: 'Self-study report', definitionEn: 'The main report that describes the institution or program against the standard.' },
  { key: 'follow_up_report', kind: 'report', labelEn: 'Follow-up report', definitionEn: 'A report owed after a decision: an interim report, progress report or the like.' },
  { key: 'annual_report', kind: 'report', labelEn: 'Annual report', definitionEn: 'A report filed every year during maintenance.' },
  { key: 'response_report', kind: 'report', labelEn: 'Response report', definitionEn: 'The institution\'s reply to something the accreditor sent.' },
  { key: 'engagement', kind: 'general', labelEn: 'Engagement', definitionEn: 'One accreditation cycle for an institution or a program, from eligibility to maintenance.' },
];

export interface LevelStats {
  label: string;
  /** Every requirement carrying this label sits at the top of the tree. */
  allTopLevel: boolean;
  /** None of them is assessable (a heading). */
  noneAssessable: boolean;
  /** Every one of them has requirements beneath it. */
  allHaveChildren: boolean;
}

/** A level label is a group when it only ever sits at the top, only ever labels headings, or always has requirements below it; otherwise it labels requirements. */
export const classifyLevel = (s: LevelStats): 'requirement_group' | 'requirement' =>
  s.allTopLevel || s.noneAssessable || s.allHaveChildren ? 'requirement_group' : 'requirement';

export const findingTermKey = (requiresAction: boolean) => (requiresAction ? 'required_action' : 'observation');

/** Report templates map by their kind. Kinds with no stable internal term (application, readiness, other) stay unmapped. */
export const REPORT_TERM_BY_KIND: Record<string, string> = {
  self_study: 'self_study_report', follow_up: 'follow_up_report', annual: 'annual_report', response: 'response_report',
};
