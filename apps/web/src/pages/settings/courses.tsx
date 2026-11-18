import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ContentText } from '../../components/content-text';
import { ReadOnlyNote } from '../../components/read-only-note';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { can, useMe } from '../../lib/me';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useUrlState } from '../../lib/url-state';
import { CoursesImportExport } from './courses-io';

const select = 'rounded-md border border-border bg-background px-2 py-1 text-sm';

/**
 * Settings -> Organization -> Courses (DEC-042): the catalogue. Each course opens on its own page (/settings/organization/courses/<id>),
 * "Add course" on /new; a course whose record lacks something shows it. Search and the program filter are in the address.
 */
export function CoursesSettingsPage({ api: settingsOverride, outcomes: outcomesOverride }: { api?: SettingsApi; outcomes?: OutcomesApi }) {
  const api = useSettingsApi(settingsOverride);
  const oapi = useOutcomesApi(outcomesOverride);
  const me = useMe(api);
  const canWrite = can(me.data, 'program:write');
  const courses = useQuery({ queryKey: ['courses'], queryFn: () => oapi.courses() });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.orgUnits() });
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.programs() });
  const [q, setQ] = useState('');
  const [programFilter, setProgramFilter] = useUrlState<string>('program', '');
  const [showInactive, setShowInactive] = useState(false);
  const [io, setIo] = useState(false);
  const unitName = new Map((units.data ?? []).map((u) => [u.id, u.nameEn]));
  const progName = new Map((programs.data ?? []).map((p) => [p.id, p.code || p.nameEn]));
  const needle = q.trim().toLowerCase();
  const rows = (courses.data ?? []).filter((c) => (showInactive || c.active) && (!needle || `${c.code} ${c.titleEn}`.toLowerCase().includes(needle)) && (!programFilter || c.programIds.includes(programFilter)));
  const incomplete = rows.filter((c) => c.missing.length).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Courses</h3>
          <ReadOnlyNote show={!!me.data && !canWrite} />
          {incomplete > 0 && <p className="text-xs text-amber-800">{incomplete} course{incomplete === 1 ? ' is' : 's are'} missing required details.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
          <Button type="button" variant="outline" aria-expanded={io} onClick={() => setIo(!io)}>Import and export</Button>
          {canWrite && <Link to="/settings/organization/courses/$courseId" params={{ courseId: 'new' }} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">Add course</Link>}
        </div>
      </div>
      {io && <CoursesImportExport canWrite={canWrite} onDone={() => setIo(false)} />}
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Search courses" placeholder="Search by code or title" className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Filter by program" className={select} value={programFilter} onChange={(e) => setProgramFilter(e.target.value)}>
          <option value="">All programs</option>
          {(programs.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.nameEn}</option>)}
        </select>
      </div>
      {courses.isError && <p role="alert">Could not load courses.</p>}
      {courses.data && rows.length === 0 && <p className="text-muted-foreground">{courses.data.length ? 'No course matches.' : 'No courses yet.'}</p>}
      <ul className="divide-y divide-border rounded-lg border border-border empty:hidden" aria-label="Courses">
        {rows.map((c) => (
          <li key={c.id} className="px-4 py-3" data-testid="course">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <Link to="/settings/organization/courses/$courseId" params={{ courseId: c.id }} className="underline-offset-2 hover:underline" aria-label={`${c.code} ${c.titleEn}`}>
                  <span className="font-mono font-semibold">{c.code}</span> <ContentText className="font-medium">{c.titleEn}</ContentText>
                </Link>
                <span className="block text-xs text-muted-foreground">
                  {[c.orgUnitId ? unitName.get(c.orgUnitId) : null, c.credits !== null ? `${c.credits} credit hours` : null, c.level !== null ? `year ${c.level}` : null,
                    `${c.cloCount} CLO${c.cloCount === 1 ? '' : 's'}`, c.programIds.length ? c.programIds.map((p) => progName.get(p) ?? '…').join(', ') : null].filter(Boolean).join(' · ')}
                </span>
                {c.missing.length > 0 && <p className="mt-1 text-xs"><span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">Missing: {c.missing.join(', ')}</span></p>}
              </div>
              {!c.active && <span className="rounded border border-border px-2 py-0.5 text-xs">Inactive</span>}
              <Link to="/settings/organization/courses/$courseId" params={{ courseId: c.id }} aria-label={`${canWrite ? 'Edit' : 'Open'} ${c.code}`} className="rounded-md px-2 py-1 text-sm hover:bg-muted">{canWrite ? 'Edit' : 'Open'}</Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
