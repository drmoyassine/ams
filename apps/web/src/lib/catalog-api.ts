import { hc } from 'hono/client';
import type { CatalogRoutes } from '@ams/api';
import type {
  CatalogEdition, CatalogEditions, CatalogSnapshot, CatalogVersion, CatalogVersionSummary, CatalogSettings, Concentration, CreateConcentration, CreateGenedArea, CreateStudySlot, GenedArea, GenedOverview, ProgramBlock, ProgramRequirements, SetProgramBlock, StudySlot,
  UpdateConcentration, UpdateGenedArea, UpdateStudySlot,
} from '@ams/shared';
import { noteResponse } from './undo';
import { unwrap } from './framework-api';

/** The catalog's structure (DEC-046): General Education, concentrations, block credits, elective slots and a program's requirements (CatalogRoutes, see the API's app.ts). */
export function catalogApi(fetcher: typeof fetch = fetch) {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetcher(input, { ...init, credentials: 'include' });
    noteResponse(res, fetcher, init?.method ?? 'GET');
    return res;
  }) as typeof fetch;
  const a = hc<CatalogRoutes>('/', { fetch: wrapped }).api;
  return {
    gened: () => a.catalog.gened.$get().then((r) => unwrap<GenedOverview>(r)),
    setSettings: (json: CatalogSettings) => a.catalog.settings.$put({ json }).then((r) => unwrap<CatalogSettings>(r)),
    createArea: (json: CreateGenedArea) => a.catalog.gened.areas.$post({ json }).then((r) => unwrap<GenedArea>(r)),
    updateArea: (id: string, json: UpdateGenedArea) => a.catalog.gened.areas[':id'].$patch({ param: { id }, json }).then((r) => unwrap<GenedArea>(r)),
    deleteArea: (id: string) => a.catalog.gened.areas[':id'].$delete({ param: { id } }).then((r) => unwrap<{ deleted: boolean }>(r)),
    setAreaCourses: (id: string, courseIds: string[]) => a.catalog.gened.areas[':id'].courses.$put({ param: { id }, json: { courseIds } }).then((r) => unwrap<GenedArea>(r)),
    editions: () => a.catalog.editions.$get().then((r) => unwrap<CatalogEditions>(r)),
    startEdition: (label: string) => a.catalog.editions.$post({ json: { label } }).then((r) => unwrap<CatalogEdition>(r)),
    publish: (note?: string | null) => a.catalog.versions.$post({ json: { note: note ?? null } }).then((r) => unwrap<CatalogVersionSummary>(r)),
    version: (id: string) => a.catalog.versions[':id'].$get({ param: { id } }).then((r) => unwrap<CatalogVersion>(r)),
    preview: () => a.catalog.preview.$get().then((r) => unwrap<CatalogSnapshot>(r)),
    requirements: (programId: string) => a.programs[':id'].requirements.$get({ param: { id: programId } }).then((r) => unwrap<ProgramRequirements>(r)),
    createConcentration: (json: CreateConcentration) => a.concentrations.$post({ json }).then((r) => unwrap<Concentration>(r)),
    updateConcentration: (id: string, json: UpdateConcentration) => a.concentrations[':id'].$patch({ param: { id }, json }).then((r) => unwrap<Concentration>(r)),
    deleteConcentration: (id: string) => a.concentrations[':id'].$delete({ param: { id } }).then((r) => unwrap<{ deleted: boolean; concentration: Concentration }>(r)),
    setBlock: (json: SetProgramBlock) => a['program-blocks'].$put({ json }).then((r) => unwrap<ProgramBlock | null>(r)),
    createSlot: (json: CreateStudySlot) => a['study-slots'].$post({ json }).then((r) => unwrap<StudySlot>(r)),
    updateSlot: (id: string, json: UpdateStudySlot) => a['study-slots'][':id'].$patch({ param: { id }, json }).then((r) => unwrap<StudySlot>(r)),
    deleteSlot: (id: string) => a['study-slots'][':id'].$delete({ param: { id } }).then((r) => unwrap<{ deleted: boolean }>(r)),
  };
}
export type CatalogApi = ReturnType<typeof catalogApi>;
let defaultApi: CatalogApi | null = null;
export const useCatalogApi = (override?: CatalogApi) => override ?? (defaultApi ??= catalogApi());
