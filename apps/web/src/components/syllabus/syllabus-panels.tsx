// The panels around the syllabus: the flag banner (an error needs the coordinator at once and goes up the line), the workflow bar
// (instructor suggests, coordinator edits and submits, chair endorses, Dean approves), suggestions, staff and history.
import { useState } from 'react';
import type { SyllabusOverview, SyllabusSuggestion, SyllabusVersion } from '@ams/shared';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ContentText } from '../content-text';
import { useDirectory, type CycleApis } from '../cycles/directory';
import { label, STATUS_TONE } from './labels';

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const LINE = ['the course coordinator', 'the program chair', 'the Dean', 'the VPAA'] as const;
const chip = 'rounded px-1.5 py-0.5 text-xs';

export function StatusChip({ status, testId }: { status: string; testId?: string }) {
  return <span className={`${chip} ${STATUS_TONE[status] ?? 'bg-muted'}`} {...(testId ? { 'data-testid': testId } : {})}>{label(status)}</span>;
}

/** Errors need immediate attention from the course coordinator, then go up the line while they stand. */
export function FlagBanner({ version, errors }: { version: SyllabusVersion | null; errors: number }) {
  if (errors === 0) return null;
  const since = version?.flaggedSince ? DATE.format(new Date(version.flaggedSince)) : 'now';
  const level = version?.escalationLevel ?? 0;
  return (
    <div role="alert" data-testid="flag-banner" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      <p className="font-medium">This syllabus has {errors} error{errors === 1 ? '' : 's'} that need immediate attention.</p>
      <p className="text-xs">It needs {LINE[0]} first. Flagged since {since}; unfixed, it goes up to {LINE[1]}, {LINE[2]} and {LINE[3]}{level > 0 ? ` (now with ${LINE[level]} and those below)` : ''}. It cannot be submitted for review until the errors are fixed.</p>
    </div>
  );
}

export interface WorkflowProps {
  overview: SyllabusOverview; version: SyllabusVersion | null; /** The editor is showing: its draft (saved or not) can be saved, submitted or discarded. */ editing: boolean; dirty: boolean; errors: number; busy: boolean;
  onSave: () => void; onSubmit: () => void; onDiscard: () => void; onEndorse: () => void; onReturn: (note: string) => void; onApprove: (effectiveFrom: string) => void; onNewVersion: () => void;
}
export function WorkflowBar({ overview, version, editing, dirty, errors, busy, onSave, onSubmit, onDiscard, onEndorse, onReturn, onApprove, onNewVersion }: WorkflowProps) {
  const { can } = overview;
  const [note, setNote] = useState('');
  const [term, setTerm] = useState('');
  const status = version?.status ?? null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3" role="group" aria-label="Syllabus workflow">
      {status && <StatusChip status={status} testId="syllabus-status" />}
      {version && <span className="text-xs text-muted-foreground">Version {version.versionNo}{version.effectiveFrom ? ` · effective ${version.effectiveFrom}` : ''}</span>}
      {version?.returnedNote && status === 'draft' && <span className="text-xs text-amber-900" data-testid="returned-note">Returned: {version.returnedNote}</span>}
      <span className="ms-auto flex flex-wrap items-center gap-2">
        {can.edit && editing && <Button type="button" variant="outline" disabled={busy || !dirty} onClick={onSave}>Save draft</Button>}
        {can.edit && editing && <Button type="button" disabled={busy || errors > 0} title={errors > 0 ? 'Fix the errors first' : undefined} onClick={onSubmit}>Submit for review</Button>}
        {can.edit && editing && status === 'draft' && <Button type="button" variant="ghost" disabled={busy} onClick={onDiscard}>Discard draft</Button>}
        {can.endorse && status === 'in_review' && <Button type="button" disabled={busy} onClick={onEndorse}>Endorse</Button>}
        {can.approve && status === 'endorsed' && (
          <><Input aria-label="Effective from (term)" className="w-40" placeholder="Effective from, e.g. Fall 2026" value={term} onChange={(e) => setTerm(e.target.value)} /><Button type="button" disabled={busy} onClick={() => onApprove(term)}>Approve</Button></>
        )}
        {can.endorse && (status === 'in_review' || status === 'endorsed') && (
          <><Input aria-label="Return note" className="w-48" placeholder="Note to the coordinator" value={note} onChange={(e) => setNote(e.target.value)} /><Button type="button" variant="outline" disabled={busy} onClick={() => { onReturn(note); setNote(''); }}>Return to coordinator</Button></>
        )}
        {can.edit && status === 'approved' && <Button type="button" disabled={busy} onClick={onNewVersion}>Start a new version</Button>}
      </span>
    </div>
  );
}

export function SuggestionsPanel({ overview, version, busy, onSuggest, onResolve }: {
  overview: SyllabusOverview; version: SyllabusVersion | null; busy: boolean; onSuggest: (section: string, text: string) => void; onResolve: (s: SyllabusSuggestion, decision: 'accepted' | 'declined') => void;
}) {
  const [section, setSection] = useState('clos');
  const [text, setText] = useState('');
  const open = overview.suggestions.filter((s) => s.status === 'open');
  const done = overview.suggestions.filter((s) => s.status !== 'open');
  return (
    <section aria-label="Suggestions" className="space-y-2 rounded-lg border border-border p-3">
      <h3 className="text-sm font-semibold">Suggestions</h3>
      {open.length === 0 && done.length === 0 && <p className="text-xs text-muted-foreground">No suggestions yet. Instructors suggest; the coordinator makes the changes.</p>}
      <ul className="space-y-2">
        {open.map((s) => (
          <li key={s.id} className="rounded border border-border/60 p-2 text-sm" data-testid="suggestion">
            <p className="text-xs text-muted-foreground">{s.byName ?? 'Someone'} · {label(s.section) === s.section ? s.section : label(s.section)}</p>
            <p><ContentText>{s.suggestion}</ContentText></p>
            {overview.can.edit && <div className="mt-1 flex gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => onResolve(s, 'accepted')}>Accept</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => onResolve(s, 'declined')}>Decline</Button></div>}
          </li>
        ))}
        {done.map((s) => <li key={s.id} className="text-xs text-muted-foreground">{s.byName ?? 'Someone'} · {s.section} · {s.status}{s.resolutionNote ? ` (${s.resolutionNote})` : ''}</li>)}
      </ul>
      {overview.can.suggest && version && ['draft', 'in_review', 'endorsed'].includes(version.status) && (
        <form className="space-y-1" aria-label="Suggest a change" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; onSuggest(section, text.trim()); setText(''); }}>
          <div className="flex flex-wrap gap-2">
            <select aria-label="Suggestion section" className="h-9 rounded-md border border-border bg-background px-2 text-sm" value={section} onChange={(e) => setSection(e.target.value)}>
              {overview.template.sections.map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}
            </select>
            <Input aria-label="Suggestion" className="min-w-0 grow" placeholder="What should change, and why" value={text} onChange={(e) => setText(e.target.value)} />
            <Button type="submit" variant="outline" disabled={busy || !text.trim()}>Suggest</Button>
          </div>
        </form>
      )}
    </section>
  );
}

export function StaffPanel({ overview, busy, apis, onSave }: { overview: SyllabusOverview; busy: boolean; apis?: CycleApis | undefined; onSave: (coordinatorUserId: string | null, instructorIds: string[]) => void }) {
  const dir = useDirectory(apis);
  const [coordinator, setCoordinator] = useState(overview.course.coordinatorUserId ?? '');
  const [instructors, setInstructors] = useState<string[]>(overview.course.instructors.map((i) => i.id));
  const people = [...dir.people];
  for (const t of overview.course.instructors) if (!people.some((p) => p.id === t.id)) people.push({ id: t.id, fullName: t.name } as (typeof people)[number]);
  if (overview.course.coordinatorUserId && !people.some((p) => p.id === overview.course.coordinatorUserId)) people.push({ id: overview.course.coordinatorUserId, fullName: overview.course.coordinatorName ?? '' } as (typeof people)[number]);
  return (
    <section aria-label="Course staff" className="space-y-2 rounded-lg border border-border p-3">
      <h3 className="text-sm font-semibold">Course staff</h3>
      {overview.can.approve ? (
        <>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">Course coordinator (edits the syllabus, told first when it is flagged)
            <select aria-label="Course coordinator" className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground" value={coordinator} onChange={(e) => setCoordinator(e.target.value)}>
              <option value="">Not named</option>{people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
            </select>
          </label>
          <div className="text-xs text-muted-foreground">Instructors (may suggest changes)
            <div role="group" aria-label="Instructors" className="mt-1 flex flex-wrap gap-1">
              {people.map((p) => (
                <button key={p.id} type="button" aria-pressed={instructors.includes(p.id)} onClick={() => setInstructors((xs) => (xs.includes(p.id) ? xs.filter((x) => x !== p.id) : [...xs, p.id]))}
                  className={`rounded-full border px-2 py-0.5 text-xs ${instructors.includes(p.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}>{p.fullName}</button>
              ))}
            </div>
          </div>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onSave(coordinator || null, instructors)}>Save staff</Button>
        </>
      ) : (
        <p className="text-sm">Coordinator: {overview.course.coordinatorName ?? 'not named'}. Instructors: {overview.course.instructors.map((i) => i.name).join(', ') || 'none named'}.</p>
      )}
    </section>
  );
}

export function HistoryList({ overview }: { overview: SyllabusOverview }) {
  if (!overview.history.length) return null;
  return (
    <section aria-label="Versions" className="space-y-1 rounded-lg border border-border p-3">
      <h3 className="text-sm font-semibold">Versions</h3>
      <ul className="space-y-1 text-sm">
        {overview.history.map((h) => <li key={h.id} className="flex flex-wrap items-center gap-2"><span>Version {h.versionNo}</span><StatusChip status={h.status} />{h.effectiveFrom && <span className="text-xs text-muted-foreground">effective {h.effectiveFrom}</span>}{h.approvedAt && <span className="text-xs text-muted-foreground">approved {DATE.format(new Date(h.approvedAt))}</span>}</li>)}
      </ul>
    </section>
  );
}
