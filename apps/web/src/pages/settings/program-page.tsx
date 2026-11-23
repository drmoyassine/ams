import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEGREE_LEVELS, PROGRAM_MODES, PROGRAM_TYPES, PROGRAM_TYPE_LABEL, languageInfo, type OrgUnit, type OrgUnitType, type Program } from '@ams/shared';
import { Breadcrumb } from '../../components/breadcrumb';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { patchOf } from '../../components/outcomes/outcome-list';
import { OutcomeRows, type OutcomeRow } from '../../components/outcomes/outcome-rows';
import { can, useMe } from '../../lib/me';
import { useOutcomesApi, type OutcomesApi } from '../../lib/outcomes-api';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import type { SyllabusApi } from '../../lib/syllabus-api';
import { useAction } from '../../lib/use-action';
import { RecordedOutcomes } from './program-outcomes';
import { RequirementsSection } from './requirements';
import { useCatalogApi, type CatalogApi } from '../../lib/catalog-api';
import { CurriculumMapPage } from './curriculum-map';

export const LEVEL = { associate: 'Associate', bachelor: 'Bachelor', master: 'Master', doctorate: 'Doctorate', diploma: 'Diploma', certificate: 'Certificate' } as const;
export const MODE = { on_campus: 'On-campus', online: 'Online', blended: 'Blended' } as const;
const PROGRAMS_HREF = '/settings/programs';

/** The org chart as indented choices, parents before children, so a program can sit at any level (a college, a school, a department). */
export function unitChoices(units: OrgUnit[], types: OrgUnitType[], keep?: string): { id: string; label: string }[] {
  const typeName = new Map(types.map((t) => [t.key, t.labelEn]));
  const kids = (parent: string | null) => units.filter((u) => u.parentId === parent && (u.active || u.id === keep)).sort((a, b) => a.displayOrder - b.displayOrder || a.nameEn.localeCompare(b.nameEn));
  const out: { id: string; label: string }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const u of kids(parent)) { out.push({ id: u.id, label: `${'   '.repeat(depth)}${depth ? '└ ' : ''}${u.nameEn} (${typeName.get(u.type) ?? u.type})` }); walk(u.id, depth + 1); }
  };
  walk(null, 0);
  // A unit whose parent is not visible still appears, at the top.
  for (const u of units) if ((u.active || u.id === keep) && !out.some((o) => o.id === u.id)) out.push({ id: u.id, label: `${u.nameEn} (${typeName.get(u.type) ?? u.type})` });
  return out;
}

interface Values {
  nameEn: string; nameAr: string; orgUnitId: string; degreeLevel: Program['degreeLevel']; code: string; externalId: string; mode: string;
  credits: string; durationYears: string; contactHours: string; languageOfInstruction: string; mission: string; vision: string; programType: Program['programType'];
  description: string; descriptionAr: string; coordinatorUserId: string;
}
const valuesOf = (p?: Program): Values => ({
  nameEn: p?.nameEn ?? '', nameAr: p?.nameAr ?? '', orgUnitId: p?.orgUnitId ?? '', degreeLevel: p?.degreeLevel ?? 'bachelor', code: p?.code ?? '', externalId: p?.externalId ?? '',
  mode: p?.mode ?? '', credits: p?.credits?.toString() ?? '', durationYears: p?.durationYears?.toString() ?? '', contactHours: p?.contactHours?.toString() ?? '',
  languageOfInstruction: p?.languageOfInstruction ?? '', mission: p?.mission ?? '', vision: p?.vision ?? '', programType: p?.programType ?? 'degree',
  description: p?.description ?? '', descriptionAr: p?.descriptionAr ?? '', coordinatorUserId: p?.coordinatorUserId ?? '',
});
/** Everything is required except the vision and the SIS code (the owner, 2026-11-16); and at least one PEO and one PLO. */
const REQUIRED: [keyof Values, string][] = [
  ['nameEn', 'Name (English)'], ['nameAr', 'Name (Arabic)'], ['orgUnitId', 'Unit'], ['code', 'Program code'], ['mode', 'Mode'], ['credits', 'Credits'],
  ['durationYears', 'Years'], ['contactHours', 'Contact hours'], ['languageOfInstruction', 'Language'], ['mission', 'Mission'], ['description', 'Description (English)'],
];
/** A minor has no mode, years or contact hours of its own (and no PEOs). */
const MINOR_SKIPS = new Set<keyof Values>(['mode', 'durationYears', 'contactHours']);
const num = (s: string) => (s.trim() === '' ? null : Number(s));

/**
 * A program on a page of its own (Settings -> Organization -> Programs -> the program), addressable as /settings/programs/<id>
 * or /new: its record in the owner's order, then its PEOs and PLOs (recorded ones edited in place, new ones typed as rows). The page refuses
 * to save without the required fields; an import or the API saves and flags what is missing instead.
 */
/** The program page's tabs (the owner, 2026-11-23); a new program shows Basic Information and its first outcomes on one page. */
export const PROGRAM_TABS = [
  { key: 'basic', label: 'Basic Information' }, { key: 'outcomes', label: 'Outcomes' }, { key: 'requirements', label: 'Degree Requirements' },
  { key: 'plan', label: 'Study Plan' }, { key: 'map', label: 'Curriculum Map' },
] as const;
export type ProgramTab = (typeof PROGRAM_TABS)[number]['key'];

export function ProgramPage({ programId, api: override, outcomes, syllabus, catalog, onSaved, onCancel, tab, view, onTab }: {
  programId: string | 'new'; api?: SettingsApi; outcomes?: OutcomesApi; syllabus?: SyllabusApi; catalog?: CatalogApi; onSaved: (id: string) => void; onCancel: () => void;
  /** The tab (and the map's view), in the address; without onTab the page keeps its own. */
  tab?: ProgramTab; view?: 'course' | 'plo' | undefined; onTab?: (tab: ProgramTab, view?: 'course' | 'plo') => void;
}) {
  const api = useSettingsApi(override);
  const me = useMe(api);
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.programs() });
  const isNew = programId === 'new';
  const program = isNew ? undefined : programs.data?.find((p) => p.id === programId);
  if (!isNew && !program) return <p className="text-sm text-muted-foreground">{programs.data ? 'This program is not there, or you may not see it.' : programs.isError ? 'Could not load the program.' : 'Loading…'}</p>;
  // The form is made again when the saved record changes (after a save), so what is being typed is never overwritten by a refetch.
  return (
    <ProgramForm key={program ? JSON.stringify(program) : 'new'} program={program} canWrite={can(me.data, 'program:write')} api={api}
      {...(outcomes ? { outcomes } : {})} {...(syllabus ? { syllabus } : {})} {...(catalog ? { catalog } : {})} onSaved={onSaved} onCancel={onCancel}
      tab={tab ?? 'basic'} view={view} {...(onTab ? { onTab } : {})} />
  );
}

function ProgramForm({ program, canWrite, api, outcomes, syllabus, catalog, onSaved, onCancel, tab: tabProp, view, onTab }: {
  program?: Program; canWrite: boolean; api: SettingsApi; outcomes?: OutcomesApi; syllabus?: SyllabusApi; catalog?: CatalogApi; onSaved: (id: string) => void; onCancel: () => void;
  tab: ProgramTab; view?: 'course' | 'plo' | undefined; onTab?: (tab: ProgramTab, view?: 'course' | 'plo') => void;
}) {
  const [ownTab, setOwnTab] = useState<ProgramTab>(tabProp);
  const tab = onTab ? tabProp : ownTab;
  const pickTab = (t: ProgramTab) => (onTab ? onTab(t) : setOwnTab(t));
  const people = useQuery({ queryKey: ['people'], queryFn: () => api.people(), staleTime: 60_000 });
  const reqs = useQuery({ queryKey: ['requirements', program?.id], queryFn: () => catalogApi.requirements(program!.id), enabled: !!program });
  const oapi = useOutcomesApi(outcomes);
  const catalogApi = useCatalogApi(catalog);
  const qc = useQueryClient();
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.orgUnits() });
  const types = useQuery({ queryKey: ['org-unit-types'], queryFn: () => api.orgUnitTypes() });
  const langs = useQuery({ queryKey: ['languages'], queryFn: () => api.languagesSettings() });
  const recorded = useQuery({ queryKey: ['program-outcomes', program?.id], queryFn: () => oapi.programOutcomes(program!.id), enabled: !!program });
  const [v, setV] = useState<Values>(() => valuesOf(program));
  const [peos, setPeos] = useState<OutcomeRow[]>([]);
  const [plos, setPlos] = useState<OutcomeRow[]>([]);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const set = (k: keyof Values) => (e: { target: { value: string } }) => { setSaved(false); setV({ ...v, [k]: e.target.value }); };

  const secondary = languageInfo(langs.data?.secondaryLanguage)?.nameEn;
  const languages = ['English', ...(secondary ? [secondary, 'Bilingual'] : ['Bilingual'])];
  if (v.languageOfInstruction && !languages.includes(v.languageOfInstruction)) languages.push(v.languageOfInstruction);
  const hasPeos = (recorded.data?.peos.length ?? 0) + peos.filter((r) => r.textEn.trim()).length > 0;
  const hasPlos = (recorded.data?.plos.length ?? 0) + plos.filter((r) => r.textEn.trim()).length > 0;
  const uncoded = [...peos, ...plos].some((r) => r.textEn.trim() && !r.code.trim());
  const minor = v.programType === 'minor';
  const missing = [...REQUIRED.filter(([k]) => !(minor && MINOR_SKIPS.has(k)) && !v[k].trim()).map(([, l]) => l), ...(hasPeos || minor ? [] : ['at least one PEO']), ...(hasPlos || minor ? [] : ['at least one PLO']), ...(uncoded ? ['a code for each new PEO and PLO'] : [])];
  const bad = (k: keyof Values) => tried && !v[k].trim();
  const field = 'flex min-w-0 flex-col gap-1 text-xs';
  const control = (k: keyof Values) => `h-9 w-full min-w-0 max-w-full rounded-md border bg-background px-2 text-sm ${bad(k) ? 'border-red-600' : 'border-border'}`;
  const req = <span className="text-red-700" aria-hidden="true"> *</span>;

  const save = async () => {
    setTried(true); setSaved(false);
    if (missing.length) { setError(`Fill in: ${missing.join(', ')}.`); return; }
    setSaving(true); setError(null);
    const body = {
      orgUnitId: v.orgUnitId, nameEn: v.nameEn.trim(), degreeLevel: v.degreeLevel, code: v.code.trim(), externalId: v.externalId.trim() || null,
      mode: v.mode as Program['mode'], credits: num(v.credits), durationYears: num(v.durationYears), contactHours: num(v.contactHours),
      languageOfInstruction: v.languageOfInstruction, mission: v.mission.trim(), vision: v.vision.trim() || null, programType: v.programType,
      description: v.description.trim(), descriptionAr: v.descriptionAr.trim() || null, coordinatorUserId: v.coordinatorUserId || null,
    };
    const result = await act(() => (program ? api.updateProgram(program.id, { ...body, nameAr: v.nameAr.trim() }) : api.createProgram({ ...body, nameAr: v.nameAr.trim() })));
    if (result === undefined) { setSaving(false); return; }
    const id = (result as Program).id;
    // The new PEOs and PLOs, one after the other; the first that fails stops the rest and stays on the page with what is left.
    const todo = [...peos.map((r) => ({ kind: 'peo' as const, r })), ...plos.map((r) => ({ kind: 'plo' as const, r }))].filter((x) => x.r.textEn.trim());
    for (const [n, { kind, r }] of todo.entries()) {
      const d = { code: r.code.trim(), textEn: r.textEn.trim(), textAr: r.textAr.trim(), bloomLevel: '', status: 'draft', approvedOn: '' };
      const ok = await act(() => oapi.createOutcome({ kind, programId: id, ...patchOf(d), code: d.code, textEn: d.textEn }));
      if (ok === undefined) {
        const left = todo.slice(n);
        setPeos(left.filter((x) => x.kind === 'peo').map((x) => x.r)); setPlos(left.filter((x) => x.kind === 'plo').map((x) => x.r));
        setSaving(false);
        void qc.invalidateQueries({ queryKey: ['programs'] }); void qc.invalidateQueries({ queryKey: ['program-outcomes', id] });
        if (!program) onSaved(id);
        return;
      }
    }
    setPeos([]); setPlos([]); setSaving(false); setSaved(true); setTried(false);
    await qc.invalidateQueries({ queryKey: ['program-outcomes', id] });
    await qc.invalidateQueries({ queryKey: ['programs'] });
    if (!program) onSaved(id);
  };

  const title = program ? program.nameEn : 'New program';
  const missingRecord = (program?.missing ?? []).filter((m) => m !== 'PEOs' && m !== 'PLOs').length;
  const missingOutcomes = (program?.missing ?? []).filter((m) => m === 'PEOs' || m === 'PLOs').length;
  const count: Partial<Record<ProgramTab, number>> = { basic: missingRecord, outcomes: missingOutcomes, requirements: reqs.data?.issues.length ?? 0 };
  // A tab is made the first time it is opened and kept, so what is typed in one survives a visit to another.
  const [seen, setSeen] = useState<Set<ProgramTab>>(() => new Set([tab]));
  if (!seen.has(tab)) setSeen(new Set([...seen, tab]));
  const shows = (t: ProgramTab) => !program || tab === t;
  const formTab = !program || tab === 'basic' || tab === 'outcomes';
  const basic = (
      <form id="program-form" aria-label={program ? 'Program' : 'New program'} className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (canWrite) void save(); }}>
        <Card>
          <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2" disabled={!canWrite}>
            <legend className="mb-2 text-base font-semibold">The program</legend>
            <label className={field}><span>Name (English){req}</span><Input aria-label="Name (English)" aria-invalid={bad('nameEn')} value={v.nameEn} onChange={set('nameEn')} autoFocus={!program} /></label>
            <label className={field}><span>Name (Arabic){req}</span><Input aria-label="Name (Arabic)" aria-invalid={bad('nameAr')} dir="auto" value={v.nameAr} onChange={set('nameAr')} /></label>
            <label className={`${field} sm:col-span-2`}><span>Unit (a college, school or department in the org chart){req}</span>
              <select aria-label="Unit" aria-invalid={bad('orgUnitId')} className={control('orgUnitId')} value={v.orgUnitId} onChange={set('orgUnitId')}>
                <option value="">Choose a unit</option>
                {unitChoices(units.data ?? [], types.data ?? [], program?.orgUnitId).map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
            </label>
            <div className="grid min-w-0 gap-3 sm:col-span-2 sm:grid-cols-4">
              <label className={field}><span>Type</span>
                <select aria-label="Program type" className={control('degreeLevel')} value={v.programType} onChange={set('programType')}>
                  {PROGRAM_TYPES.map((t) => <option key={t} value={t}>{PROGRAM_TYPE_LABEL[t]}</option>)}
                </select>
              </label>
              <label className={field}><span>Program level{req}</span>
                <select aria-label="Program level" className={control('degreeLevel')} value={v.degreeLevel} onChange={set('degreeLevel')}>
                  {DEGREE_LEVELS.map((d) => <option key={d} value={d}>{LEVEL[d]}</option>)}
                </select>
              </label>
              <label className={field}><span>Program code{req}</span><Input aria-label="Program code" aria-invalid={bad('code')} value={v.code} placeholder="BS-ECE" onChange={set('code')} /></label>
              <label className={field}><span>SIS code (optional)</span><Input aria-label="SIS code" value={v.externalId} onChange={set('externalId')} />
                <span className="text-muted-foreground">The program's code in the student information system, to match its records.</span>
              </label>
            </div>
            <label className={`${field} sm:col-span-2`}><span>Program Coordinator</span>
              <select aria-label="Program Coordinator" className={control('coordinatorUserId')} value={v.coordinatorUserId} onChange={set('coordinatorUserId')}>
                <option value="">Not named</option>
                {(people.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </select>
              <span className="text-muted-foreground">Who coordinates the program. Naming them grants no permission by itself.</span>
            </label>
          </fieldset>
        </Card>
        <Card>
          <fieldset className="grid min-w-0 gap-3" disabled={!canWrite}>
            <legend className="mb-2 text-base font-semibold">Delivery</legend>
            <label className={`${field} sm:max-w-xs`}><span>Mode{req}</span>
              <select aria-label="Mode" aria-invalid={bad('mode')} className={control('mode')} value={v.mode} onChange={set('mode')}>
                <option value="">Choose</option>
                {PROGRAM_MODES.map((m) => <option key={m} value={m}>{MODE[m]}</option>)}
              </select>
            </label>
            <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4">
              <label className={field}><span>Credits{req}</span><Input aria-label="Credits" aria-invalid={bad('credits')} inputMode="numeric" value={v.credits} onChange={set('credits')} /></label>
              <label className={field}><span>Years{req}</span><Input aria-label="Years" aria-invalid={bad('durationYears')} inputMode="decimal" value={v.durationYears} onChange={set('durationYears')} /></label>
              <label className={field}><span>Contact hours (total){req}</span><Input aria-label="Contact hours" aria-invalid={bad('contactHours')} inputMode="numeric" value={v.contactHours} onChange={set('contactHours')} /></label>
              <label className={field}><span>Language{req}</span>
                <select aria-label="Language" aria-invalid={bad('languageOfInstruction')} className={control('languageOfInstruction')} value={v.languageOfInstruction} onChange={set('languageOfInstruction')}>
                  <option value="">Choose</option>
                  {languages.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
            </div>
          </fieldset>
        </Card>
        <Card>
          <fieldset className="grid min-w-0 gap-3" disabled={!canWrite}>
            <legend className="mb-2 text-base font-semibold">Program description</legend>
            <label className={field}><span>Description (English){req}</span><textarea aria-label="Description (English)" aria-invalid={bad('description')} rows={4} className={`rounded-md border bg-background px-2 py-1 text-sm ${bad('description') ? 'border-red-600' : 'border-border'}`} value={v.description} onChange={set('description')} /></label>
            <label className={field}><span>Description (Arabic, optional)</span><textarea aria-label="Description (Arabic)" dir="auto" rows={3} className="rounded-md border border-border bg-background px-2 py-1 text-sm" value={v.descriptionAr} onChange={set('descriptionAr')} /></label>
            <span className="text-xs text-muted-foreground">The catalog prints it under the program&apos;s name.</span>
          </fieldset>
        </Card>
        <Card>
          <fieldset className="grid min-w-0 gap-3" disabled={!canWrite}>
            <legend className="mb-2 text-base font-semibold">Mission and vision</legend>
            <label className={field}><span>Mission{req}</span><textarea aria-label="Mission" aria-invalid={bad('mission')} dir="auto" rows={3} className={`rounded-md border bg-background px-2 py-1 text-sm ${bad('mission') ? 'border-red-600' : 'border-border'}`} value={v.mission} onChange={set('mission')} /></label>
            <label className={field}><span>Vision (optional)</span><textarea aria-label="Vision" dir="auto" rows={2} className="rounded-md border border-border bg-background px-2 py-1 text-sm" value={v.vision} onChange={set('vision')} /></label>
          </fieldset>
        </Card>
      </form>
  );
  const outcomesBox = (
      <Card>
        <div className="space-y-4">
          <OutcomeRows label="PEO" title={`Program educational objectives (PEOs)${minor ? '' : ' *'}`} codeHint="PEO1" rows={peos} existing={recorded.data?.peos ?? []} onChange={setPeos}
            {...(program ? { recorded: <RecordedOutcomes programId={program.id} kind="peo" canWrite={canWrite} {...(outcomes ? { api: outcomes } : {})} {...(syllabus ? { syllabus } : {})} /> } : {})} />
          <OutcomeRows label="PLO" title={`Program learning outcomes (PLOs)${minor ? '' : ' *'}`} codeHint="PLO1" rows={plos} existing={recorded.data?.plos ?? []} onChange={setPlos}
            {...(program ? { recorded: <RecordedOutcomes programId={program.id} kind="plo" canWrite={canWrite} {...(outcomes ? { api: outcomes } : {})} {...(syllabus ? { syllabus } : {})} /> } : {})} />
          {plos.length > 0 && <p className="text-xs text-muted-foreground">Links to ILOs and PEOs, performance indicators, and courses and CLOs are added under a PLO once it is saved.</p>}
        </div>
      </Card>
  );
  return (
    <div className="space-y-4">
      <Breadcrumb items={[{ label: 'Settings', href: '/settings' }, { label: 'Programs', href: PROGRAMS_HREF }, { label: title }]} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="min-w-0 text-xl font-semibold break-words">{title}{program && !program.active && <span className="ms-2 rounded border border-border px-2 py-0.5 align-middle text-xs font-normal">Inactive</span>}</h2>
        {canWrite && formTab && <Button type="submit" form="program-form" variant="outline" disabled={saving} aria-label={`${program ? 'Save' : 'Add program'} (top)`}>{saving ? 'Saving…' : program ? 'Save' : 'Add program'}</Button>}
      </div>
      {program && program.missing.length > 0 && (
        <p role="note" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">This record was saved without: {program.missing.join(', ')}. Fill them in to save it here.</p>
      )}
      {program && (
        <div role="tablist" aria-label="Program" className="flex gap-1 overflow-x-auto border-b border-border">
          {PROGRAM_TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => pickTab(t.key)}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === t.key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              {t.label}{(count[t.key] ?? 0) > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-xs font-normal text-amber-900" aria-label={`${count[t.key]} to look at`}>{count[t.key]}</span>}
            </button>
          ))}
        </div>
      )}
      <div role={program ? 'tabpanel' : undefined} aria-label={program ? PROGRAM_TABS.find((t) => t.key === tab)!.label : undefined} className="space-y-4">
        <div hidden={!shows('basic')}>
          <section aria-label="Basic information" className="space-y-4">
            {program && <h3 className="text-lg font-semibold">Basic Information</h3>}
            {basic}
          </section>
        </div>
        {/* Outcomes sit after the form: an outcome edited in place has a form of its own, and forms do not nest; Save submits by the form's id. */}
        <div hidden={!shows('outcomes')}>{outcomesBox}</div>
        {program && seen.has('requirements') && <div hidden={tab !== 'requirements'}><RequirementsSection part="requirements" programId={program.id} canWrite={canWrite} {...(catalog ? { catalog } : {})} {...(outcomes ? { outcomes } : {})} /></div>}
        {program && seen.has('plan') && <div hidden={tab !== 'plan'}><RequirementsSection part="plan" programId={program.id} canWrite={canWrite} {...(catalog ? { catalog } : {})} {...(outcomes ? { outcomes } : {})} /></div>}
        {program && seen.has('map') && (
          <div hidden={tab !== 'map'}>
            <CurriculumMapPage fixed program={program.id} view={view} api={api} {...(outcomes ? { outcomes } : {})} {...(syllabus ? { syllabus } : {})}
              {...(onTab ? { onPick: (m: { view?: 'course' | 'plo' }) => onTab('map', m.view) } : {})} />
          </div>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {saved && <p role="status" className="text-sm text-emerald-800">Saved.</p>}
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        {canWrite && formTab && <Button type="submit" form="program-form" disabled={saving}>{saving ? 'Saving…' : program ? 'Save' : 'Add program'}</Button>}
        <Button type="button" variant="ghost" onClick={onCancel}>{saved || !canWrite ? 'Back to programs' : 'Cancel'}</Button>
      </div>
    </div>
  );
}
