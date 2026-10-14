// The descriptor that deletes again what a restore just put back (DEC-026, TASK-065). A restore is the Undo of a delete, so
// the request that undoes a delete answers with this (the chain tags it as the Redo); a restore made from the Trash page
// offers it as its own Undo. Built from the payloads read before the rows are marked restored. Ids come back unchanged,
// so deleting by id works even when a code was renamed. `null` = no safe way to say it as one request (no Redo is offered).
import type { UndoDescriptor } from '@ams/shared';
import type { TrashPayload } from './rows.js';

export interface RestoredItem { kind: string; label: string; payload: TrashPayload }

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const first = (p: TrashPayload, table: keyof TrashPayload['tables']): string | null => str((p.tables[table] ?? [])[0]?.id);

export function redeleteDescriptor(items: RestoredItem[], opts: { revertMerge?: boolean } = {}): UndoDescriptor | null {
  if (!items.length) return null;
  const label = items.length === 1 ? `Restored ${items[0]!.label}` : `Restored ${items.length} items`;
  const d = (method: UndoDescriptor['method'], path: string, body?: unknown): UndoDescriptor => ({ label, method, path, ...(body === undefined ? {} : { body }) });

  // Requirements (one group may hold several top-level ones): one delete of all their roots.
  if (items.every((i) => i.kind === 'requirement')) {
    if (items.length === 1) {
      const p = items[0]!.payload;
      const root = p.root as { versionId?: string; rootIds?: string[]; all?: boolean };
      const merge = p.meta?.merge as { intoId?: string; useMergedWording?: boolean } | undefined;
      if (root.all && str(root.versionId)) return d('POST', `/api/framework-versions/${root.versionId}/requirements/delete-all`);
      if (merge?.intoId && opts.revertMerge !== false && root.rootIds?.[0]) {
        return d('POST', `/api/requirements/${root.rootIds[0]}/merge`, { intoId: merge.intoId, useMergedWording: merge.useMergedWording ?? false });
      }
    }
    const ids = items.flatMap((i) => ((i.payload.root as { rootIds?: string[] }).rootIds ?? []));
    return ids.length ? d('POST', '/api/requirements/delete', { ids }) : null;
  }
  if (items.length !== 1) return null;
  const { kind, payload: p } = items[0]!;
  const root = p.root as Record<string, unknown>;
  switch (kind) {
    case 'note': { const id = first(p, 'requirement_note'); return id ? d('DELETE', `/api/notes/${id}`) : null; }
    case 'source_document': { const id = str(root.documentId); return id ? d('DELETE', `/api/source-documents/${id}`) : null; }
    case 'import_document': { const id = str(root.documentId); return id ? d('DELETE', `/api/documents/${id}`) : null; }
    case 'source_page': { const id = str(root.documentId); return id && typeof root.pageNo === 'number' ? d('DELETE', `/api/source-documents/${id}/pages/${root.pageNo}`) : null; }
    case 'report_template': { const v = str(root.versionId); const k = str(root.key); return v && k ? d('DELETE', `/api/framework-versions/${v}/report-templates/${encodeURIComponent(k)}`) : null; }
    case 'framework_version': { const id = str(root.versionId); return id ? d('DELETE', `/api/framework-versions/${id}`) : null; }
    case 'framework': { const id = str(root.frameworkId); return id ? d('DELETE', `/api/frameworks/${id}`) : null; }
    case 'mapping': { const id = first(p, 'requirement_mapping'); return id ? d('DELETE', `/api/mappings/${id}`) : null; }
    case 'evidence_link': { const id = first(p, 'evidence_link'); return id ? d('DELETE', `/api/evidence-links/${id}`) : null; }
    case 'milestone': { const id = first(p, 'milestone'); return id ? d('DELETE', `/api/milestones/${id}`) : null; }
    default: return null;
  }
}
