import { useQuery } from '@tanstack/react-query';
import type { Me } from '@ams/shared';
import { frameworkApi, type FrameworkApi } from './framework-api';

export const useApi = (override?: FrameworkApi) => override ?? defaultFrameworkApi;
const defaultFrameworkApi = frameworkApi();

export function useMe(api: FrameworkApi) {
  return useQuery({ queryKey: ['me'], queryFn: () => api.me(), staleTime: 60_000 });
}
export const can = (me: Me | undefined, permission: Me['permissions'][number]) => !!me?.permissions.includes(permission);
