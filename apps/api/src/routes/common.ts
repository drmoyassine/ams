import { z } from '@hono/zod-openapi';
import { ErrorSchema } from '@ams/shared';

export const json = <T extends z.ZodType>(schema: T) => ({ content: { 'application/json': { schema } } });
export const idParam = z.object({ id: z.uuid() });
export const versionParam = idParam;

/** The error responses every protected route can produce. */
export const errors = {
  400: { description: 'Invalid request', ...json(ErrorSchema) },
  401: { description: 'Unauthenticated', ...json(ErrorSchema) },
  403: { description: 'Forbidden', ...json(ErrorSchema) },
  404: { description: 'Not found', ...json(ErrorSchema) },
  409: { description: 'Conflicts with the current state or a rule', ...json(ErrorSchema) },
};
