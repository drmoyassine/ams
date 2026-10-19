// The words of the Quality Management template screens for each value set (literal t() keys, so `pnpm i18n:extract` sees them).
// Internal approval is only ever worded "Internally approved" (DEC-005); nothing here says met, compliant or a score.
import type { CycleAnchorKind, CycleOutputKind, CyclePickKind, CycleTemplateStatus, PersonRule, Role, UnitRule } from '@ams/shared';
import type { Problem } from './editor-model';

export type T = (key: string, options?: Record<string, unknown>) => string;

export const statusLabels = (t: T): Record<CycleTemplateStatus, string> => ({ draft: t('qmt.status.draft'), published: t('qmt.status.published'), retired: t('qmt.status.retired') });

export const anchorLabels = (t: T): Record<CycleAnchorKind, string> => ({
  institution: t('qmt.anchor.institution'), org_unit: t('qmt.anchor.org_unit'), program: t('qmt.anchor.program'), framework_version: t('qmt.anchor.framework_version'),
  requirement: t('qmt.anchor.requirement'), evidence_item: t('qmt.anchor.evidence_item'), engagement: t('qmt.anchor.engagement'),
});

export const kindLabels = (t: T): Record<CycleOutputKind, string> => ({ report: t('qmt.kind.report'), document: t('qmt.kind.document'), approval: t('qmt.kind.approval'), note: t('qmt.kind.note') });
export const pickLabels = (t: T): Record<CyclePickKind, string> => ({ document: t('qmt.pick.document'), evidence: t('qmt.pick.evidence'), requirement: t('qmt.pick.requirement'), any: t('qmt.pick.any') });

export const roleLabels = (t: T): Record<Role, string> => ({
  admin: t('qmt.role.admin'), lead: t('qmt.role.lead'), engagement_lead: t('qmt.role.engagement_lead'), co_lead: t('qmt.role.co_lead'), contributor: t('qmt.role.contributor'),
  reviewer: t('qmt.role.reviewer'), viewer: t('qmt.role.viewer'), external_reviewer: t('qmt.role.external_reviewer'),
});

export const unitRuleLabels = (t: T): Record<UnitRule['kind'], string> => ({
  subject: t('qmt.unit.subject'), parent_of_subject: t('qmt.unit.parent'), unit_type: t('qmt.unit.type'), cycle: t('qmt.unit.cycle'),
});
export const personRuleLabels = (t: T): Record<PersonRule['kind'], string> => ({
  head_of_unit: t('qmt.owner.head'), head_of_parent_unit: t('qmt.owner.headAbove'), role: t('qmt.owner.role'), cycle_lead: t('qmt.owner.lead'),
});

/** A problem of the editor in the words of the screen (what is wrong and what to do). */
export function problemText(t: T, p: Problem): string {
  const v = p.params;
  switch (p.code) {
    case 'templateName': return t('qmt.err.templateName');
    case 'noStages': return t('qmt.err.noStages');
    case 'stageName': return t('qmt.err.stageName', v);
    case 'startDays': return t('qmt.err.startDays', v);
    case 'lengthDays': return t('qmt.err.lengthDays', v);
    case 'unitType': return t('qmt.err.unitType', v);
    case 'outputName': return t('qmt.err.outputName', v);
    case 'inputName': return t('qmt.err.inputName', v);
    case 'noApprover': return t('qmt.err.noApprover', v);
    case 'missingStage': return t('qmt.err.missingStage', v);
    case 'missingPreviousStage': return t('qmt.err.missingPreviousStage', v);
    case 'ownOutput': return t('qmt.err.ownOutput', v);
    case 'later': return t('qmt.err.later', v);
    case 'missingOutput': return t('qmt.err.missingOutput', v);
    case 'missingPreviousOutput': return t('qmt.err.missingPreviousOutput', v);
    case 'loop': return t('qmt.err.loop', v);
    case 'dupKey': return t('qmt.err.dupKey', v);
    default: return t('qmt.err.other', v);
  }
}
