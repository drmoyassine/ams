// Words for the syllabus vocabularies, in one place (the view, the editor and the list share them).
export { LABEL } from '@ams/shared';
import { LABEL } from '@ams/shared';
export const label = (v: string) => LABEL[v] ?? v;
/** The chip colours of a status. */
export const STATUS_TONE: Record<string, string> = {
  draft: 'bg-muted', in_review: 'bg-sky-50 text-sky-900', endorsed: 'bg-indigo-50 text-indigo-900', approved: 'bg-emerald-50 text-emerald-900', superseded: 'bg-muted text-muted-foreground',
};
export const LEVEL_NAME = (levels: { code: string; name: string }[], code: string) => levels.find((l) => l.code === code)?.name ?? code;
