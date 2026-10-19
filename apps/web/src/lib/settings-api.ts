import type { AiAccount, AiAccountTest, AiModelKind, AiModelList, AiRole, AiSetting, AiTestResult, CreateAiAccount, CreateOrgUnit, CreateOrgUnitType, CreateProgram, DeletePreview, DeleteResult, I18nBundle, Institution, LanguageState, LanguagesSettings, Me, MoveManyInput, OrgChart, OrgUnit, OrgUnitType, Program, PublicBranding, PublicI18n, SaveUiTranslation, TranslationRun, UiTranslationPage, UpdateAiAccount, UpdateAiSetting, UpdateInstitution, UpdateOrgUnit, UpdateOrgUnitType, UpdateProgram, UserSummary } from '@ams/shared';
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
    /** Before sign-in: the language setting and the sign-in page's own strings, and nothing else. */
    publicI18n: () => api.api.public.i18n.$get().then((r) => unwrap<PublicI18n>(r)),
    /** The signed-in person's own preferences (the interface language); null goes back to the institution's default. */
    updateMyPreferences: (json: { uiLocale: string | null }) => api.api.me.preferences.$patch({ json }).then((r) => unwrap<LanguageState>(r)),
    /** The secondary language's interface catalogue, merged over English by the app; null when that language is not the institution's. */
    i18nBundle: async (language: string): Promise<I18nBundle | null> => {
      const r = await api.api.i18n[':language'].$get({ param: { language } });
      return r.status === 404 ? null : unwrap<I18nBundle>(r);
    },
    languagesSettings: () => api.api.settings.languages.$get().then((r) => unwrap<LanguagesSettings>(r)),
    uiTranslations: (query: { filter?: 'all' | 'missing' | 'needs_review' | 'reviewed' | 'stale'; q?: string; offset?: number; limit?: number } = {}) =>
      api.api.settings.languages.translations.$get({ query: { ...(query.filter ? { filter: query.filter } : {}), ...(query.q ? { q: query.q } : {}), ...(query.offset !== undefined ? { offset: String(query.offset) } : {}), ...(query.limit !== undefined ? { limit: String(query.limit) } : {}) } }).then((r) => unwrap<UiTranslationPage>(r)),
    saveUiTranslation: (json: SaveUiTranslation) => api.api.settings.languages.translations.$put({ json }).then((r) => unwrap<UiTranslationPage['rows'][number]>(r)),
    markUiReviewed: (keys?: string[]) => api.api.settings.languages.translations.reviewed.$post({ json: keys ? { keys } : {} }).then((r) => unwrap<{ marked: number }>(r)),
    startTranslation: (retranslateStale = false) => api.api.settings.languages.translate.$post({ json: { kind: 'ui' as const, retranslateStale } }).then((r) => unwrap<TranslationRun>(r)),
    cancelTranslation: (id: string) => api.api.settings.languages.translate[':id'].cancel.$post({ param: { id } }).then((r) => unwrap<TranslationRun>(r)),
    resumeTranslation: (id: string) => api.api.settings.languages.translate[':id'].resume.$post({ param: { id } }).then((r) => unwrap<TranslationRun>(r)),
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
    /** The org chart builder: the chart (units in tree order with programs and counts, and the unit types). */
    orgChart: () => api.api['org-chart'].$get().then((r) => unwrap<OrgChart>(r)),
    moveOrgUnits: (json: MoveManyInput) => api.api['org-units']['move-many'].$post({ json }).then((r) => unwrap<{ moved: number; changed: number; unchanged: boolean }>(r)),
    previewDeleteOrgUnits: (ids: string[]) => api.api['org-units']['delete-preview'].$post({ json: { ids } }).then((r) => unwrap<DeletePreview>(r)),
    deleteOrgUnits: (ids: string[]) => api.api['org-units'].delete.$post({ json: { ids } }).then((r) => unwrap<DeleteResult>(r)),
    orgUnitTypes: () => api.api['org-unit-types'].$get().then((r) => unwrap<OrgUnitType[]>(r)),
    createOrgUnitType: (json: CreateOrgUnitType) => api.api['org-unit-types'].$post({ json }).then((r) => unwrap<OrgUnitType>(r)),
    updateOrgUnitType: (id: string, json: UpdateOrgUnitType) => api.api['org-unit-types'][':id'].$patch({ param: { id }, json }).then((r) => unwrap<OrgUnitType>(r)),
    reorderOrgUnitTypes: (ids: string[]) => api.api['org-unit-types'].reorder.$post({ json: { ids } }).then((r) => unwrap<OrgUnitType[]>(r)),
    removeOrgUnitType: (id: string) => api.api['org-unit-types'][':id'].$delete({ param: { id } }).then((r) => unwrap<void>(r)),
    /** People of the institution (to pick a head). */
    people: () => api.api.users.$get().then((r) => unwrap<UserSummary[]>(r)),
    programs: () => api.api.programs.$get().then((r) => unwrap<Program[]>(r)),
    createProgram: (json: Partial<CreateProgram> & Pick<CreateProgram, 'orgUnitId' | 'nameEn' | 'degreeLevel'>) => api.api.programs.$post({ json }).then((r) => unwrap<Program>(r)),
    updateProgram: (id: string, json: UpdateProgram) => api.api.programs[':id'].$patch({ param: { id }, json }).then((r) => unwrap<Program>(r)),
  };
}
export type SettingsApi = ReturnType<typeof settingsApi>;
export const defaultSettingsApi = settingsApi();
export const useSettingsApi = (override?: SettingsApi) => override ?? defaultSettingsApi;
