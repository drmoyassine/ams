/** Where a page sits: links to each level above it, then the page itself (not a link). */
export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((it, i) => (
          <li key={i} className="flex min-w-0 items-center gap-1">
            {i > 0 && <span aria-hidden="true">›</span>}
            {it.href && i < items.length - 1 ? <a className="underline-offset-2 hover:text-foreground hover:underline" href={it.href}>{it.label}</a>
              : <span className="truncate font-medium text-foreground" aria-current={i === items.length - 1 ? 'page' : undefined}>{it.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
