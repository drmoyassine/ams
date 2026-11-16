// API keys (DEC-040): named credentials for other systems, each acting as a service user with one role across the institution.
import { z } from 'zod';

/** The roles a key may have: those that apply across the institution (engagement roles belong to one engagement). */
export const API_KEY_ROLES = ['admin', 'lead', 'contributor', 'reviewer', 'viewer'] as const;
export type ApiKeyRole = (typeof API_KEY_ROLES)[number];

export interface ApiKey {
  id: string; name: string; role: ApiKeyRole; /** The last four characters, to tell keys apart. */ hint: string;
  createdAt: string; createdByName: string | null; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null;
}
/** A key just issued: the key itself is in `token`, shown this once. */
export interface IssuedApiKey { key: ApiKey; token: string }

export const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  role: z.enum(API_KEY_ROLES),
  /** A date (YYYY-MM-DD) or an ISO time; none = no expiry. */
  expiresAt: z.string().trim().refine((v) => !Number.isNaN(Date.parse(v)) && Date.parse(v) > Date.now(), 'the expiry must be a date in the future').nullable().optional(),
}).strict();
export type CreateApiKey = z.infer<typeof CreateApiKeySchema>;
export const ApiKeySchema = z.any() as unknown as z.ZodType<ApiKey, ApiKey>;
export const ApiKeyListSchema = z.any() as unknown as z.ZodType<ApiKey[], ApiKey[]>;
export const IssuedApiKeySchema = z.any() as unknown as z.ZodType<IssuedApiKey, IssuedApiKey>;
