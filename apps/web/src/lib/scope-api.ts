import type {
  ClearRequirementChampion, CreateScopeLevel, NodeAssignment, OwnAssignment, RequirementTarget, ScopeItems, ScopeLevel, SetRequirementChampion, SetRequirementScope, UpdateScopeLevel,
} from '@ams/shared';
import { api as defaultApi } from './api';
import { unwrap, type Api } from './framework-api';

export type { NodeAssignment, OwnAssignment, ScopeItems, ScopeLevel };

/**
 * Scope levels and the scope and champion of a requirement (TASK-086), through the typed client. A requirement is named by its
 * standard (`frameworkId`) and code, so what is set carries over to the next version. What a requirement ends up with after
 * inheritance is read with the version's requirement-context (see evidence-api), not from here.
 */
export function scopeApi(api: Api = defaultApi) {
  const level = api.api['scope-levels'][':id'];
  return {
    levels: () => api.api['scope-levels'].$get().then((r) => unwrap<ScopeLevel[]>(r)),
    createLevel: (json: CreateScopeLevel) => api.api['scope-levels'].$post({ json }).then((r) => unwrap<ScopeLevel>(r)),
    updateLevel: (id: string, json: UpdateScopeLevel) => level.$patch({ param: { id }, json }).then((r) => unwrap<ScopeLevel>(r)),
    reorderLevels: (ids: string[]) => api.api['scope-levels'].reorder.$post({ json: { ids } }).then((r) => unwrap<ScopeLevel[]>(r)),
    /** The active units and programs a scope can list. */
    items: () => api.api['scope-items'].$get().then((r) => unwrap<ScopeItems>(r)),
    own: (t: RequirementTarget) => api.api['requirement-assignment'].$get({ query: t }).then((r) => unwrap<OwnAssignment>(r)),
    setScope: (json: SetRequirementScope) => api.api['requirement-scope'].$put({ json: json as never }).then((r) => unwrap<OwnAssignment>(r)),
    /** "Back to inherited". */
    clearScope: (t: RequirementTarget) => api.api['requirement-scope'].$delete({ query: t }).then((r) => unwrap<OwnAssignment>(r)),
    setChampion: (json: SetRequirementChampion) => api.api['requirement-champion'].$put({ json: json as never }).then((r) => unwrap<OwnAssignment>(r)),
    clearChampion: (q: ClearRequirementChampion) => api.api['requirement-champion'].$delete({ query: q }).then((r) => unwrap<OwnAssignment>(r)),
  };
}
export type ScopeApi = ReturnType<typeof scopeApi>;
export const defaultScopeApi = scopeApi();
export const useScopeApi = (override?: ScopeApi) => override ?? defaultScopeApi;
