import { z } from 'zod';

export const ROLES = [
  'admin', 'lead', 'engagement_lead', 'co_lead', 'contributor', 'reviewer', 'viewer', 'external_reviewer',
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org:read', 'org:write', 'program:read', 'program:write', 'role:assign', 'audit:read',
  'framework:read', 'framework:write', 'framework:review', 'framework:publish',
  // Engagements (PRD 4, 8). `lead` is the narrow set only the lead and the admin hold: hand over the lead role, record
  // the decision, approve the final snapshot. `manage` is members, roadmap and assignments.
  // The institution's identity and branding (Settings): admin only.
  'institution:write',
  // AI connection (Settings -> AI): provider, model, key and spend limits. Admin only.
  'ai:manage',
  'engagement:read', 'engagement:create', 'engagement:manage', 'engagement:lead', 'engagement:work', 'engagement:review',
  // Evidence (PRD 9): read the repository, add evidence and propose links, approve or reject links.
  'evidence:read', 'evidence:write', 'evidence:review',
  // Quality Management cycles (DEC-029): read them; manage (templates, launch, owners, dates, cancel); work (fill the
  // outputs of stages: stage owners and named approvers can always act on their own stage or approval).
  'cycle:read', 'cycle:manage', 'cycle:work',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = ['org:read', 'program:read', 'framework:read', 'engagement:read', 'evidence:read', 'cycle:read'];

/** Role × permission. Where a role applies is decided by its scope (institution, org_unit, program, engagement). */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  lead: [...READ, 'org:write', 'program:write', 'framework:write', 'framework:review', 'engagement:create', 'evidence:write', 'evidence:review', 'cycle:manage', 'cycle:work'],
  engagement_lead: [...READ, 'engagement:manage', 'engagement:lead', 'engagement:work', 'engagement:review', 'evidence:write', 'evidence:review', 'cycle:work'],
  co_lead: [...READ, 'engagement:manage', 'engagement:work', 'engagement:review', 'evidence:write', 'evidence:review', 'cycle:work'],
  contributor: [...READ, 'engagement:work', 'evidence:write', 'cycle:work'],
  reviewer: [...READ, 'framework:review', 'engagement:review', 'evidence:review'],
  viewer: READ,
  external_reviewer: ['program:read'],  // read-only, one snapshot (P1); framework library is not exposed
};

export type Scope =
  | { type: 'any' } // permission held at some scope; row-level security narrows the rows
  | { type: 'institution' }
  | { type: 'org_unit'; id: string }
  | { type: 'program'; id: string }
  | { type: 'engagement'; id: string };

export const DEGREE_LEVELS = ['associate', 'bachelor', 'master', 'doctorate', 'diploma', 'certificate'] as const;

export const ProgramSchema = z.object({
  id: z.uuid(),
  orgUnitId: z.uuid(),
  nameEn: z.string(),
  nameAr: z.string().nullable(),
  degreeLevel: z.enum(DEGREE_LEVELS),
  discipline: z.string().nullable(),
  tags: z.array(z.string()),
  active: z.boolean(),
});
export type Program = z.infer<typeof ProgramSchema>;

export const CreateProgramSchema = z.object({
  orgUnitId: z.uuid(),
  nameEn: z.string().trim().min(1),
  nameAr: z.string().trim().min(1).optional(),
  degreeLevel: z.enum(DEGREE_LEVELS),
  discipline: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1)).default([]),
});
export type CreateProgram = z.infer<typeof CreateProgramSchema>;

export const UpdateProgramSchema = z.object({
  orgUnitId: z.uuid().optional(),
  nameEn: z.string().trim().min(1).optional(),
  nameAr: z.string().trim().nullable().optional(),
  degreeLevel: z.enum(DEGREE_LEVELS).optional(),
  discipline: z.string().trim().nullable().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  active: z.boolean().optional(),
}).strict();
export type UpdateProgram = z.infer<typeof UpdateProgramSchema>;

/**
 * `analyse`: one stage of a framework analysis run (the stage is in the payload; each stage queues the next).
 * `assistant`: one turn of the in-app assistant (DEC-027); the payload names the conversation and the person's message, and the
 * job runs as that person.
 * `import`: one stage of an AI document import run (docs/ai-import.md); like `analyse`, each stage queues the next.
 * `purge_trash`: a scheduled tick (daily, pg-boss schedule) that removes Trash items older than the retention and their
 * stored files, tenant by tenant under a system identity (DEC-026). It carries no job row.
 * `collect_tick`: a scheduled tick (every 15 minutes, pg-boss schedule) that makes the due evidence collection runs, carries them out by
 * the item's method (asks the BI, sends the request, opens the form, tells the owner), retries failed BI calls and marks late runs
 * (TASK-090, DEC-031). Tenant by tenant under a system identity; no job row.
 */
export const JOB_TYPES = ['extract_text', 'ocr', 'ai_extract', 'export', 'notify', 'analyse', 'purge_trash', 'collect_tick', 'assistant', 'import', 'translate'] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * Which background service takes each job type (DEC-024). Every job type belongs to exactly one group, so adding a type
 * forces a decision here (a test checks the table and the compose file agree).
 *   worker  general work that needs neither document parsing nor a model: exports, notifications, the daily Trash purge, the evidence collection tick
 *   parser  reads documents (CPU and memory heavy)
 *   agent   everything that calls an AI provider; the only service that needs outbound internet; parses no documents
 */
export const QUEUE_GROUPS = {
  worker: ['export', 'notify', 'purge_trash', 'collect_tick'],
  parser: ['extract_text'],
  agent: ['analyse', 'ai_extract', 'ocr', 'assistant', 'import', 'translate'],
} as const satisfies Record<string, readonly JobType[]>;
export type QueueGroup = keyof typeof QUEUE_GROUPS;
export const QUEUE_GROUP_NAMES = Object.keys(QUEUE_GROUPS) as QueueGroup[];

/** The service that takes a job type. */
export function queueGroupOf(type: JobType): QueueGroup {
  const g = QUEUE_GROUP_NAMES.find((name) => (QUEUE_GROUPS[name] as readonly JobType[]).includes(type));
  if (!g) throw new Error(`Job type ${type} is not in any queue group`);
  return g;
}

/**
 * Reads WORKER_QUEUES: comma-separated job types. Unset means every type (local development, tests). An empty list or an
 * unknown name is refused, so a typo can never leave a job type with nobody to run it.
 */
export function parseWorkerQueues(raw: string | undefined): JobType[] {
  if (raw === undefined) return [...JOB_TYPES];
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error(`WORKER_QUEUES is empty; list at least one of: ${JOB_TYPES.join(', ')}`);
  const unknown = names.filter((n) => !(JOB_TYPES as readonly string[]).includes(n));
  if (unknown.length) throw new Error(`WORKER_QUEUES names unknown job type(s) ${unknown.join(', ')}; known: ${JOB_TYPES.join(', ')}`);
  return [...new Set(names)] as JobType[];
}

/**
 * What travels through the queue. The identity is the user who queued the job (or a named system identity with
 * `userId: null`); the worker runs the job as that identity so RLS and the audit trigger apply (DEC-010).
 */
export const JobEnvelopeSchema = z.object({
  jobId: z.uuid(),
  institutionId: z.uuid(),
  userId: z.uuid().nullable(),
  actorType: z.enum(['user', 'system', 'ai']),
});
export type JobEnvelope = z.infer<typeof JobEnvelopeSchema>;
