export * from './app.js';
export * from './chain.js';
export type { ApiRoutes } from './routes.js';
/** Courses, outcomes and links: a second typed client (the main chain's type is at the compiler's limit). */
export type OutcomeRoutes = ReturnType<typeof import('./routes/outcomes.js').outcomeRoutes>;
/** Assessment of learning (plans, attainment, results, actions, ILO rotation): a third typed client. */
/** Deleting evidence and bulk edits: a fourth typed client. */
export type EvidenceOpsRoutes = ReturnType<typeof import('./routes/evidence-ops.js').evidenceOpsRoutes>;
export type AssessmentRoutes = ReturnType<typeof import('./routes/assessment.js').assessmentRoutes>;
export type SyllabusRoutes = ReturnType<typeof import('./routes/syllabus.js').syllabusRoutes>;
export { seedAdmin, seedFrameworks, seedGlossary, syncAdmin } from './seed.js';
/** In-memory evidence storage, for tests and local runs without object storage. */
export { MemoryStore } from '@ams/core';
