export * from './app.js';
export * from './chain.js';
export type { ApiRoutes } from './routes.js';
/** Courses, outcomes and links: a second typed client (the main chain's type is at the compiler's limit). */
export type OutcomeRoutes = ReturnType<typeof import('./routes/outcomes.js').outcomeRoutes>;
export { seedAdmin, seedFrameworks, seedGlossary } from './seed.js';
/** In-memory evidence storage, for tests and local runs without object storage. */
export { MemoryStore } from '@ams/core';
