// Calendar export of an engagement's milestones (PRD 8.2): iCalendar, RFC 5545, all-day events. Standards only (DEC-008).
// Deterministic: the same roadmap gives the same bytes, and UIDs are stable so re-importing updates events in place.
import { asc, eq } from 'drizzle-orm';
import { milestone } from '@ams/db';
import type { Ctx } from '../ctx.js';
import { assertPermitted } from '../permissions.js';
import { getEngagementRow } from './common.js';
import { addDays } from './dates.js';

export interface IcsEvent {
  uid: string;
  /** All-day event on this date (YYYY-MM-DD). */
  date: string;
  summary: string;
  description?: string;
  category?: string;
  cancelled?: boolean;
  /** Last change, UTC; used for DTSTAMP and LAST-MODIFIED so the output does not depend on when it was made. */
  modified: Date;
}

const utc = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const day = (iso: string) => iso.replace(/-/g, '');
const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Folds a content line at 75 octets (never inside a multi-byte character) with CRLF + space, per RFC 5545 3.1. */
export function fold(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + n > limit) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.map((l, i) => (i === 0 ? l : ` ${l}`));
}

export function buildIcs(calendarName: string, events: readonly IcsEvent[]): string {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AMS//Engagement roadmap//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${utc(e.modified)}`,
      `LAST-MODIFIED:${utc(e.modified)}`,
      `DTSTART;VALUE=DATE:${day(e.date)}`,
      `DTEND;VALUE=DATE:${day(addDays(e.date, 1))}`,
      `SUMMARY:${escapeText(e.summary)}`,
      ...(e.description ? [`DESCRIPTION:${escapeText(e.description)}`] : []),
      ...(e.category ? [`CATEGORIES:${escapeText(e.category)}`] : []),
      `STATUS:${e.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.flatMap(fold).join('\r\n')}\r\n`;
}

const PHASE_LABEL: Record<string, string> = {
  eligibility: 'Eligibility', self_study: 'Self-study', review: 'Review', decision: 'Decision', maintenance: 'Maintenance',
};

/** The engagement's milestones that have a due date, as a calendar file. Skipped milestones are exported as cancelled. */
export async function engagementCalendar(ctx: Ctx, engagementId: string): Promise<{ filename: string; ics: string }> {
  await assertPermitted(ctx, 'engagement:read', { type: 'any' });
  const e = await getEngagementRow(ctx, engagementId);
  const rows = await ctx.tx.select().from(milestone).where(eq(milestone.engagementId, engagementId)).orderBy(asc(milestone.dueDate), asc(milestone.displayOrder));
  const events: IcsEvent[] = rows.filter((m) => m.dueDate).map((m) => ({
    uid: `milestone-${m.id}@ams`,
    date: m.dueDate!,
    summary: m.name,
    description: [`${PHASE_LABEL[m.phase] ?? m.phase} phase`, `Status: ${m.status.replace(/_/g, ' ')}`, m.description ?? '', m.required ? '' : 'Optional'].filter(Boolean).join('\n'),
    category: PHASE_LABEL[m.phase] ?? m.phase,
    cancelled: m.status === 'skipped',
    modified: m.updatedAt,
  }));
  const safe = e.title.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'engagement';
  return { filename: `${safe}.ics`, ics: buildIcs(e.title, events) };
}
