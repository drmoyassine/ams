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
  'engagement:read', 'engagement:create', 'engagement:manage', 'engagement:lead', 'engagement:work', 'engagement:review',
  // Evidence (PRD 9): read the repository, add evidence and propose links, approve or reject links.
  'evidence:read', 'evidence:write', 'evidence:review',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = ['org:read', 'program:read', 'framework:read', 'engagement:read', 'evidence:read'];

/** Role × permission. Where a role applies is decided by its scope (institution, org_unit, program, engagement). */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  lead: [...READ, 'org:write', 'program:write', 'framework:write', 'framework:review', 'engagement:create', 'evidence:write', 'evidence:review'],
  engagement_lead: [...READ, 'engagement:manage', 'engagement:lead', 'engagement:work', 'engagement:review', 'evidence:write', 'evidence:review'],
  co_lead: [...READ, 'engagement:manage', 'engagement:work', 'engagement:review', 'evidence:write', 'evidence:review'],
  contributor: [...READ, 'engagement:work', 'evidence:write'],
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

export const JOB_TYPES = ['extract_text', 'ocr', 'ai_extract', 'export', 'notify'] as const;
export type JobType = (typeof JOB_TYPES)[number];

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
