import type { HTMLAttributes } from 'react';

/** Institutional content (names, titles, quotes) can be Arabic or English: let the browser pick the direction. */
export function ContentText(props: HTMLAttributes<HTMLSpanElement>) {
  return <span dir="auto" {...props} />;
}
