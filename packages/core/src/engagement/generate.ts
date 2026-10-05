// Milestone generation from a framework's lifecycle template (PRD 7.4, 8.1). Pure: the same template, kind and dates
// always give the same milestones. Which accreditor the template came from is never consulted (DEC-002).
import type { LifecycleTemplate } from '@ams/shared';
import { resolveDueRule, type IsoDate, type KeyDates } from './dates.js';

type PhaseType = LifecycleTemplate['phases'][number]['type'];
type MilestoneType = LifecycleTemplate['phases'][number]['milestones'][number]['type'];

export interface GeneratedMilestone {
  templateKey: string;
  phase: PhaseType;
  name: string;
  description: string | null;
  type: MilestoneType;
  dueDate: IsoDate | null;
  dueRule: unknown;
  dateNeeded: boolean;
  deliverable: { report_template_key: string } | null;
  sourceRef: unknown;
  recurrence: unknown;
  displayOrder: number;
  /** Cannot be deleted: the self-study deliverable and every decision point (PRD 8.5). */
  locked: boolean;
  required: boolean;
}

export interface GenerateInput {
  lifecycle: LifecycleTemplate;
  kind: 'initial' | 'reaffirmation';
  reviewYear: number;
  keyDates: KeyDates;
  /** Kind of each report template by key, to find the self-study deliverable. */
  templateKinds: ReadonlyMap<string, string>;
}

/**
 * The phases that apply to `kind`, in template order, with their milestones. A phase type can appear more than once in
 * a template (one entry per kind); only the entries that apply are used, so a type appears once per engagement.
 */
export function generateMilestones(input: GenerateInput): GeneratedMilestone[] {
  const out: GeneratedMilestone[] = [];
  for (const phase of input.lifecycle.phases) {
    if (!phase.applies_to.includes(input.kind)) continue;
    let order = out.filter((m) => m.phase === phase.type).length;
    for (const m of phase.milestones) {
      if (m.applies_to && !m.applies_to.includes(input.kind)) continue;
      const { dueDate, dateNeeded } = resolveDueRule(m.due, { reviewYear: input.reviewYear, keyDates: input.keyDates });
      const isSelfStudy = m.deliverable ? input.templateKinds.get(m.deliverable.report_template_key) === 'self_study' : false;
      out.push({
        templateKey: m.key,
        phase: phase.type,
        name: m.name,
        description: m.description ?? null,
        type: m.type,
        dueDate,
        dueRule: m.due ?? null,
        dateNeeded,
        deliverable: m.deliverable ?? null,
        sourceRef: m.source_ref ?? null,
        recurrence: m.recurrence ?? null,
        displayOrder: order++,
        locked: isSelfStudy || m.type === 'decision_point',
        required: m.required,
      });
    }
  }
  return out;
}

/** The phase an engagement starts in: the first phase of its lifecycle that applies to its kind. */
export function firstPhase(lifecycle: LifecycleTemplate, kind: 'initial' | 'reaffirmation'): PhaseType | null {
  return lifecycle.phases.find((p) => p.applies_to.includes(kind))?.type ?? null;
}
