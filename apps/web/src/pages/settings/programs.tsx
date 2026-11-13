import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEGREE_LEVELS, PROGRAM_MODES, type CreateProgram, type LearningOutcome, type Program } from '@ams/shared';
import { DocsTab } from '../../components/docs';
import { ReadOnlyNote } from '../../components/read-only-note';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/dialog';
import { Input } from '../../components/ui/input';
import { patchOf } from '../../components/outcomes/outcome-list';
import { OutcomeRows, type OutcomeRow } from '../../components/outcomes/outcome-rows';
import { useDocumentsApi, type DocumentsApi } from '../../lib/documents-api';
import { can, useMe } from '../../lib/me';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';
import { ProgramOutcomesPanel } from './program-outcomes';
import { WorkbookLoader } from './workbook-loader';
import { ReviewHeatmap } from './program-review';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import type { AssessmentApi } from '../../lib/assessment-api';

const select = 'w-full min-w-0 max-w-full rounded-md border border-border bg-background px-2 py-1 text-sm';
const LEVEL = { associate: 'Associate', bachelor: 'Bachelor', master: 'Master', doctorate: 'Doctorate', diploma: 'Diploma', certificate: 'Certificate' } as const;
const tagsOf = (s: string) => [...new Set(s.split(',').map((t) => t.trim()).filter(Boolean))];

type Unit = { id: string; nameEn: string; active: boolean };
const MODE = { full_time: 'Full time', part_time: 'Part time', online: 'Online', blended: 'Blended' } as const;
type Facts = Pick<CreateProgram, 'code' | 'externalId' | 'mode' | 'credits' | 'durationYears' | 'languageOfInstruction' | 'mission' | 'vision'>;
type ProgramValues = { orgUnitId: string; nameEn: string; nameAr: string; degreeLevel: Program['degreeLevel']; discipline: string; tags: string[]; facts: Facts; peos: OutcomeRow[]; plos: OutcomeRow[] };
/** The outcomes a program already has, and rows left to add. */
interface OutcomeContext { peos: LearningOutcome[]; plos: LearningOutcome[] }
const NO_ROWS: { peos: OutcomeRow[]; plos: OutcomeRow[] } = { peos: [], plos: [] };
const n = (s: string) => (s.trim() === '' ? null : Number(s));

function ProgramForm({ initial, units, existing, rows, submitLabel, error, busy, onSubmit, onCancel }: {
  initial?: Program; units: Unit[]; existing: OutcomeContext; rows: { peos: OutcomeRow[]; plos: OutcomeRow[] }; submitLabel: string; error?: string | null; busy?: boolean; onSubmit: (v: ProgramValues) => void; onCancel?: () => void;
}) {
  const [f, setF] = useState({
    code: initial?.code ?? '', externalId: initial?.externalId ?? '', mode: initial?.mode ?? '', credits: initial?.credits?.toString() ?? '',
    durationYears: initial?.durationYears?.toString() ?? '', languageOfInstruction: initial?.languageOfInstruction ?? '', mission: initial?.mission ?? '', vision: initial?.vision ?? '',
  });
  const setFact = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const facts: Facts = {
    code: f.code || null, externalId: f.externalId || null, mode: (f.mode || null) as Facts['mode'], credits: n(f.credits), durationYears: n(f.durationYears),
    languageOfInstruction: f.languageOfInstruction || null, mission: f.mission || null, vision: f.vision || null,
  };
  const [orgUnitId, setOrgUnitId] = useState(initial?.orgUnitId ?? '');
  const [nameEn, setNameEn] = useState(initial?.nameEn ?? '');
  const [nameAr, setNameAr] = useState(initial?.nameAr ?? '');
  const [degreeLevel, setLevel] = useState<Program['degreeLevel']>(initial?.degreeLevel ?? 'bachelor');
  const [discipline, setDiscipline] = useState(initial?.discipline ?? '');
  const [tags, setTags] = useState(initial?.tags.join(', ') ?? '');
  const [peos, setPeos] = useState(rows.peos);
  const [plos, setPlos] = useState(rows.plos);
  const field = 'flex min-w-0 flex-col gap-1 text-xs';
  const legend = 'px-1 text-sm font-semibold';
  const box = 'grid min-w-0 gap-3 rounded-lg border border-border p-3 sm:grid-cols-2';
  const text = 'rounded-md border border-border bg-background px-2 py-1 text-sm';
  const ok = !!orgUnitId && !!nameEn.trim();
  return (
    <form className="space-y-4" aria-label={submitLabel} onSubmit={(e) => { e.preventDefault(); if (ok) onSubmit({ orgUnitId, nameEn, nameAr, degreeLevel, discipline, tags: tagsOf(tags), facts, peos, plos }); }}>
      <fieldset className={box}>
        <legend className={legend}>The program</legend>
        <label className={field}>Name (English)<Input aria-label="Program name (English)" value={nameEn} onChange={(e) => setNameEn(e.target.value)} required autoFocus /></label>
        <label className={field}>Name (Arabic)<Input aria-label="Program name (Arabic)" dir="auto" value={nameAr} onChange={(e) => setNameAr(e.target.value)} /></label>
        <label className={field}>School or department
          <select aria-label="Program org unit" className={select} value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)} required>
            <option value="">Choose a unit</option>
            {units.filter((u) => u.active || u.id === initial?.orgUnitId).map((u) => <option key={u.id} value={u.id}>{u.nameEn}</option>)}
          </select>
        </label>
        <label className={field}>Degree level
          <select aria-label="Degree level" className={select} value={degreeLevel} onChange={(e) => setLevel(e.target.value as Program['degreeLevel'])}>
            {DEGREE_LEVELS.map((d) => <option key={d} value={d}>{LEVEL[d]}</option>)}
          </select>
        </label>
        <label className={field}>Code<Input aria-label="Program code" value={f.code} placeholder="BS-ECE" onChange={setFact('code')} /></label>
        <label className={field}>Student-system id<Input aria-label="Program student-system id" value={f.externalId} onChange={setFact('externalId')} /></label>
      </fieldset>
      <fieldset className={box}>
        <legend className={legend}>Details</legend>
        <label className={field}>Discipline<Input aria-label="Discipline" value={discipline} onChange={(e) => setDiscipline(e.target.value)} /></label>
        <label className={field}>Mode
          <select aria-label="Mode" className={select} value={f.mode} onChange={setFact('mode')}>
            <option value="">Not set</option>
            {PROGRAM_MODES.map((m) => <option key={m} value={m}>{MODE[m]}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-3 gap-2 sm:col-span-2">
          <label className={field}>Credits<Input aria-label="Total credits" inputMode="numeric" value={f.credits} onChange={setFact('credits')} /></label>
          <label className={field}>Years<Input aria-label="Duration in years" inputMode="decimal" value={f.durationYears} onChange={setFact('durationYears')} /></label>
          <label className={field}>Language<Input aria-label="Language of instruction" value={f.languageOfInstruction} onChange={setFact('languageOfInstruction')} /></label>
        </div>
        <label className={`${field} sm:col-span-2`}>Tags<Input aria-label="Tags" value={tags} onChange={(e) => setTags(e.target.value)} />
          <span className="text-muted-foreground">Separate with commas, e.g. mechanical, engineering. Tags decide which accreditor requirements apply to the program.</span>
        </label>
      </fieldset>
      <fieldset className="grid min-w-0 gap-3 rounded-lg border border-border p-3">
        <legend className={legend}>Mission and vision</legend>
        <label className={field}>Mission<textarea aria-label="Program mission" dir="auto" rows={3} className={text} value={f.mission} onChange={setFact('mission')} /></label>
        <label className={field}>Vision<textarea aria-label="Program vision" dir="auto" rows={2} className={text} value={f.vision} onChange={setFact('vision')} /></label>
      </fieldset>
      <OutcomeRows label="PEO" title="Program educational objectives (PEOs)" codeHint="PEO1" rows={peos} existing={existing.peos} onChange={setPeos} />
      <OutcomeRows label="PLO" title="Program learning outcomes (PLOs)" codeHint="PLO1" rows={plos} existing={existing.plos} onChange={setPlos} />
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" disabled={!ok || busy}>{busy ? 'Saving…' : submitLabel}</Button>
      </div>
    </form>
  );
}

/** Adding or editing a program, in a dialog over the list (not in line with it). */
function ProgramDialog({ initial, units, existing, rows, error, busy, onSubmit, onClose }: { initial?: Program; units: Unit[]; existing: OutcomeContext; rows: { peos: OutcomeRow[]; plos: OutcomeRow[] }; error: string | null; busy: boolean; onSubmit: (v: ProgramValues) => void; onClose: () => void }) {
  return (
    <Dialog labelledBy="program-dialog-title" onClose={onClose} size="lg">
      <div className="mb-4 flex items-start justify-between gap-2">
        <h2 id="program-dialog-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">{initial ? `Edit ${initial.nameEn}` : 'Add a program'}</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <ProgramForm initial={initial} units={units} existing={existing} rows={rows} submitLabel={initial ? 'Save' : 'Add program'} error={error} busy={busy} onSubmit={onSubmit} onCancel={onClose} />
    </Dialog>
  );
}

/**
 * The Programs tab of Settings -> Organization: the list, and a Docs section where catalogues and program lists are uploaded and
 * the AI import proposes programs for review (TASK-076). `docs` is for tests; the app's own client is the default.
 */
export function ProgramsSettingsPage({ api: override, docs: docsOverride, outcomes, assessment }: { api?: SettingsApi; docs?: DocumentsApi; outcomes?: OutcomesApi; assessment?: AssessmentApi }) {
  const api = useSettingsApi(override);
  const docs = useDocumentsApi(docsOverride);
  const [section, setSection] = useState<'list' | 'review' | 'docs'>('list');
  const [open, setOpen] = useState<string | null>(null);
  const me0 = useMe(api);
  const writer = can(me0.data, 'program:write');
  const targets = useQuery({ queryKey: ['import-targets', 'programs'], queryFn: () => docs.targets({ kind: 'programs', id: null }), enabled: section === 'docs' });
  const sections = [{ id: 'list', label: 'List' }, { id: 'review', label: 'Review' }, { id: 'docs', label: 'Docs' }] as const;
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
          ? <ProgramsList api={api} {...(outcomes ? { outcomes } : {})} {...(assessment ? { assessment } : {})} opened={open} onOpened={setOpen} />
          : section === 'review' ? <ReviewHeatmap {...(outcomes ? { api: outcomes } : {})} onOpen={(id) => { setOpen(id); setSection('list'); }} />
          : <DocsTab scopeKind="programs" scopeId={null} targets={targets.data ?? []} canWrite={writer} api={docs} />}
      </div>
    </div>
  );
}

function ProgramsList({ api, outcomes, assessment, opened: openedId, onOpened }: { api: SettingsApi; outcomes?: OutcomesApi; assessment?: AssessmentApi; opened: string | null; onOpened: (id: string | null) => void }) {
  const qc = useQueryClient();
  const me = useMe(api);
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.programs() });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.orgUnits() });
  // The program being added (null program) or edited, in a dialog.
  const [dialog, setDialog] = useState<{ program: Program | null; rows?: { peos: OutcomeRow[]; plos: OutcomeRow[] } } | null>(null);
  const oapi = useOutcomesApi(outcomes);
  const existing = useQuery({ queryKey: ['program-outcomes', dialog?.program?.id], queryFn: () => oapi.programOutcomes(dialog!.program!.id), enabled: !!dialog?.program });
  const [saving, setSaving] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const outcomesOf = openedId; const setOutcomesOf = onOpened;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const canWrite = can(me.data, 'program:write');
  const unitName = new Map((units.data ?? []).map((u) => [u.id, u.nameEn]));
  const refresh = () => qc.invalidateQueries({ queryKey: ['programs'] });
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => { setError(null); return act(fn); }, onSuccess: () => { void refresh(); } });
  const rows = (programs.data ?? []).filter((p) => showInactive || p.active);
  const save = async (v: ProgramValues) => {
    if (!dialog) return;
    setSaving(true); setError(null);
    const target = dialog.program;
    const body = { orgUnitId: v.orgUnitId, nameEn: v.nameEn, degreeLevel: v.degreeLevel, tags: v.tags, ...v.facts };
    const saved = await act(() => (target
      ? api.updateProgram(target.id, { ...body, nameAr: v.nameAr || null, discipline: v.discipline || null })
      : api.createProgram({ ...body, ...(v.nameAr ? { nameAr: v.nameAr } : {}), ...(v.discipline ? { discipline: v.discipline } : {}) })));
    if (saved === undefined) { setSaving(false); return; }
    void refresh();
    // The outcomes, one after the other; the first that fails stops the rest and stays in the dialog with what is left.
    const todo = [...v.peos.map((r) => ({ kind: 'peo' as const, r })), ...v.plos.map((r) => ({ kind: 'plo' as const, r }))].filter((x) => x.r.textEn.trim());
    let done = 0;
    for (const { kind, r } of todo) {
      const draft = { code: r.code.trim(), textEn: r.textEn.trim(), textAr: r.textAr.trim(), bloomLevel: '', status: 'draft', approvedOn: '' };
      const ok = await act(() => oapi.createOutcome({ kind, programId: (saved as Program).id, ...patchOf(draft), code: draft.code, textEn: draft.textEn }));
      if (ok === undefined) {
        const left = todo.slice(done);
        setDialog({ program: saved as Program, rows: { peos: left.filter((x) => x.kind === 'peo').map((x) => x.r), plos: left.filter((x) => x.kind === 'plo').map((x) => x.r) } });
        void qc.invalidateQueries({ queryKey: ['program-outcomes', (saved as Program).id] });
        setSaving(false);
        return;
      }
      done += 1;
    }
    if (todo.length) void qc.invalidateQueries({ queryKey: ['program-outcomes', (saved as Program).id] });
    setDialog(null); setSaving(false);
  };
  const dialogEl = dialog && canWrite && (
    <ProgramDialog key={`${dialog.program?.id ?? 'new'}-${dialog.rows ? 'again' : 'first'}`} initial={dialog.program ?? undefined} units={units.data ?? []}
      existing={dialog.program && existing.data ? existing.data : { peos: [], plos: [] }} rows={dialog.rows ?? NO_ROWS}
      error={error} busy={saving} onClose={() => { setDialog(null); setError(null); }} onSubmit={(v) => { void save(v); }} />
  );
  const opened = outcomesOf ? programs.data?.find((p) => p.id === outcomesOf) : undefined;
  if (opened) return <><ProgramOutcomesPanel program={opened} canWrite={canWrite} onBack={() => setOutcomesOf(null)} onAddOutcomes={() => setDialog({ program: opened })} {...(outcomes ? { api: outcomes } : {})} {...(assessment ? { assessment } : {})} />{dialogEl}</>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Programs</h3>
          <ReadOnlyNote show={!!me.data && !canWrite} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
          {can(me.data, 'org:write') && <Button type="button" variant="outline" onClick={() => setLoading(!loading)}>Load from workbook</Button>}
          {canWrite && <Button type="button" onClick={() => setDialog({ program: null })}>Add program</Button>}
        </div>
      </div>
      {error && !dialog && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {loading && <WorkbookLoader {...(outcomes ? { api: outcomes } : {})} onDone={() => setLoading(false)} />}
      {programs.isError && <p role="alert">Could not load programs.</p>}
      {programs.data && rows.length === 0 && <p className="text-muted-foreground">No programs visible to you yet.</p>}
      <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Programs">
        {rows.map((p) => (
          <li key={p.id} className="px-4 py-3" data-testid="program">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <ContentText className="font-medium" data-testid="program-name">{p.nameAr ?? p.nameEn}</ContentText>
                {p.nameAr && <ContentText className="ms-2 text-sm text-muted-foreground">{p.nameEn}</ContentText>}
                <p className="text-xs text-muted-foreground">{p.code ? `${p.code} · ` : ''}{LEVEL[p.degreeLevel]} · {unitName.get(p.orgUnitId) ?? 'Unknown unit'}{p.discipline ? ` · ${p.discipline}` : ''}{p.tags.length > 0 && ` · tags: ${p.tags.join(', ')}`}</p>
              </div>
              {!p.active && <span className="rounded border border-border px-2 py-0.5 text-xs">Inactive</span>}
              <Button type="button" variant="outline" className="px-2 py-1" aria-label={`Outcomes of ${p.nameEn}`} onClick={() => setOutcomesOf(p.id)}>Outcomes</Button>
              {canWrite && (
                <>
                  <Button type="button" variant="ghost" className="px-2 py-1" aria-label={`Edit ${p.nameEn}`} onClick={() => setDialog({ program: p })}>Edit</Button>
                  <Button type="button" variant="ghost" className="px-2 py-1" onClick={() => run.mutate(() => api.updateProgram(p.id, { active: !p.active }))}>{p.active ? 'Deactivate' : 'Reactivate'}</Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {dialogEl}
    </div>
  );
}
