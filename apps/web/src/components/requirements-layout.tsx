import type { ReactNode } from 'react';

/**
 * The layout of a standard's requirements, shared by the institution's own quality framework (Settings -> Internal Quality
 * Framework) and by an external standard's page, so both have the same width and the same shape: the requirements tree on the
 * left, and from 1280px up a detail panel on the right (the source of the selected requirement, or the selected standard's
 * description and evidence). Below that the tree takes the full width and the detail opens where it is needed (a card, a
 * bottom sheet). The classes are exported so a test can hold the two pages to the same ones.
 */
export const SPLIT_CLASS = 'grid grid-cols-[minmax(0,1fr)_minmax(0,22rem)] items-start gap-4';
export const SPLIT_LIST_CLASS = 'max-h-[calc(100dvh-15rem)] min-w-0 overflow-y-auto pe-2';
export const SPLIT_ASIDE_CLASS = 'sticky top-2 max-h-[calc(100dvh-15rem)] min-w-0 overflow-y-auto rounded-lg border border-border p-3';

export function RequirementsLayout({ wide, list, aside, asideLabel, listTestId = 'requirement-list', asideTestId = 'detail-panel' }: {
  /** From 1280px up: the detail panel sits beside the tree. */
  wide: boolean; list: ReactNode; aside: ReactNode; asideLabel: string; listTestId?: string; asideTestId?: string;
}) {
  if (!wide) return <>{list}</>;
  return (
    <div className={SPLIT_CLASS} data-testid="requirements-layout">
      <div className={SPLIT_LIST_CLASS} data-testid={listTestId}>{list}</div>
      <aside aria-label={asideLabel} className={SPLIT_ASIDE_CLASS} data-testid={asideTestId}>{aside}</aside>
    </div>
  );
}
