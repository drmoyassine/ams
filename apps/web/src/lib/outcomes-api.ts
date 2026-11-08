import { hc } from 'hono/client';
import type { OutcomeRoutes } from '@ams/api';
import type {
  Course, CourseProgramInput, CreateCourse, CreateOutcome, LearningOutcome, OutcomeLevel, OutcomeLink, OutcomeLinkInput, OutcomesWorkbook, OutcomesWorkbookResult,
  AddReviewFinding, ProgramOutcomes, ProgramReview, ReviewFinding, ReviewRubric, ReviewSummary, UpdateCourse, UpdateOutcome,
} from '@ams/shared';
import { noteResponse } from './undo';
import { unwrap } from './framework-api';

/** Courses, learning outcomes and their links (TASK-105, TASK-112): a typed client of its own (OutcomeRoutes, see the API's app.ts). */
export function outcomesApi(fetcher: typeof fetch = fetch) {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetcher(input, { ...init, credentials: 'include' });
    noteResponse(res, fetcher, init?.method ?? 'GET');
    return res;
  }) as typeof fetch;
  const a = hc<OutcomeRoutes>('/', { fetch: wrapped }).api;
  return {
    courses: (programId?: string) => a.courses.$get({ query: programId ? { programId } : {} }).then((r) => unwrap<Course[]>(r)),
    createCourse: (json: CreateCourse) => a.courses.$post({ json }).then((r) => unwrap<Course>(r)),
    updateCourse: (id: string, json: UpdateCourse) => a.courses[':id'].$patch({ param: { id }, json }).then((r) => unwrap<Course>(r)),
    setCourseProgram: (id: string, programId: string, json: Partial<CourseProgramInput>) =>
      a.courses[':id'].programs[':programId'].$put({ param: { id, programId }, json: { role: 'core', ...json } }).then((r) => unwrap<Course>(r)),
    removeCourseProgram: (id: string, programId: string) => a.courses[':id'].programs[':programId'].$delete({ param: { id, programId } }).then((r) => unwrap<Course>(r)),
    courseOutcomes: (id: string) => a.courses[':id'].outcomes.$get({ param: { id } }).then((r) => unwrap<LearningOutcome[]>(r)),
    programOutcomes: (id: string) => a.programs[':id'].outcomes.$get({ param: { id } }).then((r) => unwrap<ProgramOutcomes>(r)),
    ilos: () => a.ilos.$get().then((r) => unwrap<LearningOutcome[]>(r)),
    createOutcome: (json: CreateOutcome) => a.outcomes.$post({ json }).then((r) => unwrap<LearningOutcome>(r)),
    updateOutcome: (id: string, json: UpdateOutcome) => a.outcomes[':id'].$patch({ param: { id }, json }).then((r) => unwrap<LearningOutcome>(r)),
    deleteOutcome: (id: string) => a.outcomes[':id'].$delete({ param: { id } }).then((r) => unwrap<{ deleted: true }>(r)),
    setLink: (json: OutcomeLinkInput) => a['outcome-links'].$put({ json }).then((r) => unwrap<OutcomeLink>(r)),
    removeLink: (fromId: string, toId: string) => a['outcome-links'].remove.$post({ json: { fromId, toId } }).then((r) => unwrap<{ removed: boolean }>(r)),
    loadWorkbook: (json: OutcomesWorkbook) => a.outcomes.workbook.$post({ json }).then((r) => unwrap<OutcomesWorkbookResult>(r)),
    reviewSummary: () => a['program-reviews'].$get().then((r) => unwrap<ReviewSummary>(r)),
    programReview: (id: string) => a.programs[':id'].review.$get({ param: { id } }).then((r) => unwrap<ProgramReview>(r)),
    addFinding: (id: string, json: AddReviewFinding) => a.programs[':id'].review.$post({ param: { id }, json }).then((r) => unwrap<ReviewFinding>(r)),
    reviewRubric: () => a.settings['review-rubric'].$get().then((r) => unwrap<ReviewRubric>(r)),
    /** The evidence items linked to these items of the internal framework, by code (TASK-111). */
    forItems: (versionId: string, requirementIds: string[]) => a.evidence['for-items'].$post({ json: { versionId, requirementIds } }).then((r) => unwrap<{ ids: string[] }>(r)),
    /** Which items each import of this version created, by the document its run read (TASK-111): document id -> requirement ids. */
    importedItems: (versionId: string) => a['framework-versions'][':id']['imported-items'].$get({ param: { id: versionId } }).then((r) => unwrap<Record<string, string[]>>(r)),
    levels: () => a.settings['outcome-levels'].$get().then((r) => unwrap<OutcomeLevel[]>(r)),
    setLevels: (json: OutcomeLevel[]) => a.settings['outcome-levels'].$put({ json }).then((r) => unwrap<OutcomeLevel[]>(r)),
  };
}
export type OutcomesApi = ReturnType<typeof outcomesApi>;
let defaultOutcomesApi: OutcomesApi | null = null;
export const useOutcomesApi = (override?: OutcomesApi) => override ?? (defaultOutcomesApi ??= outcomesApi());
