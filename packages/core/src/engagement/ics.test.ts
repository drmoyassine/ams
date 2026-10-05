import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember } from './engagements.js';
import { updateMilestone } from './roadmap.js';
import { getEngagement } from './engagements.js';
import { buildIcs, engagementCalendar, fold } from './ics.js';
import { buildWorld, type World } from './test-support.js';

const stamp = new Date('2027-01-05T09:30:15.123Z');

describe('iCalendar builder', () => {
  it('writes an all-day event with an exclusive end date, CRLF endings and a stable uid', () => {
    const ics = buildIcs('Roadmap', [{ uid: 'milestone-1@ams', date: '2027-12-31', summary: 'Submit report', modified: stamp }]);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.split('\r\n').slice(0, -1)).toEqual([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AMS//Engagement roadmap//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Roadmap',
      'BEGIN:VEVENT', 'UID:milestone-1@ams', 'DTSTAMP:20270105T093015Z', 'LAST-MODIFIED:20270105T093015Z',
      'DTSTART;VALUE=DATE:20271231', 'DTEND;VALUE=DATE:20280101', 'SUMMARY:Submit report', 'STATUS:CONFIRMED', 'TRANSP:TRANSPARENT', 'END:VEVENT',
      'END:VCALENDAR',
    ]);
  });

  it('escapes text and marks skipped milestones cancelled', () => {
    const ics = buildIcs('A, B; C', [{ uid: 'u@ams', date: '2027-02-28', summary: 'Pay fee, then file; done', description: 'Line one\nLine two \\ end', category: 'Review', cancelled: true, modified: stamp }]);
    expect(ics).toContain('X-WR-CALNAME:A\\, B\\; C');
    expect(ics).toContain('SUMMARY:Pay fee\\, then file\\; done');
    expect(ics).toContain('DESCRIPTION:Line one\\nLine two \\\\ end');
    expect(ics).toContain('CATEGORIES:Review');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('DTEND;VALUE=DATE:20270301');
  });

  it('folds long lines at 75 octets without splitting a character, and unfolding restores the line', () => {
    const long = `SUMMARY:${'مرحبا بالعالم '.repeat(20)}`;
    const folded = fold(long);
    expect(folded.length).toBeGreaterThan(2);
    for (const l of folded) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    expect(folded.map((l, i) => (i === 0 ? l : l.slice(1))).join('')).toBe(long);
    expect(fold('SHORT')).toEqual(['SHORT']);
  });

  it('is deterministic', () => {
    const ev = { uid: 'u@ams', date: '2027-02-28', summary: 'x', modified: stamp };
    expect(buildIcs('n', [ev, ev])).toBe(buildIcs('n', [ev, ev]));
  });
});

describe('engagement calendar', () => {
  let w: World;
  let eng: string;
  beforeAll(async () => {
    w = await buildWorld('ics');
    eng = (await w.create('coord', { subjectType: 'program', subjectId: w.ids.mech!, kind: 'initial' })).engagement.id;
    await w.as('coord', (ctx) => addMember(ctx, eng, { userId: w.ids.contrib!, role: 'contributor' }));
  }, 60000);
  afterAll(() => w.close());

  it('exports the milestones that have dates, once each, with stable uids', async () => {
    const d = await w.as('coord', (ctx) => getEngagement(ctx, eng));
    const { filename, ics } = await w.as('contrib', (ctx) => engagementCalendar(ctx, eng));
    expect(filename).toMatch(/^ABET-.*2027-BS-Mechanical-Engineering\.ics$/);
    const dated = d.milestones.filter((m) => m.dueDate);
    expect(dated.length).toBeGreaterThan(10);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(dated.length);
    expect(ics).not.toContain('on_site_visit'); // no date yet, so omitted
    const ssr = d.milestones.find((m) => m.templateKey === 'ssr_submit')!;
    expect(ics.replace(/\r\n /g, '')).toContain(`UID:milestone-${ssr.id}@ams`);
    expect(ics).toContain('DTSTART;VALUE=DATE:20270701');
    expect(await w.as('coord', (ctx) => engagementCalendar(ctx, eng))).toEqual({ filename, ics });
  });

  it('exports a skipped milestone as cancelled', async () => {
    const m = (await w.as('coord', (ctx) => getEngagement(ctx, eng))).milestones.find((x) => x.templateKey === 'rrev_fee')!;
    await w.as('coord', (ctx) => updateMilestone(ctx, m.id, { status: 'skipped', skipReason: 'Waived' }));
    const { ics } = await w.as('coord', (ctx) => engagementCalendar(ctx, eng));
    const event = ics.replace(/\r\n /g, '').split('BEGIN:VEVENT').find((e) => e.includes(`milestone-${m.id}@ams`))!;
    expect(event).toContain('STATUS:CANCELLED');
  });

  it('is refused to people who cannot see the engagement', async () => {
    await expect(w.as('outsider', (ctx) => engagementCalendar(ctx, eng))).rejects.toThrow();
  });
});
