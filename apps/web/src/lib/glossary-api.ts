import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CreateTerm, ExternalStandard, Glossary, SetAlias, UpdateTerm, GlossaryTerm } from '@ams/shared';
import { api as defaultApi } from './api';
import { unwrap, type Api } from './framework-api';

/** Glossary calls, through the typed client. */
export function glossaryApi(api: Api = defaultApi) {
  const g = api.api.glossary;
  return {
    glossary: () => g.$get().then((r) => unwrap<Glossary>(r)),
    externalTerms: () => g['external-terms'].$get().then((r) => unwrap<ExternalStandard[]>(r)),
    seedDefaults: () => g['seed-defaults'].$post().then((r) => unwrap<{ added: number }>(r)),
    createTerm: (json: CreateTerm) => g.terms.$post({ json }).then((r) => unwrap<GlossaryTerm>(r)),
    updateTerm: (id: string, json: UpdateTerm) => g.terms[':id'].$patch({ param: { id }, json }).then((r) => unwrap<GlossaryTerm>(r)),
    setAlias: (json: SetAlias) => g.aliases.$put({ json }).then((r) => unwrap<void>(r)),
    autoMap: (frameworkId?: string) => g['auto-map'].$post({ json: frameworkId ? { frameworkId } : {} }).then((r) => unwrap<{ mapped: number }>(r)),
  };
}
export type GlossaryApi = ReturnType<typeof glossaryApi>;
export const defaultGlossaryApi = glossaryApi();
export const useGlossaryApi = (override?: GlossaryApi) => override ?? defaultGlossaryApi;

/** How terms are shown on engagement screens: the institution's word, the standard's own, or both (DEC-016). Remembered per viewer. */
export type TermMode = 'internal' | 'standard' | 'both';
const KEY = 'ams.termMode';
const read = (): TermMode => { try { const v = localStorage.getItem(KEY); return v === 'internal' || v === 'standard' || v === 'both' ? v : 'both'; } catch { return 'both'; } };

export function useTermMode(): [TermMode, (m: TermMode) => void] {
  const [mode, setMode] = useState<TermMode>(read);
  useEffect(() => {
    const onStorage = () => setMode(read());
    window.addEventListener('storage', onStorage);
    window.addEventListener('ams-term-mode', onStorage);
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('ams-term-mode', onStorage); };
  }, []);
  const set = useCallback((m: TermMode) => {
    try { localStorage.setItem(KEY, m); } catch { /* private window: the choice lasts for this page only */ }
    setMode(m);
    window.dispatchEvent(new Event('ams-term-mode'));
  }, []);
  return [mode, set];
}

/** The institution's word for a standard's level name, by the mapping; the standard's own word when there is none. */
export function useLevelLabel(api: Pick<GlossaryApi, 'glossary'>) {
  const { data } = useQuery({ queryKey: ['glossary'], queryFn: () => api.glossary(), staleTime: 60_000 });
  const [mode] = useTermMode();
  const lookup = useMemo(() => {
    const terms = new Map((data?.terms ?? []).map((t) => [t.id, t]));
    return new Map((data?.aliases ?? []).filter((x) => x.source === 'level_label').map((x) => [`${x.frameworkId}|${x.externalTerm}`, terms.get(x.termId)?.labelEn]));
  }, [data]);
  return useCallback((frameworkId: string, external: string): string => {
    const internal = lookup.get(`${frameworkId}|${external}`);
    if (!internal || mode === 'standard') return external;
    if (mode === 'internal') return internal;
    return internal === external ? internal : `${internal} · ${external}`;
  }, [lookup, mode]);
}
