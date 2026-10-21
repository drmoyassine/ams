// The fields of an evidence item (TASK-089, DEC-031), shared by "New evidence" and "Edit details": Title, Type, Definition, Collection
// method with its own settings, Schedule, Owner. An item has ONE collection method: manual (the owner uploads, links or types it),
// the online form (datasets), a request to a named person or email address, or the BI; Survey is reserved and shown as coming.
// The schedule says when the item is due again; a job makes a run for each period and carries it out by the method (TASK-090).
import { useMemo, useState } from 'react';
import { SCHEDULE_EVERY, type BiQuery, type EvidenceItem, type EvidenceMethod, type ScheduleEvery } from '@ams/shared';
import { ApiError } from '../lib/framework-api';
import { useDirectory, type CycleApis } from './cycles/directory';
import { Input } from './ui/input';

export const METHOD_LABEL: Record<EvidenceMethod, string> = { manual: 'Manual', form: 'Online form', request: 'Request', bi: 'BI', survey: 'Survey' };
const METHOD_HELP: Record<EvidenceMethod, string> = {
  manual: 'The owner uploads a file, registers a link or types the data in.',
  form: 'People fill in the dataset’s online form, or return its spreadsheet template. The columns are set in the sheet once the dataset is saved.',
  request: 'Ask a named person, or an email address, to supply it.',
  bi: 'The BI supplies it, by the metric below, for each period.',
  survey: 'Coming: a survey will collect it.',
};
export const EVERY_LABEL: Record<ScheduleEvery, string> = { day: 'Every day', week: 'Every week', month: 'Every month', quarter: 'Every quarter', semester: 'Every semester', year: 'Every year' };

export interface ItemDraft {
  title: string; type: EvidenceItem['type']; definition: string; ownerUserId: string;
  method: EvidenceMethod;
  instructions: string; expectedFormat: string;
  askKind: 'person' | 'email'; assigneeUserId: string; assigneeEmail: string; requestNote: string;
  endpointKey: string; metric: string; dimensions: string; period: '' | ScheduleEvery; timeoutSeconds: string;
  /** Filters of a structured BI query written elsewhere: kept as they are, not edited here. */
  biFilters: BiQuery['filters'] | undefined;
  every: '' | ScheduleEvery; startDate: string; dueAfterDays: string; timezone: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const zones = (): string[] => {
  try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { return []; }
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A draft from an item (editing) or empty (a new one). */
export function draftOf(item?: EvidenceItem, defaults: { title?: string; ownerUserId?: string } = {}): ItemDraft {
  const c = (item?.methodConfig ?? {}) as Record<string, unknown>;
  const query = (c.query ?? {}) as Partial<BiQuery>;
  const s = item?.schedule;
  return {
    title: item?.title ?? defaults.title ?? '', type: item?.type ?? 'document', definition: item?.definition ?? '', ownerUserId: item ? item.ownerUserId ?? '' : defaults.ownerUserId ?? '',
    method: item?.method ?? 'manual',
    instructions: item?.method === 'manual' ? str(c.instructions) : '', expectedFormat: item?.method === 'manual' ? str(c.expectedFormat) : '',
    askKind: item?.method === 'request' && c.assigneeEmail ? 'email' : 'person',
    assigneeUserId: item?.method === 'request' ? str(c.assigneeUserId) : '', assigneeEmail: item?.method === 'request' ? str(c.assigneeEmail) : '', requestNote: item?.method === 'request' ? str(c.note) : '',
    endpointKey: item?.method === 'bi' ? str(c.endpointKey) : '', metric: item?.method === 'bi' ? str(query.metric) : '',
    dimensions: item?.method === 'bi' ? (query.dimensions ?? []).join(', ') : '',
    period: item?.method === 'bi' ? ((c.period as ScheduleEvery | undefined) ?? '') : '', timeoutSeconds: item?.method === 'bi' && typeof c.timeoutSeconds === 'number' ? String(c.timeoutSeconds) : '',
    biFilters: item?.method === 'bi' ? query.filters : undefined,
    every: s?.every ?? '', startDate: s?.startDate ?? today(), dueAfterDays: s ? String(s.dueAfterDays) : '14', timezone: s?.timezone ?? localZone(),
  };
}

/** What to tell the person when saving fails: the rule's own sentence, or what the server found wrong in what was typed. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError && e.issues.length) return [...new Set(e.issues.map((i) => i.message))].join(' ');
  return (e as Error).message;
}

/** The settings of the chosen method as the API takes them. Throws a sentence the form shows when something needed is missing. */
export function methodConfigOf(d: ItemDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  switch (d.method) {
    case 'manual':
      if (d.instructions.trim()) out.instructions = d.instructions.trim();
      if (d.expectedFormat.trim()) out.expectedFormat = d.expectedFormat.trim();
      return out;
    case 'request':
      if (d.askKind === 'person') { if (!d.assigneeUserId) throw new Error('Choose who to ask.'); out.assigneeUserId = d.assigneeUserId; }
      else { if (!d.assigneeEmail.trim()) throw new Error('Enter the email address to ask.'); out.assigneeEmail = d.assigneeEmail.trim(); }
      if (d.requestNote.trim()) out.note = d.requestNote.trim();
      return out;
    case 'bi': {
      if (d.endpointKey.trim()) out.endpointKey = d.endpointKey.trim();
      if (d.metric.trim()) {
        const dimensions = d.dimensions.split(',').map((x) => x.trim()).filter(Boolean);
        out.query = { metric: d.metric.trim(), ...(dimensions.length ? { dimensions } : {}), ...(d.biFilters?.length ? { filters: d.biFilters } : {}) };
      }
      if (d.period) out.period = d.period;
      if (d.timeoutSeconds.trim()) out.timeoutSeconds = Number(d.timeoutSeconds);
      return out;
    }
    default: return out;
  }
}

/** The schedule as the API takes it; null for no schedule. */
export function scheduleOf(d: ItemDraft) {
  if (!d.every) return null;
  if (!d.startDate) throw new Error('Choose the start date of the schedule.');
  if (!d.timezone.trim()) throw new Error('Choose the time zone of the schedule.');
  const due = Number(d.dueAfterDays);
  if (!Number.isInteger(due) || due < 0) throw new Error('Due after is a whole number of days, 0 or more.');
  return { every: d.every, startDate: d.startDate, dueAfterDays: due, timezone: d.timezone.trim() };
}

const field = 'flex flex-col gap-1 text-sm';
const select = 'h-9 rounded-md border border-border bg-background px-2';
const area = 'rounded-md border border-border p-2 text-sm';

/** The fields. A type change that the item's versions do not allow is refused by the service, which says why. */
export function ItemFields({ draft, onChange, apis, currentOwner, showMethod = true, emptyOwner = 'No owner' }: {
  draft: ItemDraft; onChange: (patch: Partial<ItemDraft>) => void; apis?: CycleApis | undefined;
  /** False where the item must hold a file at once (it is being linked): then it is collected manually and the method is not asked. */
  showMethod?: boolean;
  /** What the owner list says for "none": for a new item it is the person adding it. */
  emptyOwner?: string;
  /** An owner the directory may not list (someone who cannot read people is still shown by name). */
  currentOwner?: { id: string; name: string } | null;
}) {
  const dir = useDirectory(apis);
  const people = useMemo(() => {
    const list = [...dir.people];
    if (currentOwner && !list.some((p) => p.id === currentOwner.id)) list.unshift({ id: currentOwner.id, fullName: currentOwner.name } as (typeof list)[number]);
    return list;
  }, [dir.people, currentOwner]);
  const [zoneList] = useState(zones);
  const set = <K extends keyof ItemDraft>(k: K) => (v: ItemDraft[K]) => onChange({ [k]: v } as Partial<ItemDraft>);
  const dataset = draft.type === 'dataset';

  return (
    <>
      <label className={field}>Title<Input name="title" aria-label="Title" required value={draft.title} onChange={(e) => set('title')(e.target.value)} dir="auto" /></label>
      <div role="radiogroup" aria-label="Type" className="flex gap-4 text-sm">
        <label className="flex items-center gap-1"><input type="radio" name="type" checked={draft.type === 'document'} onChange={() => onChange({ type: 'document', ...(draft.method === 'form' ? { method: 'manual' as const } : {}) })} /> Document</label>
        <label className="flex items-center gap-1"><input type="radio" name="type" checked={dataset} onChange={() => set('type')('dataset')} /> Dataset</label>
      </div>
      <label className={field}>Definition
        <textarea name="definition" aria-label="Definition" rows={3} dir="auto" value={draft.definition} onChange={(e) => set('definition')(e.target.value)} className={area}
          placeholder={dataset ? 'What the data means: who is counted, from where, for which period' : 'What this evidence is and what it should contain'} />
      </label>

      {showMethod && <fieldset className="space-y-2 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium">Collection method</legend>
        <label className={field}>How it is collected
          <select aria-label="Collection method" className={select} value={draft.method} onChange={(e) => set('method')(e.target.value as EvidenceMethod)}>
            <option value="manual">{METHOD_LABEL.manual}</option>
            <option value="form" disabled={!dataset}>{METHOD_LABEL.form}{dataset ? '' : ' (datasets only)'}</option>
            <option value="request">{METHOD_LABEL.request}</option>
            <option value="bi">{METHOD_LABEL.bi}</option>
            <option value="survey" disabled>{METHOD_LABEL.survey} (coming)</option>
          </select>
        </label>
        <p className="text-xs text-muted-foreground" data-testid="method-help">{METHOD_HELP[draft.method]}</p>
        {draft.method === 'manual' && (
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={field}>Instructions for the owner<textarea aria-label="Instructions" rows={2} dir="auto" className={area} value={draft.instructions} onChange={(e) => set('instructions')(e.target.value)} /></label>
            <label className={field}>Expected format<Input aria-label="Expected format" dir="auto" placeholder="PDF, a spreadsheet, a link…" value={draft.expectedFormat} onChange={(e) => set('expectedFormat')(e.target.value)} /></label>
          </div>
        )}
        {draft.method === 'request' && (
          <div className="space-y-2">
            <div role="radiogroup" aria-label="Ask" className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-1"><input type="radio" name="ask" checked={draft.askKind === 'person'} onChange={() => set('askKind')('person')} /> A person in the AMS</label>
              <label className="flex items-center gap-1"><input type="radio" name="ask" checked={draft.askKind === 'email'} onChange={() => set('askKind')('email')} /> An email address</label>
            </div>
            {draft.askKind === 'person'
              ? (
                <label className={field}>Who to ask
                  <select aria-label="Who to ask" className={select} value={draft.assigneeUserId} onChange={(e) => set('assigneeUserId')(e.target.value)} dir="auto">
                    <option value="">Choose a person</option>
                    {people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                  </select>
                </label>
              )
              : <label className={field}>Email address<Input type="email" aria-label="Email address" value={draft.assigneeEmail} onChange={(e) => set('assigneeEmail')(e.target.value)} /></label>}
            <label className={field}>Note to them (optional)<textarea aria-label="Note" rows={2} dir="auto" className={area} value={draft.requestNote} onChange={(e) => set('requestNote')(e.target.value)} /></label>
          </div>
        )}
        {draft.method === 'bi' && (
          <div className="space-y-2">
            {!dataset && <p role="note" className="text-xs text-amber-900">A dataset suits the BI best: it supplies figures with columns. A document is also accepted.</p>}
            <div className="grid gap-2 sm:grid-cols-2">
              <label className={field}>BI endpoint (a name)<Input aria-label="BI endpoint" placeholder="main" value={draft.endpointKey} onChange={(e) => set('endpointKey')(e.target.value)} /></label>
              <label className={field}>Metric<Input aria-label="Metric" placeholder="enrollment_headcount" value={draft.metric} onChange={(e) => set('metric')(e.target.value)} /></label>
              <label className={field}>Dimensions (comma-separated)<Input aria-label="Dimensions" placeholder="program, level" value={draft.dimensions} onChange={(e) => set('dimensions')(e.target.value)} /></label>
              <label className={field}>Period
                <select aria-label="Period" className={select} value={draft.period} onChange={(e) => set('period')(e.target.value as ItemDraft['period'])}>
                  <option value="">Follow the schedule</option>
                  {SCHEDULE_EVERY.map((x) => <option key={x} value={x}>{x[0]!.toUpperCase() + x.slice(1)}</option>)}
                </select>
              </label>
              <label className={field}>Wait up to (seconds)<Input type="number" min={1} max={600} aria-label="Timeout" value={draft.timeoutSeconds} onChange={(e) => set('timeoutSeconds')(e.target.value)} /></label>
            </div>
            <p className="text-xs text-muted-foreground">The endpoint is a name the server is set up with, never an address. The query is a metric and how to cut it, not SQL.</p>
          </div>
        )}
        {draft.method === 'form' && <p className="text-xs text-muted-foreground">Uses the dataset’s columns. Define them in the sheet under the item once it is saved.</p>}
      </fieldset>}

      <fieldset className="space-y-2 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium">Schedule</legend>
        <label className={field}>Repeats
          <select aria-label="Repeats" className={select} value={draft.every} onChange={(e) => set('every')(e.target.value as ItemDraft['every'])}>
            <option value="">No schedule</option>
            {SCHEDULE_EVERY.map((x) => <option key={x} value={x}>{EVERY_LABEL[x]}</option>)}
          </select>
        </label>
        {draft.every && (
          <div className="grid gap-2 sm:grid-cols-3">
            <label className={field}>Start date<Input type="date" required aria-label="Start date" value={draft.startDate} onChange={(e) => set('startDate')(e.target.value)} /></label>
            <label className={field}>Due after (days)<Input type="number" min={0} max={3650} step={1} required aria-label="Due after" value={draft.dueAfterDays} onChange={(e) => set('dueAfterDays')(e.target.value)} /></label>
            <label className={field}>Time zone
              <Input aria-label="Time zone" list="evidence-time-zones" required value={draft.timezone} onChange={(e) => set('timezone')(e.target.value)} />
              <datalist id="evidence-time-zones">{zoneList.map((z) => <option key={z} value={z} />)}</datalist>
            </label>
          </div>
        )}
        {draft.every === 'semester' && <p className="text-xs text-muted-foreground">A semester is a term of the academic calendar (Settings, Organization). A period the calendar does not define is flagged, never guessed.</p>}
        {draft.every && <p className="text-xs text-muted-foreground">Nothing is sent or run yet: this records when the evidence is due.</p>}
      </fieldset>

      <label className={field}>Owner
        <select aria-label="Owner" className={select} value={draft.ownerUserId} onChange={(e) => set('ownerUserId')(e.target.value)} dir="auto">
          <option value="">{emptyOwner}</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
        </select>
      </label>
    </>
  );
}
