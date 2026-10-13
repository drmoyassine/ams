import type { PublicBranding, AiAccount, AiAccountTest, AiModelKind, AiModelList, AiRole, AiSetting, AiTestResult, CreateAiAccount, UpdateAiAccount, UpdateAiSetting, CreateOrgUnit, CreateProgram, Institution, Me, OrgUnit, Program, UpdateInstitution, UpdateOrgUnit, UpdateProgram } from '@ams/shared';
import { api as defaultApi } from './api';
import { unwrap, type Api } from './framework-api';
import { readBytes } from './read-bytes';

/** Settings calls (institution, org chart, programs), through the typed client. */
export function settingsApi(api: Api = defaultApi, fetcher: typeof fetch = fetch) {
  return {
    me: () => api.api.me.$get().then((r) => unwrap<Me>(r)),
    institution: () => api.api.institution.$get().then((r) => unwrap<Institution>(r)),
    updateInstitution: (json: UpdateInstitution) => api.api.institution.$patch({ json }).then((r) => unwrap<Institution>(r)),
    /** Where the institution's logo is served; `version` changes when the logo does, so the browser fetches the new one. */
    institutionLogoUrl: (version: string) => `/api/institution/logo?v=${version}`,
    uploadInstitutionLogo: async (file: File) => {
      const body = await readBytes(file);
      return fetcher('/api/institution/logo', { method: 'PUT', body, headers: { 'content-type': file.type || 'application/octet-stream' }, credentials: 'include' }).then((r) => unwrap<void>(r));
    },
    removeInstitutionLogo: () => api.api.institution.logo.$delete().then((r) => unwrap<void>(r)),
    /** Before sign-in: the institution's display name, accent colour and logo address, and nothing else. */
    publicBranding: () => api.api.public.branding.$get().then((r) => unwrap<PublicBranding>(r)),
    aiSettings: () => api.api.settings.ai.$get().then((r) => unwrap<AiSetting>(r)),
    updateAiSettings: (json: UpdateAiSetting) => api.api.settings.ai.$put({ json }).then((r) => unwrap<AiSetting>(r)),
    testAi: (role: AiRole = 'analysis') => api.api.settings.ai.test.$post({ json: { role } }).then((r) => unwrap<AiTestResult>(r)),
    aiAccounts: () => api.api.settings.ai.accounts.$get().then((r) => unwrap<AiAccount[]>(r)),
    createAiAccount: (json: CreateAiAccount) => api.api.settings.ai.accounts.$post({ json }).then((r) => unwrap<AiAccount>(r)),
    updateAiAccount: (id: string, json: UpdateAiAccount) => api.api.settings.ai.accounts[':id'].$patch({ param: { id }, json }).then((r) => unwrap<AiAccount>(r)),
    deleteAiAccount: (id: string) => api.api.settings.ai.accounts[':id'].$delete({ param: { id } }).then((r) => unwrap<void>(r)),
    testAiAccount: (id: string, json: AiAccountTest = {}) => api.api.settings.ai.accounts[':id'].test.$post({ param: { id }, json }).then((r) => unwrap<AiTestResult>(r)),
    aiModels: (id: string, kind?: Exclude<AiModelKind, 'other'>, refresh = false) =>
      api.api.settings.ai.accounts[':id'].models.$get({ param: { id }, query: { ...(kind ? { kind } : {}), ...(refresh ? { refresh: 'true' as const } : {}) } }).then((r) => unwrap<AiModelList>(r)),
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
