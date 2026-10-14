// Settings -> Organization -> Institution -> Org chart (TASK-072): one set of units, two views. "Tree" is the editor (drag and
// drop, multi-select, bulk delete to the Trash, keyboard); "Chart" draws the same units top-down with zoom, pan and collapse
// and exports as an image, as SVG, or prints to one page. A unit opens in a drawer; "Unit types" configures the levels.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { defaultCollapsed } from '@ams/shared';
import { DocsTab } from '../../../components/docs';
import { ReadOnlyNote } from '../../../components/read-only-note';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { useDocumentsApi, type DocumentsApi } from '../../../lib/documents-api';
import type { SettingsApi } from '../../../lib/settings-api';
import { downloadBlob, svgToPng } from './chart-export';
import { OrgChartView, type ChartHandle } from './org-chart-view';
import { ORG_CHART_KEY, OrgTreeView, unitItems } from './org-tree-view';
import { UnitDrawer, type DrawerMode } from './unit-drawer';
import { UnitTypesManager } from './unit-types-manager';

export type ChartViewName = 'tree' | 'chart';
const VIEWS: { id: ChartViewName; label: string }[] = [{ id: 'tree', label: 'Tree' }, { id: 'chart', label: 'Chart' }];

/** What "Export as image" and "Export as SVG" use; tests replace them. */
export interface ChartExporters {
  png: (svg: string, size: { width: number; height: number }) => Promise<Blob>;
  save: (blob: Blob, filename: string) => void;
  print: () => void;
}
export const defaultExporters: ChartExporters = { png: (svg, size) => svgToPng(svg, size), save: downloadBlob, print: () => window.print() };

const readRtl = () => typeof document !== 'undefined' && getComputedStyle(document.documentElement).direction === 'rtl';

export type OrgChartSectionName = 'chart' | 'docs';
const SECTIONS: { id: OrgChartSectionName; label: string }[] = [{ id: 'chart', label: 'Chart' }, { id: 'docs', label: 'Docs' }];

export function OrgChartSection({ api, canEdit, onOpenPrograms, exporters = defaultExporters, initialView = 'tree', initialSection = 'chart', docs: docsOverride }: {
  api: SettingsApi; canEdit: boolean; onOpenPrograms: () => void; exporters?: ChartExporters; initialView?: ChartViewName; initialSection?: OrgChartSectionName; docs?: DocumentsApi;
}) {
  const qc = useQueryClient();
  const docs = useDocumentsApi(docsOverride);
  const [section, setSection] = useState<OrgChartSectionName>(initialSection);
  const targets = useQuery({ queryKey: ['import-targets', 'org_chart'], queryFn: () => docs.targets({ kind: 'org_chart', id: null }), enabled: section === 'docs' });
  // An import applied (or undone) in Docs changes the units: the chart is read again when the person comes back to it.
  const chooseSection = (id: OrgChartSectionName) => { setSection(id); if (id === 'chart') void qc.invalidateQueries({ queryKey: [...ORG_CHART_KEY] }); };
  const { data, isLoading } = useQuery({ queryKey: [...ORG_CHART_KEY], queryFn: () => api.orgChart() });
  const units = useMemo(() => data?.units ?? [], [data]);
  const types = useMemo(() => data?.types ?? [], [data]);
  const [view, setView] = useState<ChartViewName>(initialView);
  const [drawer, setDrawer] = useState<DrawerMode | null>(null);
  const [typesOpen, setTypesOpen] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [exportNote, setExportNote] = useState('');
  const [treeCollapsed, setTreeCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [chartCollapsed, setChartCollapsed] = useState<ReadonlySet<string> | null>(null);
  const [printSvg, setPrintSvg] = useState<string | null>(null);
  const chart = useRef<ChartHandle>(null);
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Read when the chart is shown, so the mirror follows the interface direction at that moment.
  const rtl = useMemo(readRtl, [view]);
  const people = useQuery({ queryKey: ['people'], queryFn: () => api.people(), enabled: drawer !== null });

  // The chart opens with branches deeper than level 3 collapsed when it is big; after that the person's choices stand.
  useEffect(() => {
    if (chartCollapsed === null && data) setChartCollapsed(defaultCollapsed(unitItems(data.units)));
  }, [data, chartCollapsed]);
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: [...ORG_CHART_KEY] }), [qc]);
  const flip = (set: ReadonlySet<string>, id: string, collapsed: boolean) => { const n = new Set(set); if (collapsed) n.add(id); else n.delete(id); return n; };
  const onTreeCollapse = useCallback((id: string, c: boolean) => setTreeCollapsed((s) => flip(s, id, c)), []);
  const onChartToggle = useCallback((id: string) => setChartCollapsed((s) => flip(s ?? new Set(), id, !(s ?? new Set()).has(id))), []);
  const openUnit = useCallback((id: string) => { const u = units.find((x) => x.id === id); if (u) setDrawer({ kind: 'edit', unit: u }); }, [units]);
  const current = drawer?.kind === 'edit' ? (units.find((u) => u.id === drawer.unit.id) ?? drawer.unit) : null;

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const rtlNow = getComputedStyle(e.currentTarget).direction === 'rtl';
    const i = VIEWS.findIndex((v) => v.id === view);
    const fwd = rtlNow ? 'ArrowLeft' : 'ArrowRight';
    const back = rtlNow ? 'ArrowRight' : 'ArrowLeft';
    const next = e.key === fwd ? (i + 1) % VIEWS.length : e.key === back ? (i + VIEWS.length - 1) % VIEWS.length : e.key === 'Home' ? 0 : e.key === 'End' ? VIEWS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setView(VIEWS[next]!.id);
    tabs.current[VIEWS[next]!.id]?.focus();
  };

  const exportAs = async (kind: 'png' | 'svg') => {
    setExportNote(''); setError('');
    try {
      const { svg, width, height } = await chart.current!.exportSvg();
      const blob = kind === 'svg' ? new Blob([svg], { type: 'image/svg+xml' }) : await exporters.png(svg, { width, height });
      exporters.save(blob, kind === 'svg' ? 'org-chart.svg' : 'org-chart.png');
      setExportNote(`Saved org-chart.${kind}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The chart could not be exported.');
    }
  };
  const print = async () => {
    setError('');
    try { setPrintSvg((await chart.current!.exportSvg()).svg.replace(/^<\?xml[^>]*\?>\s*/, '')); } catch (e) { setError(e instanceof Error ? e.message : 'The chart could not be printed.'); }
  };
  // Print once the sheet is on the page; take it off afterwards.
  useEffect(() => {
    if (printSvg === null) return undefined;
    document.body.classList.add('org-chart-printing');
    const done = () => { document.body.classList.remove('org-chart-printing'); setPrintSvg(null); };
    window.addEventListener('afterprint', done, { once: true });
    const t = setTimeout(() => exporters.print(), 50);
    return () => { clearTimeout(t); window.removeEventListener('afterprint', done); document.body.classList.remove('org-chart-printing'); };
  }, [printSvg, exporters]);

  const reason = 'You need permission to edit the organization to select, move or delete units.';
  const noticeEl = notice ? (
    <p className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-900" data-testid="tree-notice">
      <span className="min-w-0 flex-1 break-words">{notice}</span>
      <button type="button" aria-label="Dismiss" className="shrink-0 underline" onClick={() => setNotice('')}>Dismiss</button>
    </p>
  ) : null;

  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">Org chart</h3>
        <div role="tablist" aria-label="Org chart sections" className="flex gap-1">
          {SECTIONS.map((o) => (
            <button key={o.id} id={`org-section-${o.id}`} role="tab" type="button" aria-selected={section === o.id} aria-controls="org-section-panel" onClick={() => chooseSection(o.id)}
              className={`rounded-md px-3 py-1 text-sm ${section === o.id ? 'bg-muted font-medium' : 'text-muted-foreground'}`}>{o.label}</button>
          ))}
        </div>
        {section === 'chart' && <div role="group" aria-label="Org chart view" className="ms-auto flex rounded-md border border-border p-0.5">
          {VIEWS.map((v) => (
            <button key={v.id} ref={(el) => { tabs.current[v.id] = el; }} id={`org-view-${v.id}`} type="button" aria-pressed={view === v.id} aria-controls="org-view-panel"
              onClick={() => setView(v.id)} onKeyDown={onTabKey}
              className={`rounded px-3 py-1 text-sm ${view === v.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>{v.label}</button>
          ))}
        </div>}
      </div>
      {section === 'docs' ? (
        <div role="tabpanel" id="org-section-panel" aria-labelledby="org-section-docs" className="mt-3">
          <p className="mb-3 text-sm text-muted-foreground">Upload a picture or PDF of your org chart. The AI reading model proposes the units; you review them beside the image and apply them as one change you can undo. The image and the names on it go to the AI reading model.</p>
          <DocsTab scopeKind="org_chart" scopeId={null} targets={targets.data ?? []} canWrite={canEdit} api={docs} />
        </div>
      ) : (<>
      <p className="mb-3 text-sm text-muted-foreground">Colleges, schools, departments and administrative units, each with a head and its programs. Roles can be given for a whole unit.</p>
      <ReadOnlyNote show={!canEdit} className="mb-3" />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {canEdit && <Button type="button" disabled={!data} onClick={() => setDrawer({ kind: 'add', parent: null })}>Add unit</Button>}
        <Button type="button" variant="outline" onClick={() => setTypesOpen(true)}>Unit types</Button>
        {view === 'chart' && (
          <>
            <Button type="button" variant="ghost" onClick={() => setChartCollapsed(new Set())} disabled={units.length === 0}>Expand all</Button>
            <Button type="button" variant="ghost" onClick={() => setChartCollapsed(defaultCollapsed(unitItems(units), { threshold: 0 }))} disabled={units.length === 0}>Collapse deep branches</Button>
            <Button type="button" variant="outline" onClick={() => void exportAs('png')} disabled={units.length === 0}>Export as image</Button>
            <Button type="button" variant="outline" onClick={() => void exportAs('svg')} disabled={units.length === 0}>Export as SVG</Button>
            <Button type="button" variant="outline" onClick={() => void print()} disabled={units.length === 0}>Print / save as PDF</Button>
          </>
        )}
        <span className="text-xs text-muted-foreground">{units.length} {units.length === 1 ? 'unit' : 'units'}</span>
        {exportNote && <span role="status" className="text-xs text-emerald-800">{exportNote}</span>}
      </div>
      <div id="org-view-panel" role="region" aria-label={view === 'tree' ? 'Org chart tree' : 'Org chart drawing'}>
        {isLoading || !data ? <p className="text-sm text-muted-foreground">Loading…</p> : view === 'tree' ? (
          <OrgTreeView api={api} units={units} types={types} editable={canEdit} reason={reason} collapsed={treeCollapsed} onCollapse={onTreeCollapse} onOpen={openUnit}
            onAddChild={(u) => setDrawer({ kind: 'add', parent: u })} onNotice={setNotice} onError={setError} error={error} notice={noticeEl} />
        ) : (
          <>
            {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
            <OrgChartView ref={chart} units={units} types={types} collapsed={chartCollapsed ?? new Set()} onToggle={onChartToggle} onOpen={openUnit} selectedId={current?.id ?? null} rtl={rtl} />
          </>
        )}
      </div>
      </>)}
      {drawer && (
        <UnitDrawer key={current?.id ?? `add-${drawer.kind === 'add' ? (drawer.parent?.id ?? 'top') : ''}`} api={api} mode={current ? { kind: 'edit', unit: current } : drawer}
          types={types} people={people.data ?? []} editable={canEdit} onClose={() => setDrawer(null)} onSaved={refresh} onOpenPrograms={onOpenPrograms} />
      )}
      {typesOpen && <UnitTypesManager api={api} types={types} editable={canEdit} onChanged={refresh} onClose={() => setTypesOpen(false)} />}
      {printSvg !== null && createPortal(<div className="org-chart-print-sheet" data-testid="print-sheet" dangerouslySetInnerHTML={{ __html: printSvg }} />, document.body)}
    </Card>
  );
}
