// The Tree view of the org chart: the shared tree layer (components/tree: drag and drop with before / inside / after drop lines,
// keyboard drag, multi-select, bulk delete to the Trash with an in-app question and an Undo toast, collapse, roving tabindex,
// drag overlay) over the org units. A row says the name (Arabic beneath), type, head, programs, lock and source.
import { useCallback, useMemo, type ReactNode } from 'react';
import { type QueryClient } from '@tanstack/react-query';
import { ORG_MAX_DEPTH, type OrgChart, type OrgUnit, type OrgUnitType } from '@ams/shared';
import { BulkBar, RowGutter, TreeProvider, TreeRow, TreeToolbar, useRowFocus, type TreeAdapter, type TreeItem } from '../../../components/tree/tree';
import { ContentText } from '../../../components/content-text';
import { Button } from '../../../components/ui/button';
import type { SettingsApi } from '../../../lib/settings-api';
import { applyUpdates } from '../../../lib/tree-dnd';
import { headLabel } from './chart-model';

export const ORG_CHART_KEY = ['org-chart'] as const;

/** How the shared tree moves and deletes org units, and how the cached chart looks right after a drop. */
export function orgTreeAdapter(api: SettingsApi): TreeAdapter {
  return {
    queryKey: ORG_CHART_KEY,
    limits: { maxLevels: ORG_MAX_DEPTH, noun: 'unit' },
    moveMany: (moves) => api.moveOrgUnits({ moves }),
    deleteIds: async (ids, title, confirm) => {
      const preview = await api.previewDeleteOrgUnits(ids); // refused (409) while programs are attached: the reason reaches the screen
      const ok = await confirm({ title, message: preview.message, confirmLabel: 'Delete', tone: 'danger' });
      if (!ok) return false;
      await api.deleteOrgUnits(ids);
      return true;
    },
    applyOptimistic: (qc: QueryClient, _rows, updates) => {
      const before = qc.getQueryData<OrgChart>([...ORG_CHART_KEY]);
      if (before) {
        const next = applyUpdates(before.units.map((u) => ({ ...u, code: u.nameEn })), updates);
        qc.setQueryData<OrgChart>([...ORG_CHART_KEY], { ...before, units: next as OrgUnit[] });
      }
      return () => { qc.setQueryData([...ORG_CHART_KEY], before); };
    },
    moveTo: false,
    noun: 'unit',
  };
}

export const unitItems = (units: readonly OrgUnit[]): TreeItem[] => units.map((u) => ({ id: u.id, parentId: u.parentId, displayOrder: u.displayOrder, code: u.nameEn, title: u.nameAr }));

function UnitRowBody({ unit, typeLabel, depth, editable, onOpen, onAddChild }: {
  unit: OrgUnit; typeLabel: string; depth: number; editable: boolean; onOpen: (id: string) => void; onAddChild: (u: OrgUnit) => void;
}) {
  const focus = useRowFocus(unit.id);
  const head = headLabel(unit);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-background py-1 pe-2 hover:bg-muted/50" data-testid="org-unit" data-depth={depth}>
      <RowGutter id={unit.id} />
      <button type="button" {...focus} onClick={() => onOpen(unit.id)} aria-label={`Open ${unit.nameEn}`}
        className="min-w-0 flex-1 basis-40 rounded px-1 py-0.5 text-start focus-visible:outline-2 focus-visible:outline-primary">
        <ContentText className={`block break-words text-sm font-medium ${unit.active ? '' : 'text-muted-foreground line-through'}`}>{unit.nameEn}</ContentText>
        {unit.nameAr && <ContentText className="block break-words text-sm text-muted-foreground">{unit.nameAr}</ContentText>}
      </button>
      <span className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="rounded-full border border-border px-2 py-0.5" data-testid="unit-type-chip">{typeLabel}</span>
        {head && <span className="text-muted-foreground" data-testid="unit-head"><span className="sr-only">Head: </span><ContentText>{head}</ContentText></span>}
        <span className="text-muted-foreground" data-testid="unit-programs-count">{unit.programCount} {unit.programCount === 1 ? 'program' : 'programs'}</span>
        {unit.locked && <span role="img" aria-label="Locked" title="Locked: imports and directory sync never change it" data-testid="unit-lock">🔒</span>}
        <span className="rounded border border-dashed border-border px-1.5 text-muted-foreground" title={`Source: ${unit.source}`} data-testid="unit-source">{unit.source}</span>
        {!unit.active && <span className="rounded border border-border px-1.5">Inactive</span>}
      </span>
      {editable && <Button type="button" variant="ghost" className="px-2 py-1" aria-label={`Add a unit under ${unit.nameEn}`} onClick={() => onAddChild(unit)}>＋</Button>}
    </div>
  );
}

export function OrgTreeView({ api, units, types, editable, reason, collapsed, onCollapse, onOpen, onAddChild, onNotice, onError, error, notice }: {
  api: SettingsApi; units: OrgUnit[]; types: OrgUnitType[]; editable: boolean; reason: string; collapsed: ReadonlySet<string>;
  onCollapse: (id: string, collapsed: boolean) => void; onOpen: (id: string) => void; onAddChild: (u: OrgUnit) => void;
  onNotice: (t: string) => void; onError: (t: string) => void; error: string; notice: ReactNode;
}) {
  const adapter = useMemo(() => orgTreeAdapter(api), [api]);
  const rows = useMemo(() => unitItems(units), [units]);
  const typeLabel = useMemo(() => new Map(types.map((t) => [t.key, t.labelEn] as const)), [types]);
  const childrenOf = useMemo(() => {
    const m = new Map<string | null, OrgUnit[]>();
    for (const u of units) m.set(u.parentId, [...(m.get(u.parentId) ?? []), u]);
    return m;
  }, [units]);
  const shown = useMemo(() => {
    const hidden = new Set<string>();
    const out: string[] = [];
    for (const u of units) {
      if (u.parentId && (collapsed.has(u.parentId) || hidden.has(u.parentId))) { hidden.add(u.id); continue; }
      out.push(u.id);
    }
    return out;
  }, [units, collapsed]);
  const label = useCallback((r: TreeItem) => r.code, []);

  const branch = (parent: string | null, depth: number): ReactNode => (childrenOf.get(parent) ?? []).map((u) => {
    const kids = (childrenOf.get(u.id)?.length ?? 0) > 0 && !collapsed.has(u.id);
    return (
      <div role="listitem" key={u.id} className="space-y-1.5">
        <TreeRow id={u.id}>
          <UnitRowBody unit={u} typeLabel={typeLabel.get(u.type) ?? u.type} depth={depth} editable={editable} onOpen={onOpen} onAddChild={onAddChild} />
        </TreeRow>
        {kids && <div role="list" aria-label={`Sub-units of ${u.nameEn}`} className="ms-6 space-y-1.5 border-s-2 border-border ps-3">{branch(u.id, depth + 1)}</div>}
      </div>
    );
  });

  return (
    <TreeProvider adapter={adapter} rows={rows} shown={shown} editable={editable} reason={reason} label={label} noun={{ one: 'unit', many: 'units' }}
      collapsed={collapsed} onCollapse={onCollapse} onNotice={onNotice} onError={onError}>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2"><TreeToolbar /></div>
        <BulkBar rows={rows} />
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {notice}
        {units.length === 0 && <p className="text-sm text-muted-foreground">No units yet.</p>}
        <div role="list" aria-label="Org chart" className="space-y-1.5">{branch(null, 0)}</div>
      </div>
    </TreeProvider>
  );
}
