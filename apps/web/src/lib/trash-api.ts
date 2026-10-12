import type { RestoreOptions, RestoreResult, TrashContent, TrashGroup, TrashKind, TrashList } from '@ams/shared';
import { api as defaultApi } from './api';
import { unwrap, type Api } from './framework-api';

/** Trash calls (DEC-026), through the typed client. */
export function trashApi(api: Api = defaultApi) {
  return {
    list: (query: { kind?: TrashKind; q?: string } = {}) =>
      api.api.trash.$get({ query: { ...(query.kind ? { kind: query.kind } : {}), ...(query.q ? { q: query.q } : {}) } }).then((r) => unwrap<TrashList>(r)),
    count: () => api.api.trash.count.$get().then((r) => unwrap<{ count: number }>(r)),
    group: (groupId: string) => api.api.trash.groups[':groupId'].$get({ param: { groupId } }).then((r) => unwrap<{ group: TrashGroup; contents: TrashContent[] }>(r)),
    restoreGroup: (groupId: string, json: RestoreOptions = {}) => api.api.trash.groups[':groupId'].restore.$post({ param: { groupId }, json }).then((r) => unwrap<RestoreResult>(r)),
    deleteGroup: (groupId: string) => api.api.trash.groups[':groupId'].$delete({ param: { groupId } }).then((r) => unwrap<{ removed: number }>(r)),
    empty: () => api.api.trash.$delete().then((r) => unwrap<{ removed: number }>(r)),
  };
}
export type TrashApi = ReturnType<typeof trashApi>;
export const defaultTrashApi = trashApi();
export const useTrashApi = (override?: TrashApi) => override ?? defaultTrashApi;
