// Scope and champion of a standard (TASK-086, docs/quality-management-plan.md "Standards in operation"): the shapes the API, the
// SPA and the services share. A scope says where a requirement applies (a level and, optionally, a list of units or programs);
// a champion says who answers for it (overall, or per scoped item). Both are inherited down the tree and, for an external
// requirement, through its approved mappings to the institution's own framework; a person can override either, and "Back to
// inherited" removes the override. Nothing here says met, compliant or a score (DEC-005).
import { z } from 'zod';

export const SCOPE_LEVEL_KINDS = ['institution', 'org_unit', 'program', 'course', 'custom'] as const;
export type ScopeLevelKind = (typeof SCOPE_LEVEL_KINDS)[number];

/** The kinds of item a scope can list or a champion can be set for. */
export const SCOPE_ITEM_KINDS = ['org_unit', 'program'] as const;
export type ScopeItemKind = (typeof SCOPE_ITEM_KINDS)[number];

// ---- Scope levels (Settings -> Organization -> Institution) ---------------------------------------------------------------

export const ScopeLevelSchema = z.object({
  id: z.string(), key: z.string(), labelEn: z.string(), labelAr: z.string().nullable(), kind: z.enum(SCOPE_LEVEL_KINDS),
  displayOrder: z.number(), active: z.boolean(),
  /** How many things a scope at this level can list (units, programs); 0 for the levels that have no list yet (Course, custom). */
  itemCount: z.number(),
});
export type ScopeLevel = z.infer<typeof ScopeLevelSchema>;
export const CreateScopeLevelSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, 'lower-case letters, digits and _').optional(),
  labelEn: z.string().trim().min(1).max(80), labelAr: z.string().trim().min(1).max(80).optional(),
}).strict();
export type CreateScopeLevel = z.infer<typeof CreateScopeLevelSchema>;
export const UpdateScopeLevelSchema = z.object({
  labelEn: z.string().trim().min(1).max(80).optional(), labelAr: z.string().trim().max(80).nullable().optional(), active: z.boolean().optional(),
}).strict();
export type UpdateScopeLevel = z.infer<typeof UpdateScopeLevelSchema>;
export const ReorderScopeLevelsSchema = z.object({ ids: z.array(z.uuid()).min(1).max(200) }).strict();
export type ReorderScopeLevels = z.infer<typeof ReorderScopeLevelsSchema>;

/** What a scope can list: the institution's active units and programs. */
export const ScopeItemSchema = z.object({ id: z.string(), nameEn: z.string(), nameAr: z.string().nullable(), detail: z.string().nullable() });
export type ScopeItem = z.infer<typeof ScopeItemSchema>;
export const ScopeItemsSchema = z.object({ orgUnit: z.array(ScopeItemSchema), program: z.array(ScopeItemSchema) });
export type ScopeItems = z.infer<typeof ScopeItemsSchema>;

// ---- What a person sets ---------------------------------------------------------------------------------------------------

/** A requirement is named by its standard and code, so what is set carries over to the next version of the standard. */
const target = { frameworkId: z.uuid(), code: z.string().trim().min(1).max(200) };
export const SetRequirementScopeSchema = z.object({ ...target, levelKey: z.string(), itemIds: z.array(z.uuid()).max(2000).default([]) }).strict();
export type SetRequirementScope = z.input<typeof SetRequirementScopeSchema>;
export const RequirementTargetSchema = z.object(target).strict();
export type RequirementTarget = z.infer<typeof RequirementTargetSchema>;
export const SetRequirementChampionSchema = z.object({
  ...target, userId: z.uuid(), itemKind: z.enum(SCOPE_ITEM_KINDS).nullable().default(null), itemId: z.uuid().nullable().default(null),
}).strict();
export type SetRequirementChampion = z.input<typeof SetRequirementChampionSchema>;
/** Removes one champion (overall when no item is named) or, with `all`, every champion set on the requirement. */
export const ClearRequirementChampionSchema = z.object({
  ...target, itemKind: z.enum(SCOPE_ITEM_KINDS).optional(), itemId: z.uuid().optional(), all: z.enum(['true']).optional(),
});
export type ClearRequirementChampion = { frameworkId: string; code: string; itemKind?: ScopeItemKind; itemId?: string; all?: 'true' };

export const OwnScopeSchema = z.object({ levelKey: z.string(), itemIds: z.array(z.string()) });
export type OwnScope = z.infer<typeof OwnScopeSchema>;
export const OwnChampionSchema = z.object({
  itemKind: z.enum(SCOPE_ITEM_KINDS).nullable(), itemId: z.string().nullable(), userId: z.string(), userName: z.string().nullable(),
});
export type OwnChampion = z.infer<typeof OwnChampionSchema>;
/** Exactly what is set on one requirement itself (not what it inherits). */
export const OwnAssignmentSchema = z.object({ scope: OwnScopeSchema.nullable(), champions: z.array(OwnChampionSchema) });
export type OwnAssignment = z.infer<typeof OwnAssignmentSchema>;

// ---- What a requirement ends up with --------------------------------------------------------------------------------------

/**
 * Where an effective value comes from: set on the requirement itself ("Own"), taken from its parent ("From Standard 4"), or
 * taken through an approved mapping from an institution-framework item ("From IQF 4.2"). `code` is that parent's or item's code.
 */
export const AssignmentSourceSchema = z.object({ kind: z.enum(['own', 'parent', 'iqf']), code: z.string().nullable() });
export type AssignmentSource = z.infer<typeof AssignmentSourceSchema>;

export const EffectiveScopeSchema = z.object({
  /** One level when set directly or taken from a parent; several when united from mapped IQF items. */
  levels: z.array(z.object({
    levelKey: z.string(), labelEn: z.string(), labelAr: z.string().nullable(), kind: z.enum(SCOPE_LEVEL_KINDS), active: z.boolean(),
    /** True when it covers every one at the level (no list). */
    all: z.boolean(),
    items: z.array(z.object({ id: z.string(), nameEn: z.string(), nameAr: z.string().nullable() })),
  })),
  sources: z.array(AssignmentSourceSchema),
});
export type EffectiveScope = z.infer<typeof EffectiveScopeSchema>;
export const NodeScopeSchema = z.object({
  own: OwnScopeSchema.nullable(),
  /** What applies now (own, else inherited); null when nothing is set anywhere above. */
  effective: EffectiveScopeSchema.nullable(),
  /** What it would be after "Back to inherited". */
  inherited: EffectiveScopeSchema.nullable(),
});
export type NodeScope = z.infer<typeof NodeScopeSchema>;

export const EffectiveChampionSchema = z.object({
  itemKind: z.enum(SCOPE_ITEM_KINDS).nullable(), itemId: z.string().nullable(), itemName: z.string().nullable(),
  userId: z.string().nullable(), userName: z.string().nullable(),
  /** Mapped IQF items disagree (or only some have one): the screen asks for a champion. */
  needsOne: z.boolean(),
  /** One source, or several when the mapped items agree. */
  sources: z.array(AssignmentSourceSchema),
});
export type EffectiveChampion = z.infer<typeof EffectiveChampionSchema>;
export const NodeChampionSchema = z.object({
  own: z.array(OwnChampionSchema),
  /** The overall champion first (item null), then those of scoped items. */
  effective: z.array(EffectiveChampionSchema),
  inherited: z.array(EffectiveChampionSchema),
});
export type NodeChampion = z.infer<typeof NodeChampionSchema>;

export const NodeAssignmentSchema = z.object({ scope: NodeScopeSchema, champion: NodeChampionSchema });
export type NodeAssignment = z.infer<typeof NodeAssignmentSchema>;

/** The key of a scope item in maps and champion lists: "org_unit:<id>" or "program:<id>"; null for the overall champion. */
export const itemKey = (kind: ScopeItemKind | null, id: string | null): string | null => (kind && id ? `${kind}:${id}` : null);
