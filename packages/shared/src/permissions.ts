import { z } from 'zod';

export const ROLES = [
  'admin', 'lead', 'engagement_lead', 'co_lead', 'contributor', 'reviewer', 'viewer', 'external_reviewer',
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org:read', 'org:write', 'program:read', 'program:write', 'role:assign', 'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = ['org:read', 'program:read'];

/** Role × permission. Where a role applies is decided by its scope (institution, org_unit, program, engagement). */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  lead: [...READ, 'org:write', 'program:write'],
  engagement_lead: READ,
  co_lead: READ,
  contributor: READ,
  reviewer: READ,
  viewer: READ,
  external_reviewer: ['program:read'],
};

export type Scope =
  | { type: 'any' } // permission held at some scope; row-level security narrows the rows
  | { type: 'institution' }
  | { type: 'org_unit'; id: string }
  | { type: 'program'; id: string };

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
