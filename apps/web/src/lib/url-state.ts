import { useState, useSyncExternalStore } from 'react';
import { useRouter, type AnyRouter } from '@tanstack/react-router';

/**
 * A piece of "where you are" kept in the address (deep linking): `?<key>=<value>` on the current page, written with replace so the
 * back button is not filled with every click. The fallback value is left out of the address. `allowed` limits it to known values (an
 * unknown one reads as the fallback). Without a router (a screen rendered on its own) it is plain component state.
 *
 * Use it for navigation state: a tab, a sub-tab, a filter, the record that is open, the version picked. Not for short-lived actions
 * (an edit box, a confirmation): a link should land a colleague on the same view, not half-way through someone's edit.
 */
export function useUrlState<T extends string>(key: string, fallback: T, allowed?: readonly T[]): [T, (next: T) => void] {
  const router = useRouter({ warn: false }) as AnyRouter | null;
  const [own, setOwn] = useState<T>(fallback);
  const raw = useSyncExternalStore(
    (onChange) => (router ? router.subscribe('onResolved', onChange) : () => undefined),
    () => (router ? (router.state.location.search as Record<string, unknown>)[key] : undefined),
    () => undefined,
  );
  const known = (v: unknown): v is T => typeof v === 'string' && v !== '' && (!allowed || (allowed as readonly string[]).includes(v));
  const value = router ? (known(raw) ? raw : fallback) : own;
  const set = (next: T) => {
    if (!router) { setOwn(next); return; }
    const search = { ...(router.state.location.search as Record<string, unknown>) };
    if (next === fallback || next === '') delete search[key]; else search[key] = next;
    void router.navigate({ to: router.state.location.pathname, search, replace: true } as never);
  };
  return [value, set];
}

/** The same for a value that may be absent (an open record, a picked version): '' means none. */
export function useUrlId(key: string): [string, (next: string) => void] {
  return useUrlState<string>(key, '');
}
