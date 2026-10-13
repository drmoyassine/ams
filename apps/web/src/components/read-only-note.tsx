/** The one line shown on a Settings page (or section) the signed-in person can read but not change. */
export const READ_ONLY_TEXT = 'You can view this; ask an administrator to change it.';

export function ReadOnlyNote({ show, className = '' }: { show: boolean; className?: string }) {
  if (!show) return null;
  return <p role="note" data-testid="read-only-note" className={`text-sm text-muted-foreground ${className}`}>{READ_ONLY_TEXT}</p>;
}
