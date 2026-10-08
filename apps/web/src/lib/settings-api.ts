import type { AiSetting, AiTestResult, UpdateAiSetting, CreateOrgUnit, CreateProgram, Institution, Me, OrgUnit, Program, UpdateInstitution, UpdateOrgUnit, UpdateProgram } from '@ams/shared';
import { api as defaultApi } from './api';
import { unwrap, type Api } from './framework-api';

/** Settings calls (institution, org chart, programs), through the typed client. */
export function settingsApi(api: Api = defaultApi) {
  return {
    me: () => api.api.me.$get().then((r) => unwrap<Me>(r)),
    institution: () => api.api.institution.$get().then((r) => unwrap<Institution>(r)),
    updateInstitution: (json: UpdateInstitution) => api.api.institution.$patch({ json }).then((r) => unwrap<Institution>(r)),
    aiSettings: () => api.api.settings.ai.$get().then((r) => unwrap<AiSetting>(r)),
    updateAiSettings: (json: UpdateAiSetting) => api.api.settings.ai.$put({ json }).then((r) => unwrap<AiSetting>(r)),
    testAi: () => api.api.settings.ai.test.$post().then((r) => unwrap<AiTestResult>(r)),
    orgUnits: () => api.api['org-units'].$get().then((r) => unwrap<OrgUnit[]>(r)),
    createOrgUnit: (json: Partial<CreateOrgUnit> & Pick<CreateOrgUnit, 'type' | 'nameEn'>) => api.api['org-units'].$post({ json }).then((r) => unwrap<OrgUnit>(r)),
    updateOrgUnit: (id: string, json: UpdateOrgUnit) => api.api['org-units'][':id'].$patch({ param: { id }, json }).then((r) => unwrap<OrgUnit>(r)),
    programs: () => api.api.programs.$get().then((r) => unwrap<Program[]>(r)),
    createProgram: (json: Partial<CreateProgram> & Pick<CreateProgram, 'orgUnitId' | 'nameEn' | 'degreeLevel'>) => api.api.programs.$post({ json }).then((r) => unwrap<Program>(r)),
    updateProgram: (id: string, json: UpdateProgram) => api.api.programs[':id'].$patch({ param: { id }, json }).then((r) => unwrap<Program>(r)),
  };
}
export type SettingsApi = ReturnType<typeof settingsApi>;
export const defaultSettingsApi = settingsApi();
export const useSettingsApi = (override?: SettingsApi) => override ?? defaultSettingsApi;
