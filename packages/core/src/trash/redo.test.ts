// The Redo of a restore (TASK-065): which request deletes again what each kind of Trash item brought back.
import { describe, expect, it } from 'vitest';
import { redeleteDescriptor } from './redo.js';
import type { TrashPayload } from './rows.js';

const payload = (root: Record<string, unknown>, tables: TrashPayload['tables'] = {}, meta?: Record<string, unknown>): TrashPayload =>
  ({ v: 1, tables, files: [], refs: [], root, ...(meta ? { meta } : {}) });
const item = (kind: string, p: TrashPayload, label = 'Thing') => ({ kind, label, payload: p });

describe('redeleteDescriptor', () => {
  it('requirements: one delete of every root, or Delete all for a whole version, or the merge again', () => {
    expect(redeleteDescriptor([item('requirement', payload({ rootIds: ['a'] })), item('requirement', payload({ rootIds: ['b'] }))]))
      .toMatchObject({ method: 'POST', path: '/api/requirements/delete', body: { ids: ['a', 'b'] } });
    expect(redeleteDescriptor([item('requirement', payload({ versionId: 'v', rootIds: ['a', 'b'], all: true }))]))
      .toMatchObject({ path: '/api/framework-versions/v/requirements/delete-all' });
    const merged = payload({ rootIds: ['a'] }, {}, { merge: { intoId: 't', useMergedWording: true } });
    expect(redeleteDescriptor([item('requirement', merged)])).toMatchObject({ path: '/api/requirements/a/merge', body: { intoId: 't', useMergedWording: true } });
    // A restore that did not revert the merge deletes the restored requirement instead.
    expect(redeleteDescriptor([item('requirement', merged)], { revertMerge: false })).toMatchObject({ path: '/api/requirements/delete', body: { ids: ['a'] } });
  });

  it('each single-item kind names its own delete', () => {
    const one = (kind: string, p: TrashPayload) => redeleteDescriptor([item(kind, p)]);
    expect(one('note', payload({}, { requirement_note: [{ id: 'n' }] }))).toMatchObject({ method: 'DELETE', path: '/api/notes/n' });
    expect(one('source_document', payload({ documentId: 'd' }))).toMatchObject({ method: 'DELETE', path: '/api/source-documents/d' });
    expect(one('source_page', payload({ documentId: 'd', pageNo: 3 }))).toMatchObject({ path: '/api/source-documents/d/pages/3' });
    expect(one('report_template', payload({ versionId: 'v', key: 'self study' }))).toMatchObject({ path: '/api/framework-versions/v/report-templates/self%20study' });
    expect(one('framework_version', payload({ versionId: 'v' }))).toMatchObject({ path: '/api/framework-versions/v' });
    expect(one('framework', payload({ frameworkId: 'f' }))).toMatchObject({ path: '/api/frameworks/f' });
    expect(one('mapping', payload({}, { requirement_mapping: [{ id: 'm' }] }))).toMatchObject({ path: '/api/mappings/m' });
    expect(one('evidence_link', payload({}, { evidence_link: [{ id: 'e' }] }))).toMatchObject({ path: '/api/evidence-links/e' });
    expect(one('milestone', payload({}, { milestone: [{ id: 'x' }] }))).toMatchObject({ path: '/api/milestones/x' });
  });

  it('offers nothing it cannot say as one request, and labels what was restored', () => {
    expect(redeleteDescriptor([])).toBeNull();
    expect(redeleteDescriptor([item('note', payload({})), item('mapping', payload({}))])).toBeNull();
    expect(redeleteDescriptor([item('note', payload({}))])).toBeNull(); // no id in the payload
    expect(redeleteDescriptor([item('milestone', payload({}, { milestone: [{ id: 'x' }] }), 'Site visit')])!.label).toBe('Restored Site visit');
  });
});
