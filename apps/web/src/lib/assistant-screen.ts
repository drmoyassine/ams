// What the assistant is told about the screen (its "context chips") and how it opens things for the person. A screen PUBLISHES
// what it shows ("I am the IC 2025 version page, on the Requirements tab, with 3 items selected") through usePublishScreen;
// the assistant panel reads the merged result. The store lives outside React state so a tree whose selection changes on every
// click does not re-render the page around it. Screens also REGISTER how to open a requirement or a source page in place
// (the version page's own showRequirement / showPage), so a link in the chat does not reload what the person is looking at.
import { useEffect, useSyncExternalStore } from 'react';
import { ASSISTANT_MAX_SELECTED } from '@ams/shared';

export interface ScreenContext {
  route?: string;
  routeLabel?: string;
  versionId?: string;
  versionLabel?: string;
  engagementId?: string;
  engagementLabel?: string;
  tab?: string;
  tabLabel?: string;
  selectedIds?: string[];
}

const parts = new Map<string, Partial<ScreenContext>>();
let snapshot: ScreenContext = {};
const listeners = new Set<() => void>();

function merge(): ScreenContext {
  const out: ScreenContext = {};
  const ids = new Set<string>();
  for (const p of parts.values()) {
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || k === 'selectedIds') continue;
      (out as Record<string, unknown>)[k] = v;
    }
    for (const id of p.selectedIds ?? []) ids.add(id);
  }
  if (ids.size) out.selectedIds = [...ids].slice(0, ASSISTANT_MAX_SELECTED);
  return out;
}

/** Sets (or, with null, removes) what one screen part knows. Parts are merged in the order they first published; later ones win. */
export function publishScreen(owner: string, part: Partial<ScreenContext> | null): void {
  if (part === null) parts.delete(owner); else parts.set(owner, part);
  const next = merge();
  if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
  snapshot = next;
  for (const l of listeners) l();
}
export const getScreen = (): ScreenContext => snapshot;
export const subscribeScreen = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useScreen = (): ScreenContext => useSyncExternalStore(subscribeScreen, getScreen, getScreen);
export function resetScreenForTests(): void { parts.clear(); navs.clear(); snapshot = {}; for (const l of listeners) l(); }

/** A screen part that publishes while it is mounted. `part` is compared by value, so passing a fresh object each render is fine. */
export function usePublishScreen(owner: string, part: Partial<ScreenContext> | null): void {
  const key = JSON.stringify(part);
  useEffect(() => {
    publishScreen(owner, key === 'null' ? null : (JSON.parse(key) as Partial<ScreenContext>));
    return () => publishScreen(owner, null);
  }, [owner, key]);
}

// ---- Opening things in place --------------------------------------------------------------------------------------------
export interface AssistantNav {
  showRequirement(id: string): void;
  showPage(documentId: string, page: number): void;
}
const navs = new Map<string, AssistantNav>();

/** A version page registers how to open a requirement or a source page of ITS version without leaving. */
export function registerAssistantNav(versionId: string, nav: AssistantNav): () => void {
  navs.set(versionId, nav);
  return () => { if (navs.get(versionId) === nav) navs.delete(versionId); };
}
export const navFor = (versionId: string): AssistantNav | undefined => navs.get(versionId);

// ---- Chips ---------------------------------------------------------------------------------------------------------------
export type ChipId = 'version' | 'tab' | 'selection' | 'engagement' | 'route';
export interface Chip { id: ChipId; label: string }

/** The plain-words name of a Settings page, for the page chip. */
const ROUTE_LABELS: [RegExp, string][] = [
  [/^\/settings\/organization/, 'Settings · Organization'], [/^\/settings\/programs/, 'Settings · Programs'],
  [/^\/settings\/quality-framework/, 'Settings · Internal Quality Framework'], [/^\/settings\/external-standards/, 'Settings · External Standards'],
  [/^\/settings\/ai/, 'Settings · AI'], [/^\/settings\/trash/, 'Settings · Trash'], [/^\/settings\/assistant-memory/, 'Settings · Assistant memory'],
  [/^\/engagements\/new/, 'New engagement'], [/^\/engagements/, 'Engagements'], [/^\/engagement-requirements/, 'A requirement of an engagement'],
  [/^\/evidence/, 'Evidence'], [/^\/requests/, 'My requests'],
];
export const routeLabelOf = (pathname: string): string | undefined => ROUTE_LABELS.find(([re]) => re.test(pathname))?.[1];

/** The chips the person sees, from what the screen published, minus the ones they removed. Removing the version drops its tab and selection. */
export function chipsFor(screen: ScreenContext, removed: ReadonlySet<ChipId>): Chip[] {
  const chips: Chip[] = [];
  if (screen.versionId && !removed.has('version')) {
    chips.push({ id: 'version', label: `Working on ${screen.versionLabel ?? 'this version'}` });
    if (screen.tabLabel && !removed.has('tab')) chips.push({ id: 'tab', label: screen.tabLabel });
    if (screen.selectedIds?.length && !removed.has('selection')) chips.push({ id: 'selection', label: `${screen.selectedIds.length} selected` });
  } else if (screen.engagementId && !removed.has('engagement')) {
    chips.push({ id: 'engagement', label: `Engagement: ${screen.engagementLabel ?? 'this one'}` });
  } else if (!screen.versionId && !screen.engagementId && screen.routeLabel && !removed.has('route')) {
    chips.push({ id: 'route', label: screen.routeLabel });
  }
  return chips;
}

/** What is sent with a message: only what the chips still show. */
export function contextFor(screen: ScreenContext, chips: readonly Chip[]): { versionId?: string; engagementId?: string; tab?: string; selectedIds?: string[]; route?: string } | undefined {
  const has = (id: ChipId) => chips.some((c) => c.id === id);
  const out: { versionId?: string; engagementId?: string; tab?: string; selectedIds?: string[]; route?: string } = {};
  if (has('version') && screen.versionId) {
    out.versionId = screen.versionId;
    if (has('tab') && screen.tab) out.tab = screen.tab;
    if (has('selection') && screen.selectedIds?.length) out.selectedIds = screen.selectedIds;
  }
  if (has('engagement') && screen.engagementId) out.engagementId = screen.engagementId;
  if (chips.length > 0 && screen.route && screen.route.startsWith('/')) out.route = screen.route;
  return Object.keys(out).length ? out : undefined;
}
