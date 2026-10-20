import type { CyclePlan, DueRuns, DueRunsQuery, EffectivePlan, NodePlans, PlanTarget, SetPlan, SkipDueRun, TargetPlans } from '@ams/shared';
import { api as defaultApi } from './api';
import { unwrap, type Api } from './framework-api';

export type { CyclePlan, DueRuns, EffectivePlan, NodePlans, TargetPlans };

/** Cycle plans and proposed runs (TASK-081), through the typed client. The academic calendar is part of the settings client. */
export function plansApi(api: Api = defaultApi) {
  const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  return {
    list: () => api.api['cycle-plans'].$get().then((r) => unwrap<CyclePlan[]>(r)),
    /** The plans set on one anchor, and for a requirement what is in effect and what "Back to inherited" would give. */
    target: (query: PlanTarget) => api.api['cycle-plans'].target.$get({ query: clean(query) as never }).then((r) => unwrap<TargetPlans>(r)),
    set: (json: SetPlan) => api.api['cycle-plans'].$put({ json: json as never }).then((r) => unwrap<CyclePlan>(r)),
    /** "Back to inherited": removes the plan or opt-out. */
    clear: (id: string) => api.api['cycle-plans'][':id'].$delete({ param: { id } }).then((r) => unwrap<void>(r)),
    setNextDate: (id: string, date: string) => api.api['cycle-plans'][':id']['next-date'].$post({ param: { id }, json: { date } }).then((r) => unwrap<CyclePlan>(r)),
    due: (query: DueRunsQuery = {}) => api.api['due-cycle-runs'].$get({ query: Object.fromEntries(Object.entries(clean(query)).map(([k, v]) => [k, String(v)])) as never }).then((r) => unwrap<DueRuns>(r)),
    skip: (json: SkipDueRun) => api.api['cycle-plan-skips'].$post({ json: json as never }).then((r) => unwrap<{ ok: true }>(r)),
  };
}
export type PlansApi = ReturnType<typeof plansApi>;
export const defaultPlansApi = plansApi();
export const usePlansApi = (override?: PlansApi) => override ?? defaultPlansApi;
