import type { ReactNode } from 'react';

/** The head of a page: the title on the left and the page's main action on the right of the same row, then a muted line saying what the page is for. */
export function PageHeader({ title, action, intro }: { title: string; action?: ReactNode; intro?: ReactNode }) {
  return (
    <header className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 text-xl font-semibold sm:text-2xl">{title}</h1>
        {action}
      </div>
      {intro && <p className="text-sm text-muted-foreground">{intro}</p>}
    </header>
  );
}
