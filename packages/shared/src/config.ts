import { z } from 'zod';

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
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Seed administrator, created on first start when the database has no institution.
  INSTITUTION_NAME: z.string().min(1).optional(),
  ADMIN_EMAIL: z.email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
  // Optional: publish the three Appendix A frameworks (WSCUC, ABET, PUC) on first start so the library is not empty.
  SEED_DEMO_FRAMEWORKS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Generic OIDC single sign-on (all three required to enable it).
  OIDC_DISCOVERY_URL: z.url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_PROVIDER_ID: z.string().min(1).default('oidc'),
  SMTP_URL: z.string().url().optional(),
  SMTP_FROM: z.string().optional(),
  AI_PROVIDER: z.string().default('anthropic'),
  AI_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // An empty value (as in a copied .env.example) means "not set".
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
