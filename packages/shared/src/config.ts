import { z } from 'zod';
import { AI_PROVIDERS, type AiProvider } from './ai.js';
import { parseWorkerQueues } from './permissions.js';

/** Every runtime setting comes from the environment (DEC-008). Only open standards: PostgreSQL, S3, SMTP, OIDC. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url(),
  DATABASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(32),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  // Garage admin API. Set only where the object store is a Garage node the app should prepare itself (layout, key, bucket)
  // before it serves; leave unset on any other S3 host (AWS S3, MinIO ...), where nothing is bootstrapped.
  GARAGE_ADMIN_URL: z.url().optional(),
  GARAGE_ADMIN_TOKEN: z.string().min(1).optional(),
  GARAGE_BOOTSTRAP_ATTEMPTS: z.coerce.number().int().positive().default(60),
  GARAGE_BOOTSTRAP_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),
  // Background services (DEC-024): which job types this process takes (unset = every type) and its label in logs.
  WORKER_QUEUES: z.string().optional().transform((v, ctx) => {
    try { return parseWorkerQueues(v); } catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }); return z.NEVER; }
  }),
  WORKER_NAME: z.string().min(1).default('worker'),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Seed administrator, created on first start when the database has no institution.
  INSTITUTION_NAME: z.string().min(1).optional(),
  ADMIN_EMAIL: z.email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
  // Optional: publish the three Appendix A frameworks on first start so the library is not empty.
  SEED_DEMO_FRAMEWORKS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Generic OIDC single sign-on (all three required to enable it).
  OIDC_DISCOVERY_URL: z.url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_PROVIDER_ID: z.string().min(1).default('oidc'),
  SMTP_URL: z.string().url().optional(),
  SMTP_FROM: z.string().optional(),
  // Encrypts secrets stored in the database (the AI provider key). Falls back to AUTH_SECRET when unset; changing it
  // makes stored keys unreadable, so they must be entered again in Settings -> AI.
  APP_SECRET: z.string().min(32).optional(),
  AI_PROVIDER: z.enum(AI_PROVIDERS).default('anthropic'),
  AI_MODEL: z.string().optional(),
  // Only for AI_PROVIDER=openai_compatible (Ollama, vLLM, LM Studio, Azure ...; OpenRouter has its own provider); the key is optional there.
  AI_BASE_URL: z.url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** The AI settings the environment can supply when Settings -> AI has none (DEC-012, DEC-021). */
export const aiEnvSchema = envSchema.pick({
  AI_PROVIDER: true, AI_MODEL: true, AI_BASE_URL: true,
  ANTHROPIC_API_KEY: true, OPENAI_API_KEY: true, GOOGLE_GENERATIVE_AI_API_KEY: true, OPENAI_COMPATIBLE_API_KEY: true, OPENROUTER_API_KEY: true,
});
type AiEnv = z.infer<typeof aiEnvSchema>;

const ENV_KEY_NAME = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_GENERATIVE_AI_API_KEY', openrouter: 'OPENROUTER_API_KEY', openai_compatible: 'OPENAI_COMPATIBLE_API_KEY',
} as const satisfies Record<AiProvider, keyof AiEnv>;
/** The environment's API key for one provider (never another provider's), or undefined. */
export const aiEnvKey = (env: AiEnv, provider: AiProvider): string | undefined => env[ENV_KEY_NAME[provider]];
/** Providers that can run without a key (a local Ollama, for example). */
export const aiKeyOptional = (provider: AiProvider) => provider === 'openai_compatible';
export function loadAiEnv(source: Record<string, string | undefined> = process.env) {
  const present = Object.fromEntries(Object.entries(source).filter(([k, v]) => v !== '' && k in aiEnvSchema.shape));
  return aiEnvSchema.parse(present);
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // An empty value (as in a copied .env.example) means "not set".
  // Except WORKER_QUEUES: set but empty is a mistake that would leave job types without a service, so it is refused.
  const present = Object.fromEntries(Object.entries(source).filter(([k, v]) => v !== '' || k === 'WORKER_QUEUES'));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
