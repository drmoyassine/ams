import type { ReactNode } from 'react';

/**
 * The layout of a standard's requirements, shared by the institution's own quality framework (Settings -> Internal Quality
 * Framework) and by an external standard's page, so both have the same width and the same shape: the requirements tree takes the
 * full width of the page. There is no side panel: what a requirement shows (description, mapped IQF items, evidence) is in its card
 * and its hover card, and its source opens from the menu in a sheet. The class is exported so a test can hold the two pages to it.
 */
export const LAYOUT_CLASS = 'min-w-0';

export function RequirementsLayout({ list, listTestId = 'requirement-list' }: { list: ReactNode; listTestId?: string }) {
  return (
    <div className={LAYOUT_CLASS} data-testid="requirements-layout">
      <div className="min-w-0" data-testid={listTestId}>{list}</div>
    </div>
  );
}
