import { hc } from 'hono/client';
import type { AssessmentRoutes } from '@ams/api';
import type {
  AssessmentBenchmarks, AssessmentPlan, CorrectiveAction, CourseAssessment, IloReport, IloScheduleRow, ImportResultRow, ProgramAssessment, SaveAction,
  SaveCourseAssessment, SaveIloSchedule, SavePlanItem, SaveResult, UpdatePlan,
} from '@ams/shared';
import { noteResponse } from './undo';
import { unwrap } from './framework-api';

export interface AttainmentView {
  courseId: string; term: string; overall: number | null; unmapped: number; total: number;
  clos: { cloId: string; possible: number; achieved: number; attainment: number | null; weight: number }[];
  plos: { ploId: string; code: string; programId: string; possible: number; achieved: number; attainment: number | null }[];
}

/** Assessment of learning (TASK-114..117): a typed client of its own (AssessmentRoutes, see the API's app.ts). */
export function assessmentApi(fetcher: typeof fetch = fetch) {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetcher(input, { ...init, credentials: 'include' });
    noteResponse(res, fetcher, init?.method ?? 'GET');
    return res;
  }) as typeof fetch;
  const a = hc<AssessmentRoutes>('/', { fetch: wrapped }).api;
  return {
    benchmarks: () => a.settings['assessment-benchmarks'].$get().then((r) => unwrap<AssessmentBenchmarks>(r)),
    setBenchmarks: (json: AssessmentBenchmarks) => a.settings['assessment-benchmarks'].$put({ json }).then((r) => unwrap<AssessmentBenchmarks>(r)),
    programAssessment: (id: string) => a.programs[':id'].assessment.$get({ param: { id } }).then((r) => unwrap<ProgramAssessment>(r)),
    createPlan: (id: string, academicYear: string, copyFrom?: string) => a.programs[':id'].plans.$post({ param: { id }, json: { academicYear, ...(copyFrom ? { copyFrom } : {}) } }).then((r) => unwrap<AssessmentPlan>(r)),
    plan: (id: string) => a.plans[':id'].$get({ param: { id } }).then((r) => unwrap<AssessmentPlan>(r)),
    updatePlan: (id: string, json: UpdatePlan) => a.plans[':id'].$patch({ param: { id }, json }).then((r) => unwrap<AssessmentPlan>(r)),
    savePlanItem: (id: string, json: SavePlanItem) => a['plan-items'][':id'].$patch({ param: { id }, json }).then((r) => unwrap<AssessmentPlan>(r)),
    courseAssessments: (id: string, term?: string) => a.courses[':id'].assessments.$get({ param: { id }, query: term ? { term } : {} }).then((r) => unwrap<CourseAssessment[]>(r)),
    saveCourseAssessment: (id: string, json: SaveCourseAssessment, aid?: string) => (aid
      ? a.courses[':id'].assessments[':aid'].$put({ param: { id, aid }, json }) : a.courses[':id'].assessments.$post({ param: { id }, json })).then((r) => unwrap<CourseAssessment[]>(r)),
    deleteCourseAssessment: (id: string, aid: string) => a.courses[':id'].assessments[':aid'].$delete({ param: { id, aid } }).then((r) => unwrap<{ deleted: boolean }>(r)),
    attainment: (id: string, term: string) => a.courses[':id'].attainment.$get({ param: { id }, query: { term } }).then((r) => unwrap<AttainmentView>(r)),
    recordAttainment: (id: string, term: string) => a.courses[':id'].attainment.record.$post({ param: { id }, json: { term } }).then((r) => unwrap<{ recorded: number }>(r)),
    addResult: (json: SaveResult) => a.results.$post({ json }).then((r) => unwrap<{ id: string }>(r)),
    deleteResult: (id: string) => a.results[':id'].$delete({ param: { id } }).then((r) => unwrap<{ deleted: boolean }>(r)),
    importResults: (id: string, rows: ImportResultRow[], apply: boolean, source: string) =>
      a.programs[':id'].results.import.$post({ param: { id }, json: { rows, apply, source } }).then((r) => unwrap<{ added: number; skipped: { row: string; reason: string }[] }>(r)),
    addAction: (id: string, json: SaveAction) => a.programs[':id'].actions.$post({ param: { id }, json }).then((r) => unwrap<CorrectiveAction>(r)),
    updateAction: (id: string, json: Partial<SaveAction>) => a.actions[':id'].$patch({ param: { id }, json }).then((r) => unwrap<CorrectiveAction>(r)),
    iloReport: () => a['ilo-report'].$get().then((r) => unwrap<IloReport>(r)),
    saveIloSchedule: (json: SaveIloSchedule) => a['ilo-schedule'].$put({ json }).then((r) => unwrap<IloScheduleRow>(r)),
    deleteIloSchedule: (id: string) => a['ilo-schedule'][':id'].$delete({ param: { id } }).then((r) => unwrap<{ deleted: boolean }>(r)),
  };
}
export type AssessmentApi = ReturnType<typeof assessmentApi>;
let defaultAssessmentApi: AssessmentApi | null = null;
export const useAssessmentApi = (override?: AssessmentApi) => override ?? (defaultAssessmentApi ??= assessmentApi());
