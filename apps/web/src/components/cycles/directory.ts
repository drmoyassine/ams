// What the cycle screens need to name and choose people and org units, and the api set they share (so tests can hand each screen the
// clients of the signed-in test person). Units and programs come from the scope items (the active ones); a unit or person that is
// no longer listed is still shown by the name the cycle carries.
import { useQuery } from '@tanstack/react-query';
import type { ScopeItem, UserSummary } from '@ams/shared';
import type { CyclesApi } from '../../lib/cycles-api';
import type { DocumentsApi } from '../../lib/documents-api';
import type { EvidenceApi } from '../../lib/evidence-api';
import type { FrameworkApi } from '../../lib/framework-api';
import { useScopeApi, type ScopeApi } from '../../lib/scope-api';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';

/** The clients the cycle screens use; each defaults to the app's own. */
export interface CycleApis { cycles?: CyclesApi; settings?: SettingsApi; scope?: ScopeApi; evidence?: EvidenceApi; documents?: DocumentsApi; framework?: FrameworkApi }

export interface Directory {
  people: UserSummary[]; units: ScopeItem[]; programs: ScopeItem[];
  personName: (id: string | null | undefined) => string | null;
}

export function useDirectory(apis: CycleApis = {}): Directory {
  const settings = useSettingsApi(apis.settings);
  const scope = useScopeApi(apis.scope);
  const people = useQuery({ queryKey: ['people'], queryFn: () => settings.people(), staleTime: 60_000 });
  const items = useQuery({ queryKey: ['scope-items'], queryFn: () => scope.items(), staleTime: 60_000 });
  const list = people.data ?? [];
  return {
    people: list, units: items.data?.orgUnit ?? [], programs: items.data?.program ?? [],
    personName: (id) => (id ? (list.find((p) => p.id === id)?.fullName ?? null) : null),
  };
}
