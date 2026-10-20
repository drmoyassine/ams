// Quality Management cycles (DEC-029, TASK-078, docs/quality-management-plan.md): the shapes the API, the SPA and the
// services share. A cycle is ordered stages; a stage is inputs -> process -> outputs; every cycle and stage has a
// responsible unit and an owner. Templates (data, never code: DEC-002) say how to resolve both when a cycle is launched.
// Internal approval is only ever worded "Internally approved" (DEC-005): nothing here says met, compliant or a score.
import { z } from 'zod';
import { ROLES } from './permissions.js';

// ---- Value sets ----------------------------------------------------------------------------------------------------------

/** What a cycle is about (the anchor). The id is polymorphic and checked by the service. */
export const CYCLE_ANCHOR_KINDS = ['institution', 'org_unit', 'program', 'framework_version', 'requirement', 'evidence_item', 'engagement'] as const;
export type CycleAnchorKind = (typeof CYCLE_ANCHOR_KINDS)[number];
/** Who does the work, when it is not the anchor itself. */
export const CYCLE_SUBJECT_KINDS = ['institution', 'org_unit', 'program'] as const;
export type CycleSubjectKind = (typeof CYCLE_SUBJECT_KINDS)[number];
export const CYCLE_STATUSES = ['draft', 'active', 'completed', 'cancelled'] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];
/** The "due" filter of the cycle list. */
export const CYCLE_DUE_FILTERS = ['late', 'soon'] as const;
export type CycleDueFilter = (typeof CYCLE_DUE_FILTERS)[number];
/** How many days ahead "due soon" looks. */
export const CYCLE_DUE_SOON_DAYS = 14;
export const CYCLE_ORIGINS = ['manual', 'assistant'] as const;
export const CYCLE_STAGE_STATUSES = ['not_started', 'in_progress', 'completed', 'skipped'] as const;
export type CycleStageStatus = (typeof CYCLE_STAGE_STATUSES)[number];
export const CYCLE_OUTPUT_KINDS = ['report', 'document', 'approval', 'note'] as const;
export type CycleOutputKind = (typeof CYCLE_OUTPUT_KINDS)[number];
export const CYCLE_OUTPUT_STATES = ['missing', 'draft', 'final'] as const;
export type CycleOutputState = (typeof CYCLE_OUTPUT_STATES)[number];
export const CYCLE_DECISIONS = ['approved', 'approved_with_conditions', 'returned'] as const;
export type CycleDecision = (typeof CYCLE_DECISIONS)[number];
/** The words for a decision. Internal sign-off only: never "met" or "compliant" (DEC-005). */
export const CYCLE_DECISION_LABELS: Record<CycleDecision, string> = {
  approved: 'Internally approved', approved_with_conditions: 'Internally approved with conditions', returned: 'Returned for changes',
};
export const CYCLE_INPUT_SOURCES = ['stage_output', 'previous_cycle', 'pick'] as const;
export type CycleInputSource = (typeof CYCLE_INPUT_SOURCES)[number];
/** What a `pick` input may be filled with (the template's wish). */
export const CYCLE_PICK_KINDS = ['document', 'evidence', 'requirement', 'any'] as const;
export type CyclePickKind = (typeof CYCLE_PICK_KINDS)[number];
/** What a picked input points at once filled. */
export const CYCLE_REF_KINDS = ['document', 'evidence_item', 'requirement'] as const;
export type CycleRefKind = (typeof CYCLE_REF_KINDS)[number];
export const CYCLE_TEMPLATE_STATUSES = ['draft', 'published', 'retired'] as const;
export type CycleTemplateStatus = (typeof CYCLE_TEMPLATE_STATUSES)[number];
export const CYCLE_TEMPLATE_ORIGINS = ['default', 'manual', 'import'] as const;

const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, 'lower-case letters, digits and _ (starting with a letter)');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');
const text = z.string().trim();

// ---- The template's stage definitions (cycle_template.stages) ---------------------------------------------------------

/** The responsible unit of a stage, resolved against the org chart when the cycle is launched. */
export const UnitRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('subject') }).strict(),
  z.object({ kind: z.literal('parent_of_subject') }).strict(),
  z.object({ kind: z.literal('unit_type'), type: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('cycle') }).strict(),
]);
export type UnitRule = z.infer<typeof UnitRuleSchema>;

/** The person (owner of a stage, or approver of an output), resolved within the stage's unit. */
export const PersonRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('head_of_unit') }).strict(),
  z.object({ kind: z.literal('head_of_parent_unit') }).strict(),
  z.object({ kind: z.literal('role'), role: z.enum(ROLES) }).strict(),
  z.object({ kind: z.literal('cycle_lead') }).strict(),
]);
export type PersonRule = z.infer<typeof PersonRuleSchema>;

export const OutputDefSchema = z.object({
  key, name: text.min(1).max(200), nameAr: text.min(1).max(200).optional(),
  kind: z.enum(CYCLE_OUTPUT_KINDS),
  required: z.boolean().default(true),
  /** For `report`: the report template (shared report engine, TASK-085). */
  reportTemplateKey: z.string().min(1).optional(),
  /** For `approval`: who signs. */
  approver: PersonRuleSchema.optional(),
}).strict();
export type OutputDef = z.infer<typeof OutputDefSchema>;

export const InputFromSchema = z.union([
  z.object({ stage: key, output: key }).strict(),
  z.object({ previousCycle: z.object({ stage: key, output: key }).strict() }).strict(),
  z.object({ pick: z.enum(CYCLE_PICK_KINDS) }).strict(),
]);
export type InputFrom = z.infer<typeof InputFromSchema>;

export const InputDefSchema = z.object({
  key, name: text.min(1).max(200), nameAr: text.min(1).max(200).optional(),
  from: InputFromSchema,
  /** Shown as missing while not satisfied; never blocks (plan, parked Q3). */
  required: z.boolean().default(true),
}).strict();
export type InputDef = z.infer<typeof InputDefSchema>;

/** A stage that runs a child cycle (nesting, TASK-082). Stored now, used then. */
export const ChildCycleDefSchema = z.union([
  z.object({ templateKey: key, recurrence: z.object({ every: z.number().int().min(1), unit: z.enum(['term', 'month', 'year']) }).strict(), until: z.literal('stage_end') }).strict(),
  z.object({ templateKey: key, when: z.literal('output'), output: key }).strict(),
]);

export const StageDefSchema = z.object({
  key, name: text.min(1).max(200), nameAr: text.min(1).max(200).optional(),
  process: z.string().max(20000).default(''),
  checklist: z.array(text.min(1).max(500)).max(100).default([]),
  unit: UnitRuleSchema.default({ kind: 'cycle' }),
  owner: PersonRuleSchema.default({ kind: 'cycle_lead' }),
  startOffsetDays: z.number().int().min(0).max(36500).default(0),
  lengthDays: z.number().int().min(0).max(36500).default(0),
  outputs: z.array(OutputDefSchema).max(50).default([]),
  inputs: z.array(InputDefSchema).max(50).default([]),
  child: ChildCycleDefSchema.optional(),
}).strict();
export type StageDef = z.infer<typeof StageDefSchema>;
export const TemplateStagesSchema = z.array(StageDefSchema).max(100);

export interface TemplateIssue { path: string; message: string }

/**
 * Checks a template's stages beyond their shape: keys unique (stages; outputs and inputs within a stage); an approver only
 * on an approval and a report template only on a report; an input reads an output of an EARLIER stage of the same cycle
 * (a stage that reads a later one, or a loop of stages reading each other, is refused); `previousCycle` names a stage and
 * output of this same template. Returns every problem, in stage order.
 */
export function validateTemplateStages(stages: StageDef[]): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const at = new Map<string, number>();
  stages.forEach((s, i) => {
    if (at.has(s.key)) issues.push({ path: `stages.${i}.key`, message: `stage key "${s.key}" is used twice` });
    else at.set(s.key, i);
  });
  const outputsOf = (stageKey: string) => new Set(stages[at.get(stageKey) ?? -1]?.outputs.map((o) => o.key) ?? []);
  // Edges: stage index -> stage indexes it reads (from this cycle), for the loop check.
  const reads = new Map<number, Set<number>>();
  stages.forEach((s, i) => {
    const outKeys = new Set<string>();
    s.outputs.forEach((o, j) => {
      if (outKeys.has(o.key)) issues.push({ path: `stages.${i}.outputs.${j}.key`, message: `output key "${o.key}" is used twice in stage "${s.key}"` });
      outKeys.add(o.key);
      if (o.kind !== 'approval' && o.approver) issues.push({ path: `stages.${i}.outputs.${j}.approver`, message: 'only an approval has an approver' });
      if (o.kind !== 'report' && o.reportTemplateKey) issues.push({ path: `stages.${i}.outputs.${j}.reportTemplateKey`, message: 'only a report has a report template' });
    });
    const inKeys = new Set<string>();
    s.inputs.forEach((inp, j) => {
      const p = `stages.${i}.inputs.${j}`;
      if (inKeys.has(inp.key)) issues.push({ path: `${p}.key`, message: `input key "${inp.key}" is used twice in stage "${s.key}"` });
      inKeys.add(inp.key);
      if ('stage' in inp.from) {
        const to = at.get(inp.from.stage);
        if (to === undefined) { issues.push({ path: `${p}.from.stage`, message: `there is no stage "${inp.from.stage}"` }); return; }
        if (!outputsOf(inp.from.stage).has(inp.from.output)) { issues.push({ path: `${p}.from.output`, message: `stage "${inp.from.stage}" has no output "${inp.from.output}"` }); return; }
        reads.set(i, (reads.get(i) ?? new Set()).add(to));
        if (to === i) issues.push({ path: `${p}.from.stage`, message: `a stage cannot read its own output ("${inp.from.stage}")` });
      } else if ('previousCycle' in inp.from) {
        const pc = inp.from.previousCycle;
        if (!at.has(pc.stage)) issues.push({ path: `${p}.from.previousCycle.stage`, message: `there is no stage "${pc.stage}" in this template` });
        else if (!outputsOf(pc.stage).has(pc.output)) issues.push({ path: `${p}.from.previousCycle.output`, message: `stage "${pc.stage}" has no output "${pc.output}"` });
      }
    });
  });
  // Loops among stages (A reads B, B reads A), then "reads a later stage" for the rest.
  const state = new Map<number, 1 | 2>();
  const stack: number[] = [];
  const found: { loop: number[] | null } = { loop: null };
  const visit = (n: number) => {
    if (found.loop) return;
    state.set(n, 1); stack.push(n);
    for (const m of reads.get(n) ?? []) {
      if (m === n) continue;
      if (state.get(m) === 1) { found.loop = [...stack.slice(stack.indexOf(m)), m]; return; }
      if (!state.has(m)) visit(m);
      if (found.loop) return;
    }
    stack.pop(); state.set(n, 2);
  };
  for (let n = 0; n < stages.length; n += 1) if (!state.has(n)) visit(n);
  if (found.loop) issues.push({ path: 'stages', message: `the inputs form a loop: ${found.loop.map((n) => stages[n]!.key).join(' -> ')}` });
  else {
    stages.forEach((s, i) => s.inputs.forEach((inp, j) => {
      if (!('stage' in inp.from)) return;
      const to = at.get(inp.from.stage);
      if (to !== undefined && to > i) issues.push({ path: `stages.${i}.inputs.${j}.from.stage`, message: `stage "${s.key}" reads "${inp.from.stage}", which comes later; put the stage that makes it first` });
    }));
  }
  return issues;
}

// ---- Templates -----------------------------------------------------------------------------------------------------------

export const CycleTemplateSchema = z.object({
  id: z.string(), key: z.string(), name: z.string(), nameAr: z.string().nullable(), description: z.string().nullable(),
  /** Which anchors it fits; empty = any. */
  anchorKinds: z.array(z.enum(CYCLE_ANCHOR_KINDS)),
  stages: z.array(StageDefSchema),
  /** 0 while it has never been published; +1 on each publish. A cycle keeps the version it was launched from. */
  version: z.number(), status: z.enum(CYCLE_TEMPLATE_STATUSES), origin: z.enum(CYCLE_TEMPLATE_ORIGINS),
  /** How many cycles were launched from it. */
  cycleCount: z.number(), updatedAt: z.string(),
});
export type CycleTemplate = z.infer<typeof CycleTemplateSchema>;

export const CreateCycleTemplateSchema = z.object({
  key, name: text.min(1).max(200), nameAr: text.min(1).max(200).optional(), description: text.min(1).max(4000).optional(),
  anchorKinds: z.array(z.enum(CYCLE_ANCHOR_KINDS)).default([]),
  stages: TemplateStagesSchema.default([]),
  origin: z.enum(CYCLE_TEMPLATE_ORIGINS).default('manual'),
}).strict();
export type CreateCycleTemplate = z.infer<typeof CreateCycleTemplateSchema>;
export const UpdateCycleTemplateSchema = z.object({
  name: text.min(1).max(200).optional(), nameAr: text.max(200).nullable().optional(), description: text.max(4000).nullable().optional(),
  anchorKinds: z.array(z.enum(CYCLE_ANCHOR_KINDS)).optional(), stages: TemplateStagesSchema.optional(),
}).strict();
export type UpdateCycleTemplate = z.infer<typeof UpdateCycleTemplateSchema>;
export const ValidateTemplateSchema = z.object({ stages: TemplateStagesSchema }).strict();
export const TemplateValidationSchema = z.object({ ok: z.boolean(), issues: z.array(z.object({ path: z.string(), message: z.string() })) });
export type TemplateValidation = z.infer<typeof TemplateValidationSchema>;
/** What installing the shipped default templates did: the keys written now, and the ones that were already there (left alone). */
export const InstallDefaultsResultSchema = z.object({ installed: z.array(z.string()), existing: z.array(z.string()) });
export type InstallDefaultsResult = z.infer<typeof InstallDefaultsResultSchema>;

// ---- Cycles --------------------------------------------------------------------------------------------------------------

const ChecklistItemSchema = z.object({ text: z.string(), done: z.boolean(), doneBy: z.string().nullable(), doneAt: z.string().nullable() });
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const CycleOutputSchema = z.object({
  id: z.string(), stageId: z.string(), key: z.string(), name: z.string(), kind: z.enum(CYCLE_OUTPUT_KINDS), required: z.boolean(),
  state: z.enum(CYCLE_OUTPUT_STATES),
  reportTemplateKey: z.string().nullable(), reportId: z.string().nullable(),
  /** A report output until the shared report engine exists (TASK-085): no report can be attached yet. */
  reportPending: z.boolean(),
  file: z.object({ name: z.string(), mime: z.string(), size: z.number() }).nullable(),
  note: z.string().nullable(),
  approverUserId: z.string().nullable(), approverName: z.string().nullable(), approverUnresolved: z.boolean(),
  decision: z.enum(CYCLE_DECISIONS).nullable(), decisionLabel: z.string().nullable(), decisionComment: z.string().nullable(),
  finalisedBy: z.string().nullable(), finalisedByName: z.string().nullable(), finalisedAt: z.string().nullable(),
  /** The caller may record the decision on this approval (only the named approver may). */
  canDecide: z.boolean(),
});
export type CycleOutput = z.infer<typeof CycleOutputSchema>;

export const CycleInputSchema = z.object({
  id: z.string(), stageId: z.string(), key: z.string(), name: z.string(), source: z.enum(CYCLE_INPUT_SOURCES), required: z.boolean(),
  outputId: z.string().nullable(), outputName: z.string().nullable(), outputState: z.enum(CYCLE_OUTPUT_STATES).nullable(),
  /** Where the output lives: the stage's name, and the cycle (this one, or the previous one). */
  outputStageName: z.string().nullable(), outputCycleId: z.string().nullable(),
  pickKind: z.enum(CYCLE_PICK_KINDS).nullable(), refKind: z.enum(CYCLE_REF_KINDS).nullable(), refId: z.string().nullable(), refName: z.string().nullable(),
  /** Satisfied: it points at a final output, or its pick has been filled. */
  satisfied: z.boolean(),
  /** A `previous_cycle` input with no previous run (or no such output in it). */
  previousMissing: z.boolean(),
});
export type CycleInput = z.infer<typeof CycleInputSchema>;

export const CycleStageSchema = z.object({
  id: z.string(), cycleId: z.string(), key: z.string(), name: z.string(), nameAr: z.string().nullable(), process: z.string(),
  checklist: z.array(ChecklistItemSchema), displayOrder: z.number(),
  responsibleUnitId: z.string(), responsibleUnitName: z.string().nullable(),
  /** The template's unit rule found no unit (so the stage takes the cycle's); choose one. */
  unitUnresolved: z.boolean(),
  ownerUserId: z.string().nullable(), ownerName: z.string().nullable(),
  /** The owner rule found nobody (or more than one); choose one. Never guessed. */
  ownerUnresolved: z.boolean(),
  startDate: z.string().nullable(), endDate: z.string().nullable(),
  status: z.enum(CYCLE_STAGE_STATUSES), skipReason: z.string().nullable(), startedAt: z.string().nullable(), completedAt: z.string().nullable(),
  outputs: z.array(CycleOutputSchema), inputs: z.array(CycleInputSchema),
  /** The caller may fill this stage's outputs (its owner, or cycle:work / cycle:manage for its unit). */
  canWork: z.boolean(),
  /** Past its end date and not finished (computed on the server's date). */
  late: z.boolean(),
});
export type CycleStage = z.infer<typeof CycleStageSchema>;

export const CycleSummarySchema = z.object({
  id: z.string(), title: z.string(), templateId: z.string().nullable(), templateName: z.string().nullable(), templateVersion: z.number().nullable(),
  anchorKind: z.enum(CYCLE_ANCHOR_KINDS), anchorId: z.string(), anchorName: z.string().nullable(),
  subjectKind: z.enum(CYCLE_SUBJECT_KINDS).nullable(), subjectId: z.string().nullable(), subjectName: z.string().nullable(),
  responsibleUnitId: z.string(), responsibleUnitName: z.string().nullable(),
  leadUserId: z.string(), leadName: z.string().nullable(),
  status: z.enum(CYCLE_STATUSES), cancelReason: z.string().nullable(),
  startDate: z.string(), endDate: z.string().nullable(), periodLabel: z.string().nullable(),
  previousCycleId: z.string().nullable(), parentCycleId: z.string().nullable(), parentStageId: z.string().nullable(),
  origin: z.enum(CYCLE_ORIGINS),
  planId: z.string().nullable(), periodStart: z.string().nullable(),
  stageCount: z.number(), stagesDone: z.number(),
  /** Stages whose owner (or unit) the template's rules could not resolve: they need choosing before the cycle starts. */
  unresolvedCount: z.number(),
  /** The first stage not yet done (a draft's first one too); null once every stage is done or the cycle is cancelled. */
  nextStage: z.object({
    id: z.string(), name: z.string(), status: z.enum(CYCLE_STAGE_STATUSES), ownerName: z.string().nullable(), ownerUnresolved: z.boolean(),
    endDate: z.string().nullable(), late: z.boolean(),
  }).nullable(),
  /** A running cycle with an open stage past its end date (on the server's date). */
  late: z.boolean(),
  /** A running cycle with an open stage that ends within the next 14 days. */
  dueSoon: z.boolean(),
  createdAt: z.string(),
});
export type CycleSummary = z.infer<typeof CycleSummarySchema>;

export const CycleDetailSchema = CycleSummarySchema.extend({
  stages: z.array(CycleStageSchema),
  /** The caller may manage this cycle (launch it, change owners and dates, cancel). */
  canManage: z.boolean(),
});
export type CycleDetail = z.infer<typeof CycleDetailSchema>;

export const LaunchCycleSchema = z.object({
  /** The published template to launch; null or absent = a blank cycle (stages added by hand while it is a draft). */
  templateId: z.uuid().nullable().default(null),
  anchorKind: z.enum(CYCLE_ANCHOR_KINDS), anchorId: z.uuid(),
  subjectKind: z.enum(CYCLE_SUBJECT_KINDS).nullable().default(null), subjectId: z.uuid().nullable().default(null),
  startDate: day,
  /** The cycle's owner; the caller when left out. */
  leadUserId: z.uuid().optional(),
  /** Default: the unit of the subject (or the anchor when it is a unit or program). Required when none can be found. */
  responsibleUnitId: z.uuid().optional(),
  title: text.min(1).max(300).optional(), periodLabel: text.min(1).max(80).optional(),
  /** Default: the subject's latest earlier run of the same template, found automatically. Null = none. */
  previousCycleId: z.uuid().nullable().optional(),
  origin: z.enum(CYCLE_ORIGINS).default('manual'),
  /** Set when launching a run a plan proposed (TASK-081): the plan, and the start of the period it covers. The previous run is then that plan's. */
  planId: z.uuid().optional(), periodStart: day.optional(),
}).strict().refine((v) => (v.subjectKind === null) === (v.subjectId === null), { message: 'give the subject kind and id together, or neither', path: ['subjectId'] });
export type LaunchCycle = z.infer<typeof LaunchCycleSchema>;

export const UpdateCycleSchema = z.object({
  title: text.min(1).max(300).optional(), leadUserId: z.uuid().optional(), responsibleUnitId: z.uuid().optional(),
  startDate: day.optional(), endDate: day.nullable().optional(), periodLabel: text.max(80).nullable().optional(),
}).strict();
export type UpdateCycle = z.infer<typeof UpdateCycleSchema>;
export const CancelCycleSchema = z.object({ reason: text.min(1).max(2000) }).strict();
export type CancelCycle = z.infer<typeof CancelCycleSchema>;

export const CycleFilterSchema = z.object({
  anchorKind: z.enum(CYCLE_ANCHOR_KINDS).optional(), anchorId: z.uuid().optional(),
  subjectKind: z.enum(CYCLE_SUBJECT_KINDS).optional(), subjectId: z.uuid().optional(),
  unitId: z.uuid().optional(), status: z.enum(CYCLE_STATUSES).optional(),
  /** A unit or program the cycle is about or run by: its anchor, its subject or its responsible unit. */
  aboutId: z.uuid().optional(),
  /** A person who leads the cycle or owns one of its stages. */
  ownerId: z.uuid().optional(), templateId: z.uuid().optional(), q: z.string().optional(),
  /** Running cycles with an open stage past its end date (`late`) or ending within the next 14 days (`soon`). */
  due: z.enum(CYCLE_DUE_FILTERS).optional(),
});
export type CycleFilter = z.infer<typeof CycleFilterSchema>;

// ---- Stages, outputs, inputs ---------------------------------------------------------------------------------------------

export const AddStageSchema = z.object({
  key: key.optional(), name: text.min(1).max(200), nameAr: text.min(1).max(200).optional(), process: z.string().max(20000).default(''),
  checklist: z.array(text.min(1).max(500)).max(100).default([]),
  responsibleUnitId: z.uuid().optional(), ownerUserId: z.uuid().nullable().optional(),
  startDate: day.nullable().optional(), endDate: day.nullable().optional(),
}).strict();
export type AddStage = z.input<typeof AddStageSchema>;
export const UpdateStageSchema = z.object({
  name: text.min(1).max(200).optional(), nameAr: text.max(200).nullable().optional(), process: z.string().max(20000).optional(),
  responsibleUnitId: z.uuid().optional(), ownerUserId: z.uuid().nullable().optional(),
  startDate: day.nullable().optional(), endDate: day.nullable().optional(),
}).strict();
export type UpdateStage = z.infer<typeof UpdateStageSchema>;
export const SkipStageSchema = z.object({ reason: text.min(1).max(2000) }).strict();
export const ChecklistToggleSchema = z.object({ index: z.number().int().min(0), done: z.boolean() }).strict();

export const AddOutputSchema = z.object({
  key: key.optional(), name: text.min(1).max(200), kind: z.enum(CYCLE_OUTPUT_KINDS), required: z.boolean().default(true),
  reportTemplateKey: z.string().min(1).optional(), approverUserId: z.uuid().optional(),
}).strict();
export type AddOutput = z.input<typeof AddOutputSchema>;
export const UpdateOutputSchema = z.object({ approverUserId: z.uuid().nullable().optional(), note: z.string().max(20000).nullable().optional() }).strict();
export type UpdateOutput = z.infer<typeof UpdateOutputSchema>;
export const SetNoteSchema = z.object({ note: z.string().max(20000) }).strict();
export const DecideSchema = z.object({ decision: z.enum(CYCLE_DECISIONS), comment: z.string().trim().max(4000).optional() }).strict();
export type Decide = z.infer<typeof DecideSchema>;

export const AddInputSchema = z.object({
  key: key.optional(), name: text.min(1).max(200), required: z.boolean().default(true),
  /** Exactly one of: an output of an earlier stage of this cycle, the previous run's output (by stage and output key), or a pick. */
  fromOutputId: z.uuid().optional(), previousCycle: z.object({ stage: key, output: key }).optional(), pick: z.enum(CYCLE_PICK_KINDS).optional(),
}).strict();
export type AddInput = z.input<typeof AddInputSchema>;
export const SetPickSchema = z.object({ refKind: z.enum(CYCLE_REF_KINDS).nullable(), refId: z.uuid().nullable() }).strict();
export type SetPick = z.infer<typeof SetPickSchema>;

// ---- My work -------------------------------------------------------------------------------------------------------------

export const MyWorkSchema = z.object({
  /** Stages I own that are not finished, with how far along and what is missing. */
  stages: z.array(z.object({
    cycleId: z.string(), cycleTitle: z.string(), cycleStatus: z.enum(CYCLE_STATUSES),
    stageId: z.string(), stageName: z.string(), status: z.enum(CYCLE_STAGE_STATUSES),
    startDate: z.string().nullable(), endDate: z.string().nullable(), late: z.boolean(),
    missingInputs: z.number(), missingOutputs: z.number(),
  })),
  /** Approvals that wait for my decision (the stage has started, the output is not decided). */
  approvals: z.array(z.object({
    cycleId: z.string(), cycleTitle: z.string(), stageId: z.string(), stageName: z.string(), outputId: z.string(), outputName: z.string(),
    returnedBefore: z.boolean(),
  })),
});
export type MyWork = z.infer<typeof MyWorkSchema>;
