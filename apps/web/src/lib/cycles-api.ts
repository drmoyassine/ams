import type {
  AddInput, AddOutput, AddStage, CreateCycleTemplate, CycleAnchorKind, CycleDetail, CycleFilter, CycleInput, CycleSummary, CycleTemplate, CycleTemplateStatus, Decide,
  DeleteResult, LaunchCycle, MyWork, SetPick, TemplateValidation, UpdateCycle, UpdateCycleTemplate, UpdateOutput, UpdateStage,
} from '@ams/shared';
import { api as defaultApi } from './api';
import { unwrap, type Api } from './framework-api';
import { readBytes } from './read-bytes';

export type { CycleDetail, CycleSummary, CycleTemplate, MyWork };

/** Quality Management cycle calls (TASK-078), through the typed client. Mutations answer with the whole cycle. */
export function cyclesApi(api: Api = defaultApi, fetcher: typeof fetch = fetch) {
  const stage = api.api['cycle-stages'][':id'];
  const output = api.api['cycle-outputs'][':id'];
  const cyc = api.api.cycles[':id'];
  const tpl = api.api['cycle-templates'][':id'];
  const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  return {
    // ---- Templates ----
    templates: (query: { status?: CycleTemplateStatus; anchorKind?: CycleAnchorKind } = {}) => api.api['cycle-templates'].$get({ query: clean(query) }).then((r) => unwrap<CycleTemplate[]>(r)),
    template: (id: string) => tpl.$get({ param: { id } }).then((r) => unwrap<CycleTemplate>(r)),
    validateTemplate: (stages: unknown[]) => api.api['cycle-templates'].validate.$post({ json: { stages } as never }).then((r) => unwrap<TemplateValidation>(r)),
    createTemplate: (json: Partial<CreateCycleTemplate> & Pick<CreateCycleTemplate, 'key' | 'name'>) => api.api['cycle-templates'].$post({ json: json as never }).then((r) => unwrap<CycleTemplate>(r)),
    updateTemplate: (id: string, json: UpdateCycleTemplate) => tpl.$patch({ param: { id }, json: json as never }).then((r) => unwrap<CycleTemplate>(r)),
    deleteTemplate: (id: string) => tpl.$delete({ param: { id } }).then((r) => unwrap<void>(r)),
    publishTemplate: (id: string) => tpl.publish.$post({ param: { id } }).then((r) => unwrap<CycleTemplate>(r)),
    retireTemplate: (id: string) => tpl.retire.$post({ param: { id } }).then((r) => unwrap<CycleTemplate>(r)),
    reinstateTemplate: (id: string) => tpl.reinstate.$post({ param: { id } }).then((r) => unwrap<CycleTemplate>(r)),
    reviseTemplate: (id: string) => tpl.revise.$post({ param: { id } }).then((r) => unwrap<CycleTemplate>(r)),

    // ---- Cycles ----
    list: (filter: CycleFilter = {}) => api.api.cycles.$get({ query: clean(filter) as never }).then((r) => unwrap<CycleSummary[]>(r)),
    get: (id: string) => cyc.$get({ param: { id } }).then((r) => unwrap<CycleDetail>(r)),
    launch: (json: Partial<LaunchCycle> & Pick<LaunchCycle, 'anchorKind' | 'anchorId' | 'startDate'>) => api.api.cycles.$post({ json: json as never }).then((r) => unwrap<CycleDetail>(r)),
    update: (id: string, json: UpdateCycle) => cyc.$patch({ param: { id }, json }).then((r) => unwrap<CycleDetail>(r)),
    /** Deletes a DRAFT to the Trash; a started cycle is cancelled instead. */
    delete: (id: string) => cyc.$delete({ param: { id } }).then((r) => unwrap<DeleteResult>(r)),
    activate: (id: string) => cyc.activate.$post({ param: { id } }).then((r) => unwrap<CycleDetail>(r)),
    revertToDraft: (id: string) => cyc['revert-to-draft'].$post({ param: { id } }).then((r) => unwrap<CycleDetail>(r)),
    cancel: (id: string, reason: string) => cyc.cancel.$post({ param: { id }, json: { reason } }).then((r) => unwrap<CycleDetail>(r)),
    myWork: () => api.api['my-cycle-work'].$get().then((r) => unwrap<MyWork>(r)),

    // ---- Stages ----
    addStage: (cycleId: string, json: AddStage) => cyc.stages.$post({ param: { id: cycleId }, json: json as never }).then((r) => unwrap<CycleDetail>(r)),
    updateStage: (id: string, json: UpdateStage) => stage.$patch({ param: { id }, json }).then((r) => unwrap<CycleDetail>(r)),
    deleteStage: (id: string) => stage.$delete({ param: { id } }).then((r) => unwrap<CycleDetail>(r)),
    startStage: (id: string) => stage.start.$post({ param: { id } }).then((r) => unwrap<CycleDetail>(r)),
    resetStage: (id: string) => stage.reset.$post({ param: { id } }).then((r) => unwrap<CycleDetail>(r)),
    completeStage: (id: string) => stage.complete.$post({ param: { id } }).then((r) => unwrap<CycleDetail>(r)),
    skipStage: (id: string, reason: string) => stage.skip.$post({ param: { id }, json: { reason } }).then((r) => unwrap<CycleDetail>(r)),
    reopenStage: (id: string) => stage.reopen.$post({ param: { id } }).then((r) => unwrap<CycleDetail>(r)),
    toggleChecklist: (id: string, index: number, done: boolean) => stage.checklist.$post({ param: { id }, json: { index, done } }).then((r) => unwrap<CycleDetail>(r)),
    stageInputs: (id: string) => stage.inputs.$get({ param: { id } }).then((r) => unwrap<CycleInput[]>(r)),

    // ---- Outputs ----
    addOutput: (stageId: string, json: AddOutput) => stage.outputs.$post({ param: { id: stageId }, json: json as never }).then((r) => unwrap<CycleDetail>(r)),
    updateOutput: (id: string, json: UpdateOutput) => output.$patch({ param: { id }, json }).then((r) => unwrap<CycleDetail>(r)),
    deleteOutput: (id: string) => output.$delete({ param: { id } }).then((r) => unwrap<CycleDetail>(r)),
    setNote: (id: string, note: string) => output.note.$put({ param: { id }, json: { note } }).then((r) => unwrap<CycleDetail>(r)),
    finalizeOutput: (id: string) => output.finalize.$post({ param: { id } }).then((r) => unwrap<CycleDetail>(r)),
    reopenOutput: (id: string) => output.reopen.$post({ param: { id } }).then((r) => unwrap<CycleDetail>(r)),
    /** Where a document output's file is served (download or inline preview). */
    fileUrl: (outputId: string) => `/api/cycle-outputs/${outputId}/file`,
    uploadFile: async (outputId: string, file: File) => {
      const body = await readBytes(file);
      return fetcher(`/api/cycle-outputs/${outputId}/file?fileName=${encodeURIComponent(file.name)}`, {
        method: 'PUT', body, headers: { 'content-type': file.type || 'application/octet-stream' }, credentials: 'include',
      }).then((r) => unwrap<CycleDetail>(r));
    },
    removeFile: (id: string) => output.file.$delete({ param: { id } }).then((r) => unwrap<CycleDetail>(r)),
    decide: (id: string, json: Decide) => output.decision.$post({ param: { id }, json }).then((r) => unwrap<CycleDetail>(r)),

    // ---- Inputs ----
    addInput: (stageId: string, json: AddInput) => stage.inputs.$post({ param: { id: stageId }, json: json as never }).then((r) => unwrap<CycleDetail>(r)),
    deleteInput: (id: string) => api.api['cycle-inputs'][':id'].$delete({ param: { id } }).then((r) => unwrap<CycleDetail>(r)),
    setPick: (id: string, json: SetPick) => api.api['cycle-inputs'][':id'].pick.$put({ param: { id }, json }).then((r) => unwrap<CycleDetail>(r)),
  };
}
export type CyclesApi = ReturnType<typeof cyclesApi>;
export const defaultCyclesApi = cyclesApi();
export const useCyclesApi = (override?: CyclesApi) => override ?? defaultCyclesApi;
