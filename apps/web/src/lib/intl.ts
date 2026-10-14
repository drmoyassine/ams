// Dates, times, numbers and sizes through Intl with the language the interface is in now (TASK-070). Never a hard-coded
// 'en' / 'en-GB': a person using the secondary language sees their own conventions. The formatter is made per call (cheap,
// and the interface language can change while a page is open).
import { activeLocale } from './language';

const toDate = (v: string | number | Date) => (v instanceof Date ? v : new Date(v));

/** "5 Oct 2026" */
export const formatDate = (v: string | number | Date, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Intl.DateTimeFormat(activeLocale(), options).format(toDate(v));

/** "5 Oct 2026, 14:30" */
export const formatDateTime = (v: string | number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) =>
  new Intl.DateTimeFormat(activeLocale(), options).format(toDate(v));

export const formatNumber = (n: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(activeLocale(), options).format(n);

/** "512 B", "3 KB", "1.5 MB" with the digits of the active language. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${formatNumber(n)} B`;
  if (n < 1048576) return `${formatNumber(Math.max(1, Math.round(n / 1024)))} KB`;
  return `${formatNumber(n / 1048576, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB`;
}
