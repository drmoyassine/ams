// The starter glossary and the structural rules that propose how a standard's terms map onto it. Nothing here looks at
// which accreditor a standard belongs to (DEC-002): a term is classified by where its requirements sit in the tree.
import type { CreateTerm } from '@ams/shared';

export const DEFAULT_TERMS: (CreateTerm & { key: string })[] = [
  { key: 'requirement_group', kind: 'level', labelEn: 'Requirement group', definitionEn: 'A heading level that holds other requirements: a standard, criterion, measure or heading.' },
  { key: 'requirement', kind: 'level', labelEn: 'Requirement', definitionEn: 'A single thing to be addressed and evidenced: a CFR, indicator or item.' },
  { key: 'required_action', kind: 'finding', labelEn: 'Required action', definitionEn: 'A finding the institution must act on and answer: a deficiency, weakness, concern, recommendation or condition.' },
  { key: 'observation', kind: 'finding', labelEn: 'Observation', definitionEn: 'A finding that needs no action: a commendation or an observation.' },
  { key: 'self_study_report', kind: 'report', labelEn: 'Self-study report', definitionEn: 'The main report that describes the institution or program against the standard.' },
  { key: 'follow_up_report', kind: 'report', labelEn: 'Follow-up report', definitionEn: 'A report owed after a decision: an interim report, progress report or the like.' },
  { key: 'annual_report', kind: 'report', labelEn: 'Annual report', definitionEn: 'A report filed every year during maintenance.' },
  { key: 'response_report', kind: 'report', labelEn: 'Response report', definitionEn: 'The institution\'s reply to something the accreditor sent.' },
  { key: 'evidence', kind: 'general', labelEn: 'Evidence', definitionEn: 'A document or data set that shows how a requirement is addressed.' },
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
