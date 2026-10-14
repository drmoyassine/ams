// The CONTENT language switcher's shared hook (skeleton; TASK-070 provides it, TASK-071 wires it to the library screens).
//
// The interface language (menu in the header) is one thing; which language the LIBRARY CONTENT is shown in (the IQF,
// external standards, the glossary) is another: a person may use the Arabic interface and still want to read a standard in
// its original wording. Three choices:
//   original   the text as it was written (the accreditor's own words for a standard)
//   en         English
//   secondary  the institution's secondary language (from content_translation, TASK-071)
// A text with no translation in the chosen language falls back to English, and the caller is told so (`fellBack`), so the
// screen can say "shown in English: not translated yet" instead of silently mixing languages.
//
// Storage today: the person's choice for this browser session (sessionStorage, optional). TASK-071 stores it with the UI
// preference on the person (app_user) so it follows them; the hook's contract does not change.
import { useCallback, useSyncExternalStore } from 'react';

export const CONTENT_LANGUAGES = ['original', 'en', 'secondary'] as const;
export type ContentLanguage = (typeof CONTENT_LANGUAGES)[number];
const KEY = 'ams.contentLanguage';
const listeners = new Set<() => void>();
let memory: ContentLanguage = 'original';

const isMode = (v: unknown): v is ContentLanguage => (CONTENT_LANGUAGES as readonly unknown[]).includes(v);
function read(): ContentLanguage {
  try { const v = window.sessionStorage.getItem(KEY); if (isMode(v)) return v; } catch { /* storage blocked: the in-memory value is used */ }
  return memory;
}
function write(mode: ContentLanguage) {
  memory = mode;
  try { window.sessionStorage.setItem(KEY, mode); } catch { /* optional */ }
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** What a piece of content looks like in each language it has; absent or empty means "not available in that language". */
export interface ContentVariants { original?: string | null; en?: string | null; secondary?: string | null }
export interface ResolvedContent {
  text: string;
  /** Which variant is being shown. */
  shown: ContentLanguage;
  /** The person asked for another one and this is the fallback (English, else the original). */
  fellBack: boolean;
}

/** Picks the text to show for a mode. Pure, so TASK-071 and its tests can use it without React. */
export function resolveContent(v: ContentVariants, mode: ContentLanguage): ResolvedContent {
  const has = (s: string | null | undefined): s is string => !!s && s.trim() !== '';
  if (has(v[mode])) return { text: v[mode], shown: mode, fellBack: false };
  if (has(v.en)) return { text: v.en, shown: 'en', fellBack: true };
  if (has(v.original)) return { text: v.original, shown: 'original', fellBack: true };
  return { text: '', shown: mode, fellBack: true };
}

export function useContentLanguage() {
  const mode = useSyncExternalStore(subscribe, read, () => 'original' as ContentLanguage);
  const setMode = useCallback((next: ContentLanguage) => write(next), []);
  const resolve = useCallback((v: ContentVariants) => resolveContent(v, mode), [mode]);
  return { mode, setMode, resolve };
}

/** Tests: back to the default. */
export function resetContentLanguageForTests() { write('original'); }
