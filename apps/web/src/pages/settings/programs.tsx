import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { DocsTab } from '../../components/docs';
import { ReadOnlyNote } from '../../components/read-only-note';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { useDocumentsApi, type DocumentsApi } from '../../lib/documents-api';
import { can, useMe } from '../../lib/me';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';
import type { OutcomesApi } from '../../lib/outcomes-api';
import type { SyllabusApi } from '../../lib/syllabus-api';
import type { AcademicApi } from '../../lib/academic-api';
import { LEVEL } from './program-page';
import { AcademicImportExport } from './academic-io';
import { useUrlState } from '../../lib/url-state';

/**
 * The Programs tab of Settings -> Organization: the list, and a Docs section where catalogues and program lists are uploaded and
 * the AI import proposes programs for review (TASK-076). `docs` is for tests; the app's own client is the default.
 */
export function ProgramsSettingsPage({ api: override, docs: docsOverride, programs: programsApi }: { api?: SettingsApi; docs?: DocumentsApi; outcomes?: OutcomesApi; syllabus?: SyllabusApi; programs?: AcademicApi }) {
  const api = useSettingsApi(override);
  const docs = useDocumentsApi(docsOverride);
  const [section, setSection] = useUrlState<'list' | 'docs'>('section', 'list', ['list', 'docs']);
  const me0 = useMe(api);
  const writer = can(me0.data, 'program:write');
  const targets = useQuery({ queryKey: ['import-targets', 'programs'], queryFn: () => docs.targets({ kind: 'programs', id: null }), enabled: section === 'docs' });
  const sections = [{ id: 'list', label: 'List' }, { id: 'docs', label: 'Docs' }] as const;
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Programs sections" className="flex flex-wrap gap-1">
        {sections.map((t) => (
          <button key={t.id} id={`programs-section-${t.id}`} role="tab" type="button" aria-selected={section === t.id} aria-controls="programs-section-panel" onClick={() => setSection(t.id)}
            className={`rounded-md px-3 py-1 text-sm ${section === t.id ? 'bg-muted font-medium' : 'text-muted-foreground'}`}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id="programs-section-panel" aria-labelledby={`programs-section-${section}`}>
        {section === 'list'
          ? <ProgramsList api={api} {...(programsApi ? { programsApi } : {})} />
          : <DocsTab scopeKind="programs" scopeId={null} targets={targets.data ?? []} canWrite={writer} api={docs} />}
      </div>
    </div>
  );
}

/**
 * The list of programs: each opens on its own page (/settings/programs/<id>), "Add program" on /new. A record saved by an
 * import or the API without its required fields shows what is missing.
 */
function ProgramsList({ api, programsApi }: { api: SettingsApi; programsApi?: AcademicApi }) {
  const qc = useQueryClient();
  const me = useMe(api);
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.programs() });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.orgUnits() });
  const [showInactive, setShowInactive] = useState(false);
  const [io, setIo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const canWrite = can(me.data, 'program:write');
  const unitName = new Map((units.data ?? []).map((u) => [u.id, u.nameEn]));
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['programs'] }); } });
  const rows = (programs.data ?? []).filter((p) => showInactive || p.active);
  const incomplete = rows.filter((p) => p.missing.length).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Programs</h3>
          <ReadOnlyNote show={!!me.data && !canWrite} />
          {incomplete > 0 && <p className="text-xs text-amber-800">{incomplete} program{incomplete === 1 ? ' is' : 's are'} missing required details.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
          <Button type="button" variant="outline" aria-expanded={io} onClick={() => setIo(!io)}>Import and export</Button>
          {canWrite && <Link to="/settings/programs/$programId" params={{ programId: 'new' }} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">Add program</Link>}
        </div>
      </div>
      {io && <AcademicImportExport canWrite={canWrite} {...(programsApi ? { api: programsApi } : {})} onDone={() => setIo(false)} />}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {programs.isError && <p role="alert">Could not load programs.</p>}
      {programs.data && rows.length === 0 && <p className="text-muted-foreground">No programs visible to you yet.</p>}
      <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Programs">
        {rows.map((p) => (
          <li key={p.id} className="px-4 py-3" data-testid="program">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <Link to="/settings/programs/$programId" params={{ programId: p.id }} className="font-medium underline-offset-2 hover:underline" data-testid="program-name">
                  <ContentText>{p.nameEn}</ContentText>
                </Link>
                {p.nameAr && <ContentText className="ms-2 text-sm text-muted-foreground">{p.nameAr}</ContentText>}
                <p className="text-xs text-muted-foreground">{p.code ? `${p.code} · ` : ''}{LEVEL[p.degreeLevel]} · {unitName.get(p.orgUnitId) ?? 'Unknown unit'}</p>
                {p.missing.length > 0 && <p className="mt-1 text-xs"><span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900" title={p.missing.join(', ')}>Missing: {p.missing.join(', ')}</span></p>}
              </div>
              {!p.active && <span className="rounded border border-border px-2 py-0.5 text-xs">Inactive</span>}
              <Link to="/settings/programs/$programId" params={{ programId: p.id }} aria-label={`${canWrite ? 'Edit' : 'Open'} ${p.nameEn}`} className="rounded-md px-2 py-1 text-sm hover:bg-muted">{canWrite ? 'Edit' : 'Open'}</Link>
              {canWrite && <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => run.mutate(() => api.updateProgram(p.id, { active: !p.active }))}>{p.active ? 'Deactivate' : 'Reactivate'}</Button>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
