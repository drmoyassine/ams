// Trash (DEC-026): snapshot + delete + restore round trips for each kind, the restore rules, groups, bulk and nested
// deletes, the purge, permissions, tenant isolation and the undo descriptors.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { TRASH_RETENTION_DAYS, type UndoDescriptor } from '@ams/shared';
import { ConflictError, ForbiddenError, type Ctx } from '../ctx.js';
import { MemoryStore } from '../evidence/memory-store.js';
import {
  addNote, addQualityItem, addSourceDocument, addSourcePage, createAccreditor, createFramework, createRequirement, createVersion, deleteNote, deleteSourceDocument,
  deleteSourcePage, indentRequirement, mergeRequirement, moveRequirement, setUpQualityFramework, splitRequirement, unsplitRequirement, updateRequirement,
  uploadSourceFile, upsertReportTemplate, deleteReportTemplate, updateNote,
} from '../framework/index.js';
import { createMapping, deleteMapping } from '../mapping/mapping.js';
import { purgeTrashTick } from '../jobs/purge-trash.js';
import {
  countTrash, deleteAllRequirements, deleteForever, deleteFramework, deleteMany, deleteVersion, emptyTrash, getTrashGroup, listTrash, previewDelete, restoreTrash,
} from './index.js';

let db: TestDb;
let pool: pg.Pool;
const store = new MemoryStore();
const ids = {} as Record<string, string>;
const noQueue = { send: async () => undefined };
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const q = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows;

type Who = 'admin' | 'lead' | 'reviewer' | 'viewer' | 'outsider';
let lastUndo: UndoDescriptor | undefined;
const run = <T>(who: Who, fn: (ctx: Ctx) => Promise<T>): Promise<T> => {
  const institutionId = who === 'outsider' ? ids.other! : ids.inst!;
  const caller = { userId: ids[who]!, institutionId, requestId: crypto.randomUUID(), actorType: 'user' as const };
  const hooks: (() => Promise<void>)[] = [];
  return withIdentity(pool, caller, (tx) => fn({ tx, caller, queue: noQueue, store, afterCommit: (f) => { hooks.push(f); }, undo: (d) => { lastUndo = d; } })).then(async (out) => {
    for (const h of hooks) await h();
    return out;
  });
};

let counter = 0;
/** A standard of its own, so its codes are not shared with the other tests' versions (links are keyed by code within a standard). */
const freshFramework = async (name: string) => (await run('lead', (c) => createFramework(c, { accreditorId: ids.acc!, name, scope: 'institution' }))).id;
/** A draft external version with: Standard 1 (AI-made) > CFR 1.1 > CFR 1.1.1, a note on CFR 1.1 (manual) and one on Standard 1 (AI). */
async function draft(label: string, frameworkId: string = ids.fw!) {
  counter += 1;
  const v = await run('lead', (c) => createVersion(c, { frameworkId, edition: `${label}-${counter}` }));
  const std = await run('lead', (c) => createRequirement(c, { versionId: v.id, code: 'Standard 1', levelLabel: 'Standard', title: 'Purposes' }));
  const cfr = await run('lead', (c) => createRequirement(c, { versionId: v.id, parentId: std.id, code: 'CFR 1.1', levelLabel: 'CFR', title: 'Mission', officialText: 'The institution has a mission.' }));
  const sub = await run('lead', (c) => createRequirement(c, { versionId: v.id, parentId: cfr.id, code: 'CFR 1.1.1', levelLabel: 'CFR', title: 'Review of the mission' }));
  const note = await run('lead', (c) => addNote(c, { requirementId: cfr.id, type: 'guidance', text: 'Show the mission statement.', authority: 'suggested' }));
  // AI-made rows (made by the analysis, so the database remembers when a person deletes them).
  await db.su.query(`update requirement set origin = 'ai' where id = $1`, [std.id]);
  const aiNote = await one(`insert into requirement_note (institution_id, requirement_id, type, text, authority, origin) values ($1, $2, 'guidance', 'AI-suggested wording', 'ai_suggested', 'ai') returning id`, [ids.inst, std.id]);
  return { v, std, cfr, sub, note, aiNote };
}
let iqfVersion: string | undefined;
/** An item of the institution's own quality framework (draft), made on first use. */
async function iqfItem(code: string, title: string) {
  if (!iqfVersion) iqfVersion = (await run('lead', (c) => setUpQualityFramework(c, { template: false }))).versions[0]!.id;
  const vid = iqfVersion;
  return run('lead', (c) => addQualityItem(c, vid, { code, title }));
}
const live = async (versionId: string) => (await q(`select id, code, parent_id from requirement where framework_version_id = $1 order by code`, [versionId]));
const publish = async (versionId: string) => {
  // The publish gate wants every AI-made row to cite its source; these test rows are a person's.
  await db.su.query(`update requirement_note set origin = 'manual' where requirement_id in (select id from requirement where framework_version_id = $1)`, [versionId]);
  await db.su.query(`update requirement set origin = 'manual' where framework_version_id = $1`, [versionId]);
  await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [versionId]);
  await db.su.query(`update framework_version set status = 'published', published_by = $2, published_at = now() where id = $1`, [versionId, ids.admin]);
};

beforeAll(async () => {
  db = await createTestDb('trashcore');
  pool = new pg.Pool({ connectionString: db.url });
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('V') returning id`);
  for (const [who, role, inst] of [['admin', 'admin', ids.inst], ['lead', 'lead', ids.inst], ['reviewer', 'reviewer', ids.inst], ['viewer', 'viewer', ids.inst], ['outsider', 'admin', ids.other]] as const) {
    ids[who] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [inst, `${who}@x.org`]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [inst, ids[who], role]);
  }
  const acc = await run('lead', (c) => createAccreditor(c, { name: 'Invented Council', shortName: 'IC', type: 'institutional' }));
  ids.acc = acc.id;
  ids.fw = (await run('lead', (c) => createFramework(c, { accreditorId: acc.id, name: 'Handbook', scope: 'institution' }))).id;
}, 30000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('delete a requirement with its subtree, then restore it', () => {
  it('snapshots the subtree, notes and AI dismissals, deletes them in one step, and puts everything back with the same ids', async () => {
    const x = await draft('rt');
    const before = await live(x.v.id);
    const preview = await run('lead', (c) => previewDelete(c, { ids: [x.std.id] }));
    expect(preview).toMatchObject({ roots: 1, counts: { items: 1, subItems: 2, notes: 2 } });
    expect(preview.message).toBe(`Delete Standard 1 and its 2 sub-items and 2 notes? You can restore them from the Trash for ${TRASH_RETENTION_DAYS} days.`);

    const res = await run('lead', (c) => deleteMany(c, { ids: [x.std.id] }));
    expect(res).toMatchObject({ label: 'Deleted Standard 1 and 2 sub-items', counts: { items: 1, subItems: 2, notes: 2 }, items: 1 });
    expect(lastUndo).toMatchObject({ method: 'POST', path: `/api/trash/groups/${res.groupId}/restore`, label: 'Deleted Standard 1 and 2 sub-items' });
    expect(await live(x.v.id)).toEqual([]);
    expect(await q(`select id from requirement_note where requirement_id = any($1)`, [[x.std.id, x.cfr.id]])).toEqual([]);

    // The row says what, where, who and when it expires.
    const [row] = await q(`select kind, label, context, counts, deleted_by, expires_at, deleted_at, restored_at from trash_item where group_id = $1`, [res.groupId]);
    expect(row).toMatchObject({ kind: 'requirement', label: 'Standard 1 · Purposes', context: expect.stringContaining('Handbook'), deleted_by: ids.lead, restored_at: null });
    expect(Math.round((row.expires_at.getTime() - row.deleted_at.getTime()) / 86400000)).toBe(TRASH_RETENTION_DAYS);
    // The AI-made rows are remembered as dismissed (so a new analysis run does not add them back) while they are in the Trash.
    expect((await q(`select kind, code from analysis_dismissal where framework_version_id = $1 order by kind`, [x.v.id])).map((r) => r.kind)).toEqual(['note', 'requirement']);
    // The audit trail shows the delete of every row, by the person.
    const del = await q(`select actor_id from audit_event where action = 'delete' and target_type = 'requirement' and target_id = any($1)`, [[x.std.id, x.cfr.id, x.sub.id]]);
    expect(del).toHaveLength(3);
    expect(del.every((e) => e.actor_id === ids.lead)).toBe(true);

    const back = await run('lead', (c) => restoreTrash(c, { groupId: res.groupId }));
    expect(back).toMatchObject({ restored: { requirements: 3, notes: 2 }, renamed: [], dropped: {} });
    expect(await live(x.v.id)).toEqual(before);
    expect((await q(`select id from requirement_note where requirement_id = any($1) order by text`, [[x.std.id, x.cfr.id]])).map((r) => r.id).sort()).toEqual([x.note.id, x.aiNote].sort());
    // Restoring clears the dismissals: the analysis can see the AI-made rows again.
    expect(await q(`select id from analysis_dismissal where framework_version_id = $1`, [x.v.id])).toEqual([]);
    // Restore is audited as inserts by the person.
    expect((await q(`select actor_id from audit_event where action = 'insert' and target_type = 'requirement' and target_id = $1 order by at desc limit 1`, [x.cfr.id]))[0].actor_id).toBe(ids.lead);
    // The restored row is not listed again, and a second restore finds nothing.
    expect((await run('lead', (c) => listTrash(c))).groups.some((g) => g.groupId === res.groupId)).toBe(false);
    await expect(run('lead', (c) => restoreTrash(c, { groupId: res.groupId }))).rejects.toThrow(/nothing in the Trash/);
  });

  it('counts nested selections once: an id inside another selected id\'s subtree is not a second item', async () => {
    const x = await draft('nest');
    const preview = await run('lead', (c) => previewDelete(c, { ids: [x.std.id, x.cfr.id, x.sub.id] }));
    expect(preview).toMatchObject({ roots: 1, counts: { items: 1, subItems: 2, notes: 2 } });
    const res = await run('lead', (c) => deleteMany(c, { ids: [x.std.id, x.cfr.id, x.sub.id] }));
    expect(res.items).toBe(1);
    expect(await q(`select id from trash_item where group_id = $1`, [res.groupId])).toHaveLength(1);
    await run('lead', (c) => restoreTrash(c, { groupId: res.groupId }));
    expect(await live(x.v.id)).toHaveLength(3);
  });

  it('deletes several separate selections in one action and restores them together', async () => {
    const x = await draft('multi');
    const std2 = await run('lead', (c) => createRequirement(c, { versionId: x.v.id, code: 'Standard 2', levelLabel: 'Standard', title: 'Resources', displayOrder: 1 }));
    const res = await run('lead', (c) => deleteMany(c, { ids: [x.cfr.id, std2.id] }));
    expect(res).toMatchObject({ items: 2, counts: { items: 2, subItems: 1 } });
    expect(res.label).toBe('Deleted CFR 1.1, Standard 2 and 1 sub-item');
    expect((await live(x.v.id)).map((r) => r.code)).toEqual(['Standard 1']);
    const groups = (await run('lead', (c) => listTrash(c))).groups.filter((g) => g.groupId === res.groupId);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(2);
    // Opening the group shows the subtree.
    const open = await run('lead', (c) => getTrashGroup(c, res.groupId));
    const rows = open.contents.flatMap((c) => c.rows.map((r) => `${' '.repeat(r.depth)}${r.label}`));
    expect(rows).toEqual(expect.arrayContaining(['CFR 1.1 · Mission', ' CFR 1.1.1 · Review of the mission', 'Standard 2 · Resources']));
    await run('lead', (c) => restoreTrash(c, { groupId: res.groupId }));
    expect((await live(x.v.id)).map((r) => r.code)).toEqual(['CFR 1.1', 'CFR 1.1.1', 'Standard 1', 'Standard 2']);
  });

  it('deletes all the requirements of a draft as one item and restores them', async () => {
    const x = await draft('all');
    await run('lead', (c) => createRequirement(c, { versionId: x.v.id, code: 'Standard 2', levelLabel: 'Standard', title: 'Resources', displayOrder: 1 }));
    const res = await run('lead', (c) => deleteAllRequirements(c, x.v.id));
    expect(res.label).toMatch(/^Deleted all 4 standards in IC Handbook all-\d+/);
    expect(await live(x.v.id)).toEqual([]);
    const items = await q(`select label, counts from trash_item where group_id = $1`, [res.groupId]);
    expect(items).toHaveLength(1);
    expect(items[0].label).toMatch(/^All 4 standards/);
    await run('lead', (c) => restoreTrash(c, { groupId: res.groupId }));
    expect(await live(x.v.id)).toHaveLength(4);
    await run('lead', (c) => deleteAllRequirements(c, x.v.id));
    await expect(run('lead', (c) => deleteAllRequirements(c, x.v.id))).rejects.toThrow(/nothing to delete/);
  });

  it('refuses to delete in a published version, as before', async () => {
    const x = await draft('frozen-del');
    await publish(x.v.id);
    await expect(run('lead', (c) => deleteMany(c, { ids: [x.cfr.id] }))).rejects.toThrow(ConflictError);
    await expect(run('lead', (c) => deleteAllRequirements(c, x.v.id))).rejects.toThrow(/immutable/);
    await expect(run('lead', (c) => deleteVersion(c, x.v.id))).rejects.toThrow(/immutable/);
    expect(await live(x.v.id)).toHaveLength(3);
  });
});

describe('restore rules', () => {
  it('is refused when the version is no longer a draft, saying so', async () => {
    const x = await draft('rule-frozen');
    const res = await run('lead', (c) => deleteMany(c, { ids: [x.sub.id] }));
    await db.su.query(`delete from requirement_note where requirement_id in (select id from requirement where framework_version_id = $1)`, [x.v.id]);
    await db.su.query(`update requirement set review_status = 'approved' where framework_version_id = $1`, [x.v.id]);
    await publish(x.v.id);
    await expect(run('lead', (c) => restoreTrash(c, { groupId: res.groupId }))).rejects.toThrow('Cannot restore: the version is no longer a draft (it is published)');
    expect(await live(x.v.id)).toHaveLength(2);
    // Still in the Trash, untouched.
    expect((await run('lead', (c) => listTrash(c))).groups.some((g) => g.groupId === res.groupId)).toBe(true);
  });

  it('offers a choice when the parent is gone: the nearest ancestor that still exists, or the top level', async () => {
    const x = await draft('rule-parent');
    const child = await run('lead', (c) => deleteMany(c, { ids: [x.sub.id] }));
    const mid = await run('lead', (c) => deleteMany(c, { ids: [x.cfr.id] }));
    const err = await run('lead', (c) => restoreTrash(c, { groupId: child.groupId })).catch((e: unknown) => e) as ConflictError;
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/CFR 1\.1 · Mission no longer exists/);
    expect(err.details).toMatchObject({ code: 'parent_missing', parentLabel: 'CFR 1.1 · Mission', nearestAncestor: { id: x.std.id, label: 'Standard 1 · Purposes' } });
    // Put it under the nearest living ancestor.
    const placed = await run('lead', (c) => restoreTrash(c, { groupId: child.groupId }, { placeParentId: x.std.id }));
    expect(placed.placedUnder).toBe('Standard 1');
    expect((await live(x.v.id)).find((r) => r.code === 'CFR 1.1.1')!.parent_id).toBe(x.std.id);
    // Or at the top level; or restore the parent first.
    const other = await draft('rule-parent2');
    const c2 = await run('lead', (c) => deleteMany(c, { ids: [other.sub.id] }));
    await run('lead', (c) => deleteMany(c, { ids: [other.cfr.id] }));
    const top = await run('lead', (c) => restoreTrash(c, { groupId: c2.groupId }, { atTopLevel: true }));
    expect(top.placedUnder).toBe('the top level');
    expect((await live(other.v.id)).find((r) => r.code === 'CFR 1.1.1')!.parent_id).toBeNull();
    // Restoring the middle one first leaves nothing to choose.
    await run('lead', (c) => restoreTrash(c, { groupId: mid.groupId }));
    expect((await live(x.v.id)).find((r) => r.code === 'CFR 1.1')!.parent_id).toBe(x.std.id);
  });

  it('gives the restored one the next free code when its code was taken, or refuses when asked to', async () => {
    const x = await draft('rule-code');
    const res = await run('lead', (c) => deleteMany(c, { ids: [x.sub.id] }));
    await run('lead', (c) => createRequirement(c, { versionId: x.v.id, parentId: x.cfr.id, code: 'CFR 1.1.1', levelLabel: 'CFR', title: 'A new one' }));
    const refused = await run('lead', (c) => restoreTrash(c, { groupId: res.groupId }, { codeConflict: 'refuse' })).catch((e: unknown) => e) as ConflictError;
    expect(refused.details).toMatchObject({ code: 'code_taken' });
    expect(await live(x.v.id)).toHaveLength(3);
    const back = await run('lead', (c) => restoreTrash(c, { groupId: res.groupId }));
    expect(back.renamed).toEqual([{ from: 'CFR 1.1.1', to: 'CFR 1.1.1 (restored)' }]);
    expect(back.message).toContain('CFR 1.1.1 was taken in the meantime, so it is now CFR 1.1.1 (restored)');
    expect((await live(x.v.id)).map((r) => r.code)).toEqual(['CFR 1.1', 'CFR 1.1.1', 'CFR 1.1.1 (restored)', 'Standard 1']);
    // A second time it is "(restored 2)".
    const restoredId = (await live(x.v.id)).find((r) => r.code === 'CFR 1.1.1 (restored)')!.id as string;
    const again = await run('lead', (c) => deleteMany(c, { ids: [restoredId] }));
    await run('lead', (c) => createRequirement(c, { versionId: x.v.id, parentId: x.cfr.id, code: 'CFR 1.1.1 (restored)', levelLabel: 'CFR', title: 'Squatter' }));
    const back2 = await run('lead', (c) => restoreTrash(c, { groupId: again.groupId }));
    expect(back2.renamed[0]!.to).toBe('CFR 1.1.1 (restored) (restored)');
  });

  it('drops links to other standards whose other side is gone, and counts them', async () => {
    const iqv = await iqfItem('1', 'Mission');
    const x = await draft('rule-map', await freshFramework('Mapped standard'));
    const m = await run('lead', (c) => createMapping(c, x.v.id, { externalRequirementId: x.cfr.id, internalRequirementId: iqv.id, relation: 'covers' }));
    expect(m.externalCode).toBe('CFR 1.1');
    // Deleting the external requirement takes its link with it; restoring brings both back.
    const res = await run('lead', (c) => deleteMany(c, { ids: [x.cfr.id] }));
    expect(res.counts).toMatchObject({ mappings: 1 });
    expect(await q(`select id from requirement_mapping where id = $1`, [m.id])).toEqual([]);
    const ok = await run('lead', (c) => restoreTrash(c, { groupId: res.groupId }));
    expect(ok.restored).toMatchObject({ mappings: 1 });
    expect(await q(`select id from requirement_mapping where id = $1`, [m.id])).toHaveLength(1);
    // Delete it again, then remove the internal item for good: the link cannot come back and is counted as dropped.
    const res2 = await run('lead', (c) => deleteMany(c, { ids: [x.cfr.id] }));
    await run('lead', (c) => deleteMany(c, { ids: [iqv.id] }));
    const back = await run('lead', (c) => restoreTrash(c, { groupId: res2.groupId }));
    expect(back.dropped).toEqual({ mappings: 1 });
    expect(back.message).toContain('1 link to other standards could not be brought back');
    expect(await q(`select id from requirement_mapping where id = $1`, [m.id])).toEqual([]);
  });

  it('keeps a link while another version of the standard still has the code', async () => {
    const x = await draft('rule-map-v');
    const iqItem = await iqfItem('2', 'Governance');
    const m = await run('lead', (c) => createMapping(c, x.v.id, { externalRequirementId: x.cfr.id, internalRequirementId: iqItem.id, relation: 'partly_covers' }));
    // Another version of the same standard has CFR 1.1 too.
    const v2 = await run('lead', (c) => createVersion(c, { frameworkId: ids.fw!, edition: `copy-${counter++}` }));
    await run('lead', (c) => createRequirement(c, { versionId: v2.id, code: 'CFR 1.1', levelLabel: 'CFR', title: 'Mission' }));
    const res = await run('lead', (c) => deleteMany(c, { ids: [x.cfr.id] }));
    expect(res.counts).toMatchObject({ mappings: 0 });
    expect(await q(`select id from requirement_mapping where id = $1`, [m.id])).toHaveLength(1);
  });

  it('drops a citation of a source that was deleted meanwhile instead of failing', async () => {
    const x = await draft('rule-src');
    const doc = await run('lead', (c) => addSourceDocument(c, { versionId: x.v.id, title: 'Handbook', role: 'standards', authority: 'binding' }));
    await run('lead', (c) => addSourcePage(c, { documentId: doc.id, pageNo: 1, method: 'pdf_text', text: 'The institution has a mission.' }));
    await db.su.query(`update requirement set source_document_id = $2, source_page = 1, source_quote = 'has a mission', quote_verified = true where id = $1`, [x.cfr.id, doc.id]);
    const res = await run('lead', (c) => deleteMany(c, { ids: [x.cfr.id] }));
    await run('lead', (c) => deleteSourceDocument(c, doc.id));
    const back = await run('lead', (c) => restoreTrash(c, { groupId: res.groupId }));
    expect(back.message).toContain('1 citation of a source that was deleted in the meantime could not be kept');
    const [r] = await q(`select source_document_id, quote_verified from requirement where id = $1`, [x.cfr.id]);
    expect(r).toEqual({ source_document_id: null, quote_verified: false });
  });
});

describe('notes, pages, source documents, templates, links', () => {
  it('restores a note, and says so when its requirement is gone', async () => {
    const x = await draft('note');
    await run('lead', (c) => deleteNote(c, x.note.id));
    expect(lastUndo).toMatchObject({ path: expect.stringContaining('/api/trash/groups/'), label: 'Deleted a note on CFR 1.1' });
    expect(await q(`select id from requirement_note where id = $1`, [x.note.id])).toEqual([]);
    const [{ group_id }] = await q(`select group_id from trash_item where kind = 'note' order by created_at desc limit 1`);
    await run('lead', (c) => restoreTrash(c, { groupId: group_id }));
    expect((await q(`select text from requirement_note where id = $1`, [x.note.id]))[0].text).toBe('Show the mission statement.');
    await run('lead', (c) => deleteNote(c, x.note.id));
    await run('lead', (c) => deleteMany(c, { ids: [x.cfr.id] }));
    const [{ group_id: g2 }] = await q(`select group_id from trash_item where kind = 'note' order by created_at desc limit 1`);
    await expect(run('lead', (c) => restoreTrash(c, { groupId: g2 }))).rejects.toThrow(/requirement this note belonged to \(CFR 1\.1 · Mission\) no longer exists/);
  });

  it('keeps the original file of a deleted source until the item is purged, and restores the document with its pages', async () => {
    const x = await draft('src');
    const doc = await run('lead', (c) => addSourceDocument(c, { versionId: x.v.id, title: 'Standards PDF', role: 'standards', authority: 'binding' }));
    await run('lead', (c) => addSourcePage(c, { documentId: doc.id, pageNo: 1, method: 'pdf_text', text: 'Page one.' }));
    await run('lead', (c) => addSourcePage(c, { documentId: doc.id, pageNo: 2, method: 'pdf_text', text: 'Page two.' }));
    const up = await run('lead', (c) => uploadSourceFile(c, doc.id, { fileName: 'standards.pdf', mime: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.7 hello') }));
    expect(store.objects.has(up.filePath)).toBe(true);
    const res = await run('lead', (c) => deleteSourceDocument(c, doc.id));
    expect(res).toMatchObject({ label: 'Deleted Standards PDF and its 2 pages', counts: { pages: 2 } });
    expect(await q(`select id from source_document where id = $1`, [doc.id])).toEqual([]);
    expect(store.objects.has(up.filePath)).toBe(true); // the file is NOT deleted with the row
    await run('lead', (c) => restoreTrash(c, { groupId: res.groupId }));
    expect(await q(`select page_no from source_page where source_document_id = $1 order by page_no`, [doc.id])).toEqual([{ page_no: 1 }, { page_no: 2 }]);
    expect(store.objects.has(up.filePath)).toBe(true);
    // Delete again and let it expire: the purge removes the row and the file.
    await run('lead', (c) => deleteSourceDocument(c, doc.id));
    await db.su.query(`update trash_item set expires_at = now() - interval '1 minute' where payload -> 'files' ? $1`, [up.filePath]);
    const r = await purgeTrashTick(pool, { store });
    expect(r).toMatchObject({ failed: 0 });
    expect(r.files).toBe(1);
    expect(store.objects.has(up.filePath)).toBe(false);
    expect(await q(`select id from trash_item where payload -> 'files' ? $1`, [up.filePath])).toEqual([]);
  });

  it('restores a page, a report template and a link between standards', async () => {
    const x = await draft('misc');
    const doc = await run('lead', (c) => addSourceDocument(c, { versionId: x.v.id, title: 'Doc', role: 'standards', authority: 'binding' }));
    await run('lead', (c) => addSourcePage(c, { documentId: doc.id, pageNo: 3, method: 'pdf_text', text: 'Three.' }));
    await run('lead', (c) => deleteSourcePage(c, doc.id, 3));
    expect(await q(`select id from source_page where source_document_id = $1`, [doc.id])).toEqual([]);
    await run('lead', (c) => addSourcePage(c, { documentId: doc.id, pageNo: 3, method: 'pdf_text', text: 'Again.' }));
    const [{ group_id }] = await q(`select group_id from trash_item where kind = 'source_page' order by created_at desc limit 1`);
    await expect(run('lead', (c) => restoreTrash(c, { groupId: group_id }))).rejects.toThrow('Cannot restore: page 3 has been added again.');

    await run('lead', (c) => upsertReportTemplate(c, x.v.id, { key: 'report', name: 'Self-study', kind: 'self_study', structure: { sections: [{ key: 'A', title: 'Intro', block_type: 'narrative' }] } }));
    await run('lead', (c) => deleteReportTemplate(c, x.v.id, 'report'));
    expect(await q(`select id from report_template where framework_version_id = $1`, [x.v.id])).toEqual([]);
    const [{ group_id: tg }] = await q(`select group_id from trash_item where kind = 'report_template' order by created_at desc limit 1`);
    await run('lead', (c) => restoreTrash(c, { groupId: tg }));
    expect((await q(`select key from report_template where framework_version_id = $1`, [x.v.id]))[0].key).toBe('report');

    const item = await iqfItem('3', 'Resources');
    const m = await run('lead', (c) => createMapping(c, x.v.id, { externalRequirementId: x.std.id, internalRequirementId: item.id, relation: 'covers' }));
    await run('lead', (c) => deleteMapping(c, m.id));
    expect(await q(`select id from requirement_mapping where id = $1`, [m.id])).toEqual([]);
    const [{ group_id: mg }] = await q(`select group_id from trash_item where kind = 'mapping' order by created_at desc limit 1`);
    await run('lead', (c) => restoreTrash(c, { groupId: mg }));
    expect(await q(`select id from requirement_mapping where id = $1`, [m.id])).toHaveLength(1);
  });
});

describe('versions and standards', () => {
  it('deletes a draft version with everything in it and brings it back as a draft', async () => {
    const x = await draft('ver');
    const doc = await run('lead', (c) => addSourceDocument(c, { versionId: x.v.id, title: 'Doc', role: 'standards', authority: 'binding' }));
    await run('lead', (c) => addSourcePage(c, { documentId: doc.id, pageNo: 1, method: 'pdf_text', text: 'One.' }));
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [x.v.id]);
    const res = await run('lead', (c) => deleteVersion(c, x.v.id));
    expect(res.counts).toMatchObject({ requirements: 3, notes: 2, documents: 1, pages: 1 });
    expect(await q(`select id from framework_version where id = $1`, [x.v.id])).toEqual([]);
    expect(await q(`select id from analysis_dismissal where framework_version_id = $1`, [x.v.id])).toEqual([]);
    const back = await run('lead', (c) => restoreTrash(c, { groupId: res.groupId }));
    expect(back.restored).toMatchObject({ versions: 1, requirements: 3, notes: 2, documents: 1 });
    expect(back.message).toContain('A version that was in review comes back as a draft');
    expect((await q(`select status from framework_version where id = $1`, [x.v.id]))[0].status).toBe('draft');
    expect(await live(x.v.id)).toHaveLength(3);
    // The AI-made rows are visible to the analysis again (nothing dismissed).
    expect(await q(`select id from analysis_dismissal where framework_version_id = $1`, [x.v.id])).toEqual([]);
  });

  it('never deletes a published or retired version, or one an engagement or another version depends on', async () => {
    const x = await draft('ver-no');
    await publish(x.v.id);
    await expect(run('lead', (c) => deleteVersion(c, x.v.id))).rejects.toThrow(/immutable/);
    const y = await draft('ver-sup');
    const z = await run('lead', (c) => createVersion(c, { frameworkId: ids.fw!, edition: `next-${counter++}` }));
    await db.su.query(`update framework_version set supersedes_id = $1 where id = $2`, [y.v.id, z.id]);
    await expect(run('lead', (c) => deleteVersion(c, y.v.id))).rejects.toThrow(/was made from this one/);
  });

  it('refuses a restore that would clash with an edition added since, and deletes a whole standard with its versions', async () => {
    const fw2 = (await run('lead', (c) => createFramework(c, { accreditorId: ids.acc!, name: 'Second', scope: 'program' }))).id;
    const v1 = await run('lead', (c) => createVersion(c, { frameworkId: fw2, edition: '2030' }));
    await run('lead', (c) => createRequirement(c, { versionId: v1.id, code: '1', levelLabel: 'Standard', title: 'One' }));
    const res = await run('lead', (c) => deleteVersion(c, v1.id));
    await run('lead', (c) => createVersion(c, { frameworkId: fw2, edition: '2030' }));
    await expect(run('lead', (c) => restoreTrash(c, { groupId: res.groupId }))).rejects.toThrow('this standard already has a version 2030');

    const whole = await run('lead', (c) => deleteFramework(c, fw2));
    expect(whole.counts).toMatchObject({ versions: 1 });
    expect(await q(`select id from framework where id = $1`, [fw2])).toEqual([]);
    // Versions cannot come back before the standard does.
    await expect(run('lead', (c) => restoreTrash(c, { groupId: res.groupId }))).rejects.toThrow(/standard this version belonged to was deleted/);
    await run('lead', (c) => restoreTrash(c, { groupId: whole.groupId }));
    expect(await q(`select edition from framework_version where framework_id = $1`, [fw2])).toEqual([{ edition: '2030' }]);
  });
});

describe('who sees what, tenants, removing for good', () => {
  it('lets people with the delete permission see, restore and remove; others see nothing; another institution sees nothing', async () => {
    const x = await draft('perm');
    await expect(run('viewer', (c) => deleteMany(c, { ids: [x.cfr.id] }))).rejects.toThrow(ForbiddenError);
    await expect(run('reviewer', (c) => deleteMany(c, { ids: [x.cfr.id] }))).rejects.toThrow(ForbiddenError);
    const res = await run('lead', (c) => deleteMany(c, { ids: [x.cfr.id] }));
    expect((await run('admin', (c) => listTrash(c))).groups.some((g) => g.groupId === res.groupId)).toBe(true);
    expect((await run('lead', (c) => listTrash(c))).groups.some((g) => g.groupId === res.groupId)).toBe(true);
    expect((await run('viewer', (c) => listTrash(c))).total).toBe(0);
    expect((await run('viewer', (c) => countTrash(c))).count).toBe(0);
    expect((await run('outsider', (c) => listTrash(c))).total).toBe(0);
    await expect(run('viewer', (c) => restoreTrash(c, { groupId: res.groupId }))).rejects.toThrow(/nothing in the Trash/);
    await expect(run('outsider', (c) => restoreTrash(c, { groupId: res.groupId }))).rejects.toThrow(/nothing in the Trash/);
    await expect(run('outsider', (c) => deleteForever(c, { groupId: res.groupId }))).rejects.toThrow(/nothing in the Trash/);
    // Filters.
    expect((await run('lead', (c) => listTrash(c, { kind: 'note' }))).groups.some((g) => g.groupId === res.groupId)).toBe(false);
    expect((await run('lead', (c) => listTrash(c, { q: 'mission' }))).groups.some((g) => g.groupId === res.groupId)).toBe(true);
    expect((await run('lead', (c) => listTrash(c, { q: 'zzzz-nothing' }))).total).toBe(0);
    // A reviewer can restore nothing either (reading is not deleting).
    await expect(run('reviewer', (c) => restoreTrash(c, { groupId: res.groupId }))).rejects.toThrow(/nothing in the Trash/);
  });

  it('removes for good on request, emptying the Trash, and removes the stored file with it', async () => {
    const x = await draft('forever');
    const doc = await run('lead', (c) => addSourceDocument(c, { versionId: x.v.id, title: 'Gone', role: 'standards', authority: 'binding' }));
    const up = await run('lead', (c) => uploadSourceFile(c, doc.id, { fileName: 'gone.pdf', mime: 'application/pdf', bytes: new TextEncoder().encode('%PDF gone') }));
    const res = await run('lead', (c) => deleteSourceDocument(c, doc.id));
    expect(store.objects.has(up.filePath)).toBe(true);
    expect(await run('lead', (c) => deleteForever(c, { groupId: res.groupId }))).toEqual({ removed: 1 });
    expect(store.objects.has(up.filePath)).toBe(false);
    await expect(run('lead', (c) => restoreTrash(c, { groupId: res.groupId }))).rejects.toThrow(/nothing in the Trash/);

    await run('lead', (c) => deleteMany(c, { ids: [x.cfr.id] }));
    const before = (await run('lead', (c) => listTrash(c))).total;
    expect(before).toBeGreaterThan(0);
    const emptied = await run('lead', (c) => emptyTrash(c));
    expect(emptied.removed).toBe(before);
    expect((await run('lead', (c) => listTrash(c))).total).toBe(0);
    expect((await run('outsider', (c) => emptyTrash(c))).removed).toBe(0);
  });

  it('does not list an expired item, and the purge removes only expired ones', async () => {
    const x = await draft('purge');
    const a = await run('lead', (c) => deleteMany(c, { ids: [x.sub.id] }));
    const b = await run('lead', (c) => deleteMany(c, { ids: [x.cfr.id] }));
    await db.su.query(`update trash_item set expires_at = now() - interval '1 day' where group_id = $1`, [a.groupId]);
    expect((await run('lead', (c) => listTrash(c))).groups.map((g) => g.groupId)).toEqual(expect.arrayContaining([b.groupId]));
    expect((await run('lead', (c) => listTrash(c))).groups.map((g) => g.groupId)).not.toContain(a.groupId);
    const r = await purgeTrashTick(pool, { store });
    expect(r.rows).toBeGreaterThanOrEqual(1);
    expect(await q(`select id from trash_item where group_id = $1`, [a.groupId])).toEqual([]);
    expect(await q(`select id from trash_item where group_id = $1`, [b.groupId])).toHaveLength(1);
    // The purge is a system action in the audit trail.
    const ev = await q(`select actor_id, actor_type from audit_event where target_type = 'trash_item' and action = 'delete' order by at desc limit 1`);
    expect(ev[0]).toEqual({ actor_id: null, actor_type: 'system' });
  });
});

describe('undo descriptors', () => {
  it('reports how to take back a move, an edit, an add and a note edit', async () => {
    const x = await draft('undo');
    const other = await run('lead', (c) => createRequirement(c, { versionId: x.v.id, code: 'Standard 2', levelLabel: 'Standard', title: 'Resources', displayOrder: 5 }));
    await run('lead', (c) => moveRequirement(c, x.cfr.id, other.id, 3));
    expect(lastUndo).toEqual({ label: 'Moved CFR 1.1', method: 'POST', path: `/api/requirements/${x.cfr.id}/move`, body: { parentId: x.std.id, displayOrder: 0 } });

    await run('lead', (c) => updateRequirement(c, x.cfr.id, { title: 'New title', officialText: null }));
    expect(lastUndo).toEqual({ label: 'Edited CFR 1.1', method: 'PATCH', path: `/api/requirements/${x.cfr.id}`, body: { title: 'Mission', officialText: 'The institution has a mission.' } });

    const created = await run('lead', (c) => createRequirement(c, { versionId: x.v.id, code: 'Standard 3', levelLabel: 'Standard', title: 'Third' }));
    expect(lastUndo).toEqual({ label: 'Added Standard 3', method: 'DELETE', path: `/api/requirements/${created.id}` });

    await run('lead', (c) => updateNote(c, x.note.id, { text: 'Changed text' }));
    expect(lastUndo).toEqual({ label: 'Edited a note on CFR 1.1', method: 'PATCH', path: `/api/notes/${x.note.id}`, body: { text: 'Show the mission statement.' } });
    const added = await run('lead', (c) => addNote(c, { requirementId: x.cfr.id, type: 'guidance', text: 'second', authority: 'example' }));
    expect(lastUndo).toMatchObject({ method: 'DELETE', path: `/api/notes/${added.id}` });
  });

  it('indent reports an undo that moves back to the earlier parent and position', async () => {
    await iqfItem('8', 'Eighth');
    const nine = await iqfItem('9', 'Ninth');
    await run('lead', (c) => indentRequirement(c, nine.id));
    expect(lastUndo).toEqual({ label: 'Indented 9', method: 'POST', path: `/api/requirements/${nine.id}/move`, body: { parentId: null, displayOrder: nine.displayOrder } });
    const moved = (await q(`select parent_id from requirement where id = $1`, [nine.id]))[0];
    expect(moved.parent_id).not.toBeNull();
  });

  it('undoes a merge: the merged-away requirement, its children and notes come back and the target gets its wording back', async () => {
    const x = await draft('merge');
    const target = await run('lead', (c) => createRequirement(c, { versionId: x.v.id, code: 'Standard 2', levelLabel: 'Standard', title: 'Resources', officialText: 'Resources text.', displayOrder: 1 }));
    const res = await run('lead', (c) => mergeRequirement(c, x.cfr.id, { intoId: target.id, useMergedWording: true }));
    expect(res).toMatchObject({ movedChildren: 1, movedNotes: 1 });
    expect(lastUndo).toMatchObject({ method: 'POST', body: { revertMerge: true }, label: 'Merged CFR 1.1 into Standard 2' });
    expect((await q(`select title from requirement where id = $1`, [target.id]))[0].title).toBe('Mission');
    const groupId = /groups\/([0-9a-f-]+)\/restore/.exec(lastUndo!.path)![1]!;
    const back = await run('lead', (c) => restoreTrash(c, { groupId }, { revertMerge: true }));
    expect(back.message).toContain('1 sub-item and 1 note moved back');
    const [t] = await q(`select title, official_text from requirement where id = $1`, [target.id]);
    expect(t).toEqual({ title: 'Resources', official_text: 'Resources text.' });
    expect((await q(`select parent_id from requirement where id = $1`, [x.sub.id]))[0].parent_id).toBe(x.cfr.id);
    expect((await q(`select requirement_id from requirement_note where id = $1`, [x.note.id]))[0].requirement_id).toBe(x.cfr.id);
  });

  it('undoes a split: the split-out requirement goes to the Trash and the original gets its text back', async () => {
    const x = await draft('split');
    const text = 'First part. Second part.';
    await run('lead', (c) => updateRequirement(c, x.cfr.id, { officialText: text }));
    const res = await run('lead', (c) => splitRequirement(c, x.cfr.id, { part: 'Second part.', code: 'CFR 1.2' }));
    expect(lastUndo).toEqual({ label: 'Split CFR 1.1', method: 'POST', path: `/api/requirements/${x.cfr.id}/unsplit`, body: { createdId: res.created.id, officialText: text } });
    const back = await run('lead', (c) => unsplitRequirement(c, x.cfr.id, { createdId: res.created.id, officialText: text }));
    expect(back.officialText).toBe(text);
    expect((await live(x.v.id)).map((r) => r.code)).not.toContain('CFR 1.2');
  });
});
