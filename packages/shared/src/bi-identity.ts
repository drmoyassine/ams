// A person's identity for the BI (DEC-035, docs/ams-bi-contract-v0.md 6.2): the AMS is the BI's authorization server, and the
// tokens it issues for the BI carry the person's BI role and data scope, derived from their AMS role assignments.
import { z } from 'zod';

/** The BI's role vocabulary, lowest first. */
export const BI_ROLES = ['viewer', 'steward', 'admin'] as const;
export type BiRole = (typeof BI_ROLES)[number];

/** One part of a person's data scope: the institution, an org unit (with its sub-units and their programs) or a program. */
export interface BiScopeEntry { type: 'institution' | 'org_unit' | 'program'; id: string; role: BiRole }

/** What the BI receives about a person, besides the standard `sub`, `email` and `name`. */
export interface BiAccess { role: BiRole; scope: BiScopeEntry[] }

/** The claim names, fixed by the contract. */
export const BI_CLAIMS = { userId: 'ams_user_id', institutionId: 'ams_institution_id', role: 'bi_role', scope: 'bi_scope' } as const;

const redirectUri = z.string().url().refine((u) => {
  const url = new URL(u);
  return !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
}, 'a redirect address is https (http only to localhost) and has no #fragment');

/**
 * One client the AMS signs people in for (OAUTH_CLIENTS): the BI's own app, or an MCP client such as Claude. With a `secret` it is a
 * confidential client; without one it is a public client and must use PKCE (all clients do). Clients come only from this server
 * setting: there is no self-registration.
 */
export const OAuthClientConfigSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/, 'a client id is 2 to 64 letters, digits, _ . -'),
  name: z.string().trim().min(1).max(100),
  secret: z.string().min(32, 'a client secret is at least 32 characters').optional(),
  redirectUris: z.array(redirectUri).min(1).max(10),
}).strict();
export type OAuthClientConfig = z.infer<typeof OAuthClientConfigSchema>;
