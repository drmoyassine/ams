import { ContentText } from '../../components/content-text';

/** Where the analysis found an item (framework_version.config_found): the document, the page and the quote it relied on. */
export interface FoundRef { document?: string; page: number; quote: string; verified?: boolean }
export interface FoundEntry { runId?: string; at?: string; items?: Record<string, FoundRef & { sections?: Record<string, FoundRef> }> }

/** The part of a version's `configFound` for one configuration part, or undefined. Tolerates anything the server stored. */
export function foundOf(configFound: unknown, section: string): FoundEntry | undefined {
  const e = (configFound as Record<string, FoundEntry> | null | undefined)?.[section];
  return e && typeof e === 'object' ? e : undefined;
}
export const wasEdited = (configEdited: unknown, section: string): boolean => !!(configEdited as Record<string, boolean> | null | undefined)?.[section];

const where = (r: FoundRef) => `${r.document ? `${r.document}, ` : ''}page ${r.page}`;

/**
 * A small marker for items the analysis wrote into the configuration: "Found by the analysis · page N", with the source quote
 * a person can check. Editing goes on as before; once a person edits a part, the analysis leaves it as it is and this says so.
 */
export function FoundBy({ found, edited, label, summary }: { found: FoundEntry | undefined; edited: boolean; label: string; summary?: string }) {
  const items = Object.entries(found?.items ?? {});
  if (!found && !edited) return null;
  return (
    <div className="rounded bg-muted/40 px-2 py-1.5 text-xs" data-testid="found-by" aria-label={`${label}: where the analysis found it`}>
      {found && items.length > 0 && (
        <details>
          <summary className="cursor-pointer">
            Found by the analysis · {summary ?? (items.length === 1 ? where(items[0]![1]) : `${items.length} items, with their pages`)}
          </summary>
          <ul className="mt-1 space-y-1">
            {items.map(([key, ref]) => (
              <li key={key} className="min-w-0 break-words" data-testid="found-by-item">
                <code>{key.replace(/^phase:/, '')}</code> · {where(ref)}
                {ref.quote && <span className="block text-muted-foreground"><ContentText>{ref.quote}</ContentText>{ref.verified === false ? ' (quote not found on the page)' : ''}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {edited && <p className="text-muted-foreground">You have edited this; a new analysis leaves it as it is.</p>}
    </div>
  );
}
