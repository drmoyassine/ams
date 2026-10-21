// How an evidence item is collected and when (TASK-089, DEC-031): the chips on the closed card (method, schedule, next due) and the
// Collection section of the open one: the settings are read only here (edited in "Edit details"), and its runs are listed below them (TASK-090):
// one for each period of the schedule, with Run now, Retry and Skip. A "Late" or "Failed" chip tells the library which items need a look.
import type { EvidenceItem } from '@ams/shared';
import { useTranslation } from '../i18n';
import { useEvidenceApi } from '../lib/evidence-api';
import { Shaded } from './accordion';
import { BiNotConfigured, CollectionRuns, useCollectionConfig } from './collection-runs';
import { ContentText } from './content-text';
import { useDirectory, type CycleApis } from './cycles/directory';
import { EVERY_LABEL, METHOD_LABEL } from './evidence-item-form';

const DAY = (tz: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
const cfg = (item: EvidenceItem) => item.methodConfig as Record<string, unknown>;
const text = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** The day the next collection is due, as a person in the schedule's time zone reads it (the stored instant is the end of that day). */
export function nextDueDay(item: Pick<EvidenceItem, 'nextDueAt' | 'schedule'>): string | null {
  if (!item.nextDueAt) return null;
  const tz = item.schedule?.timezone ?? 'UTC';
  try { return DAY(tz).format(new Date(Date.parse(item.nextDueAt) - 1)); } catch { return DAY('UTC').format(new Date(Date.parse(item.nextDueAt) - 1)); }
}

/** "Every month", or null without a schedule. */
export const scheduleText = (item: Pick<EvidenceItem, 'schedule'>): string | null => (item.schedule ? EVERY_LABEL[item.schedule.every] : null);

const chip = 'rounded px-1.5 py-0.5';
/** The chips of the closed card: how it is collected, how often, and the next due date. */
export function CollectionChips({ item }: { item: EvidenceItem }) {
  const { t } = useTranslation();
  const due = nextDueDay(item);
  return (
    <>
      {(item.runCounts?.late ?? 0) > 0 && <span className={`${chip} bg-amber-50 text-amber-900`} data-testid="evidence-late">{t('coll.chip.late')}</span>}
      {(item.runCounts?.failed ?? 0) > 0 && <span className={`${chip} bg-red-50 text-red-900`} data-testid="evidence-failed">{t('coll.chip.failed')}</span>}
      <span className={`${chip} bg-muted`} data-testid="evidence-method">{METHOD_LABEL[item.method]}</span>
      {item.schedule && <span className={`${chip} bg-muted`} data-testid="evidence-schedule">{scheduleText(item)}</span>}
      {item.schedule && due && <span className={`${chip} bg-muted`} data-testid="evidence-next-due">Next due {due}</span>}
      {item.scheduleGap === 'no_term' && <span className={`${chip} bg-amber-50 text-amber-900`} data-testid="evidence-schedule-gap">No term defined</span>}
    </>
  );
}

function Row({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return <div className="flex min-w-0 gap-1" {...(testId ? { 'data-testid': testId } : {})}><dt className="shrink-0 text-muted-foreground">{label}:</dt><dd className="min-w-0 break-words">{children}</dd></div>;
}

/** The open card's Collection section: the method with its settings, the schedule, the next due date, the owner. */
export function CollectionSection({ item, apis, canWrite = false }: { item: EvidenceItem; apis?: CycleApis | undefined; canWrite?: boolean }) {
  const dir = useDirectory(apis);
  const config = useCollectionConfig(useEvidenceApi(apis?.evidence), item.method === 'bi');
  const c = cfg(item);
  const query = (c.query ?? {}) as { metric?: string; dimensions?: string[] };
  const s = item.schedule;
  const due = nextDueDay(item);
  const last = item.lastRunAt ? DAY(s?.timezone ?? 'UTC').format(new Date(item.lastRunAt)) : null;
  return (
    <section aria-label="Collection" className="space-y-2" data-testid="collection-section">
      <Shaded>Collection</Shaded>
      <dl className="grid gap-x-5 gap-y-1 text-sm sm:grid-cols-2">
        <Row label="Method" testId="collection-method">{METHOD_LABEL[item.method]}{item.method === 'survey' ? ' (coming)' : ''}</Row>
        {item.method === 'manual' && text(c.instructions) && <Row label="Instructions"><ContentText>{text(c.instructions)}</ContentText></Row>}
        {item.method === 'manual' && text(c.expectedFormat) && <Row label="Expected format"><ContentText>{text(c.expectedFormat)}</ContentText></Row>}
        {item.method === 'form' && <Row label="Collected by">the dataset’s online form and spreadsheet template</Row>}
        {item.method === 'request' && (
          <Row label="Ask">{text(c.assigneeEmail) ?? (dir.personName(text(c.assigneeUserId)) ?? 'a person in the AMS')}</Row>
        )}
        {item.method === 'request' && text(c.note) && <Row label="Note"><ContentText>{text(c.note)}</ContentText></Row>}
        {item.method === 'bi' && <Row label="BI endpoint">{text(c.endpointKey) ?? 'the default'}</Row>}
        {item.method === 'bi' && query.metric && <Row label="Metric">{query.metric}{query.dimensions?.length ? ` by ${query.dimensions.join(', ')}` : ''}</Row>}
        {item.method === 'bi' && text(c.period) && <Row label="Period">{String(c.period)}</Row>}
        {item.method === 'bi' && typeof c.timeoutSeconds === 'number' && <Row label="Waits">{c.timeoutSeconds} seconds</Row>}
        <Row label="Schedule" testId="collection-schedule">{s ? `${scheduleText(item)} from ${s.startDate}, due ${s.dueAfterDays} ${s.dueAfterDays === 1 ? 'day' : 'days'} after it starts (${s.timezone})` : 'No schedule'}</Row>
        {s && <Row label="Next due" testId="collection-next-due">{due ?? (item.scheduleGap === 'no_term' ? 'not known' : 'none')}</Row>}
        {s && last && <Row label="Last run">{last}</Row>}
        <Row label="Owner">{item.ownerName ? <ContentText>{item.ownerName}</ContentText> : 'No owner'}</Row>
      </dl>
      {item.scheduleGap === 'no_term' && (
        <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="schedule-gap">
          The academic calendar has no term for the next semester, so the due date is not known. Add the terms in Settings, Organization; it is never guessed.
        </p>
      )}
      {item.method === 'bi' && config.data && !config.data.bi.configured && <BiNotConfigured />}
      <CollectionRuns item={item} canWrite={canWrite} apis={apis} />
    </section>
  );
}
