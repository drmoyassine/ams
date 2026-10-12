// moveMany (drag and drop): re-parent, reorder, several at once, the refusals, atomicity, and Undo restoring every position.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity } from '@ams/db';
import type { UndoDescriptor } from '@ams/shared';
import { ConflictError, ForbiddenError, ValidationError, type Ctx } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createAccreditor, createFramework, createRequirement, createVersion, listRequirements, setUpQualityFramework } from './index.js';
import { moveMany } from './move-many.js';
import { deleteMany } from '../trash/index.js';
import { publishQualityVersion } from './internal.js';
import { MAX_TREE_DEPTH } from '@ams/shared';

let w: World;
let lastUndo: UndoDescriptor | undefined;
let n = 0;

/** Like w.as, but remembers the undo descriptor the service reported. */
function as<T>(who: string, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const caller = { userId: w.ids[who]!, institutionId: w.ids.inst!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  return withIdentity(w.pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined, store: w.store, undo: (d) => { lastUndo = d; } }));
}

beforeAll(async () => { w = await buildWorld('movemany'); }, 60000);
afterAll(() => w.close());

/** A draft external version:  S1 (S1.1, S1.2 (S1.2.1), S1.3) · S2 (S2.1) · S3 */
async function tree() {
  n += 1;
  const acc = await as('alo', (c) => createAccreditor(c, { name: `Council ${n}`, shortName: `C${n}`, type: 'institutional' }));
  const fw = await as('alo', (c) => createFramework(c, { accreditorId: acc.id, name: `Handbook ${n}`, scope: 'institution' }));
  const v = await as('alo', (c) => createVersion(c, { frameworkId: fw.id, edition: `e${n}` }));
  const mk = (code: string, parentId: string | null, order: number) =>
    as('alo', (c) => createRequirement(c, { versionId: v.id, code, levelLabel: 'Standard', title: `T ${code}`, displayOrder: order, ...(parentId ? { parentId } : {}) }));
  const s1 = await mk('S1', null, 0);
  const s11 = await mk('S1.1', s1.id, 0);
  const s12 = await mk('S1.2', s1.id, 1);
  const s121 = await mk('S1.2.1', s12.id, 0);
  const s13 = await mk('S1.3', s1.id, 2);
  const s2 = await mk('S2', null, 1);
  const s21 = await mk('S2.1', s2.id, 0);
  const s3 = await mk('S3', null, 2);
  return { v: v.id, s1, s11, s12, s121, s13, s2, s21, s3 };
}

/** The tree as "S1(S1.1,S1.2(S1.2.1),S1.3) S2(S2.1) S3" with every list's display orders checked gap-free. */
async function shape(versionId: string): Promise<string> {
  const rows = await as('alo', (c) => listRequirements(c, versionId));
  const kids = (p: string | null) => rows.filter((r) => (r.parentId ?? null) === p);
  for (const p of [null, ...rows.map((r) => r.id)]) expect(kids(p).map((r) => r.displayOrder)).toEqual(kids(p).map((_, i) => i));
  const fmt = (p: string | null): string => kids(p).map((r) => (kids(r.id).length ? `${r.code}(${fmt(r.id)})` : r.code)).join(p === null ? ' ' : ',');
  return fmt(null);
}
const START = 'S1(S1.1,S1.2(S1.2.1),S1.3) S2(S2.1) S3';

describe('moveMany', () => {
  it('re-parents under another item at a position, renumbers gap-free, and leaves codes alone', async () => {
    const t = await tree();
    const res = await as('alo', (c) => moveMany(c, t.v, { moves: [{ id: t.s12.id, parentId: t.s2.id, index: 0 }] }));
    expect(res).toMatchObject({ moved: 1, unchanged: false });
    expect(await shape(t.v)).toBe('S1(S1.1,S1.3) S2(S1.2(S1.2.1),S2.1) S3');
    const rows = await as('alo', (c) => listRequirements(c, t.v));
    expect(rows.find((r) => r.id === t.s12.id)!.code).toBe('S1.2'); // the code did not change
    expect(lastUndo).toMatchObject({ label: 'Moved S1.2 under S2', method: 'POST', path: `/api/framework-versions/${t.v}/requirements/move-many` });
  });

  it('reorders inside one parent, and to the top level', async () => {
    const t = await tree();
    await as('alo', (c) => moveMany(c, t.v, { moves: [{ id: t.s13.id, parentId: t.s1.id, index: 0 }] }));
    expect(await shape(t.v)).toBe('S1(S1.3,S1.1,S1.2(S1.2.1)) S2(S2.1) S3');
    expect(lastUndo!.label).toBe('Reordered S1.3');
    await as('alo', (c) => moveMany(c, t.v, { moves: [{ id: t.s121.id, parentId: null, index: 1 }] }));
    expect(await shape(t.v)).toBe('S1(S1.3,S1.1,S1.2) S1.2.1 S2(S2.1) S3');
    expect(lastUndo!.label).toBe('Moved S1.2.1 to the top level');
  });

  it('moves several together keeping their relative order, a parent with its children', async () => {
    const t = await tree();
    await as('alo', (c) => moveMany(c, t.v, { moves: [{ id: t.s11.id, parentId: t.s3.id, index: 0 }, { id: t.s13.id, parentId: t.s3.id, index: 1 }] }));
    expect(await shape(t.v)).toBe('S1(S1.2(S1.2.1)) S2(S2.1) S3(S1.1,S1.3)');
    await as('alo', (c) => moveMany(c, t.v, { moves: [{ id: t.s1.id, parentId: t.s2.id, index: 1 }] }));
    expect(await shape(t.v)).toBe('S2(S2.1,S1(S1.2(S1.2.1))) S3(S1.1,S1.3)');
  });

  it('refuses a move under itself or its own sub-items, and applies nothing', async () => {
    const t = await tree();
    for (const [id, parentId] of [[t.s1.id, t.s1.id], [t.s1.id, t.s121.id], [t.s12.id, t.s121.id]] as [string, string][]) {
      await expect(as('alo', (c) => moveMany(c, t.v, { moves: [{ id, parentId, index: 0 }] }))).rejects.toThrow(ConflictError);
    }
    // a good move first in the same request, then a bad one: nothing at all is applied
    await expect(as('alo', (c) => moveMany(c, t.v, { moves: [{ id: t.s3.id, parentId: t.s2.id, index: 0 }, { id: t.s2.id, parentId: t.s3.id, index: 0 }] }))).rejects.toThrow(/itself or one of its own/);
    expect(await shape(t.v)).toBe(START);
  });

  it('refuses a result deeper than the most a standard can have, and names the item', async () => {
    const t = await tree();
    let parent = t.s3.id;
    for (let i = 1; i < MAX_TREE_DEPTH; i += 1) parent = (await as('alo', (c) => createRequirement(c, { versionId: t.v, code: `D${i}`, levelLabel: 'Standard', title: `D${i}`, parentId: parent }))).id; // S3 is depth 0; D7 is at depth 7
    await expect(as('alo', (c) => moveMany(c, t.v, { moves: [{ id: t.s2.id, parentId: parent, index: 0 }] }))).rejects.toThrow(/more than 8 levels/);
    expect(await shape(t.v)).toContain('S2(S2.1)');
  });

  it('refuses an unknown item, an item of another version, and bad input', async () => {
    const t = await tree();
    const other = await tree();
    await expect(as('alo', (c) => moveMany(c, t.v, { moves: [{ id: other.s1.id, parentId: null, index: 0 }] }))).rejects.toThrow(ValidationError);
    await expect(as('alo', (c) => moveMany(c, t.v, { moves: [{ id: t.s1.id, parentId: other.s2.id, index: 0 }] }))).rejects.toThrow(ValidationError);
    await expect(as('alo', (c) => moveMany(c, t.v, { moves: [{ id: crypto.randomUUID(), parentId: null, index: 0 }] }))).rejects.toThrow(ValidationError);
    await expect(as('alo', (c) => moveMany(c, t.v, {} as never))).rejects.toThrow(ValidationError);
    await expect(as('alo', (c) => moveMany(c, t.v, { moves: [{ id: t.s1.id, parentId: null, index: 0 }], placements: [{ parentId: null, afterId: null, ids: [t.s2.id] }] }))).rejects.toThrow(ValidationError);
    expect(await shape(t.v)).toBe(START);
    expect(await shape(other.v)).toBe(START);
  });

  it('needs framework:write and refuses a version that is not a draft', async () => {
    const t = await tree();
    await expect(as('contrib', (c) => moveMany(c, t.v, { moves: [{ id: t.s3.id, parentId: null, index: 0 }] }))).rejects.toThrow(ForbiddenError);
    const w2 = await buildWorld('movemanyfrozen');
    try {
      const set = await w2.as('alo', (c) => setUpQualityFramework(c));
      const v = set.versions[0]!.id;
      const a = await w2.as('alo', (c) => createRequirement(c, { versionId: v, code: '1', levelLabel: 'x', title: 'One' }));
      const b = await w2.as('alo', (c) => createRequirement(c, { versionId: v, code: '2', levelLabel: 'x', title: 'Two', displayOrder: 1 }));
      await w2.as('admin', (c) => publishQualityVersion(c, v));
      await expect(w2.as('alo', (c) => moveMany(c, v, { moves: [{ id: b.id, parentId: a.id, index: 0 }] }))).rejects.toThrow(/immutable/);
      expect((await w2.as('alo', (c) => listRequirements(c, v))).map((r) => r.parentId)).toEqual([null, null]);
    } finally { await w2.close(); }
  });

  it('says nothing changed, and offers no undo, when the drop is where things already are', async () => {
    const t = await tree();
    lastUndo = undefined;
    const res = await as('alo', (c) => moveMany(c, t.v, { moves: [{ id: t.s12.id, parentId: t.s1.id, index: 1 }] }));
    expect(res).toMatchObject({ unchanged: true, changed: 0 });
    expect(lastUndo).toBeUndefined();
  });

  it('marks the rows it moved as edited by a person', async () => {
    const t = await tree();
    await as('alo', (c) => moveMany(c, t.v, { moves: [{ id: t.s3.id, parentId: t.s1.id, index: 0 }] }));
    const r = await w.db.su.query(`select code, edited_by_person from requirement where framework_version_id = $1 order by code`, [t.v]);
    expect(r.rows.find((x) => x.code === 'S3').edited_by_person).toBe(true);
  });

  it('on the internal framework, a move changes the level label to the new depth and not the code', async () => {
    const w2 = await buildWorld('movemanyiqf');
    try {
      const run = (fn: (c: Ctx) => Promise<unknown>) => w2.as('alo', fn);
      const set = await w2.as('alo', (c) => setUpQualityFramework(c, { levelLabels: ['Standard', 'Sub-standard', 'Item'] }));
      const v = set.versions[0]!.id;
      const a = await w2.as('alo', (c) => createRequirement(c, { versionId: v, code: '1', levelLabel: 'x', title: 'One' }));
      const b = await w2.as('alo', (c) => createRequirement(c, { versionId: v, code: '2', levelLabel: 'x', title: 'Two', displayOrder: 1 }));
      await run((c) => moveMany(c, v, { moves: [{ id: b.id, parentId: a.id, index: 0 }] }));
      const rows = await w2.as('alo', (c) => listRequirements(c, v));
      expect(rows.map((r) => [r.code, r.levelLabel])).toEqual([['1', 'Standard'], ['2', 'Sub-standard']]);
    } finally { await w2.close(); }
  });
});

describe('the internal framework\'s level model', () => {
  it('refuses a move that would make a level it does not have, with its level names in the message', async () => {
    const w2 = await buildWorld('movemanylevels');
    try {
      const set = await w2.as('alo', (c) => setUpQualityFramework(c)); // Standard, Sub-standard
      const v = set.versions[0]!.id;
      const mk = (code: string, order: number, parentId?: string) => w2.as('alo', (c) => createRequirement(c, { versionId: v, code, levelLabel: 'x', title: code, displayOrder: order, ...(parentId ? { parentId } : {}) }));
      const a = await mk('1', 0);
      const a1 = await mk('1.1', 0, a.id);
      const b = await mk('2', 1);
      await expect(w2.as('alo', (c) => moveMany(c, v, { moves: [{ id: b.id, parentId: a1.id, index: 0 }] }))).rejects.toThrow(/more than 2 levels deep.*Standard, Sub-standard/);
      await w2.as('alo', (c) => moveMany(c, v, { moves: [{ id: b.id, parentId: a.id, index: 1 }] })); // a second sub-standard is fine
      expect((await w2.as('alo', (c) => listRequirements(c, v))).map((r) => [r.code, r.levelLabel])).toEqual([['1', 'Standard'], ['1.1', 'Sub-standard'], ['2', 'Sub-standard']]);
    } finally { await w2.close(); }
  });
});

describe('Undo of a move', () => {
  /** Applies the move, then sends the reported undo descriptor's body to the same service, and compares with the start. */
  async function roundTrip(moves: { id: string; parentId: string | null; index: number }[]) {
    const t = await tree();
    const resolved = moves.map((m) => ({ ...m, id: (t as never as Record<string, { id: string }>)[m.id]!.id, parentId: m.parentId === null ? null : (t as never as Record<string, { id: string }>)[m.parentId]!.id }));
    await as('alo', (c) => moveMany(c, t.v, { moves: resolved }));
    const undo = lastUndo!;
    const moved = await shape(t.v);
    expect(moved).not.toBe(START);
    expect(undo.path).toBe(`/api/framework-versions/${t.v}/requirements/move-many`);
    await as('alo', (c) => moveMany(c, t.v, undo.body as never));
    expect(await shape(t.v)).toBe(START);
    return { t, undo, moved };
  }

  it('restores a re-parent', async () => { await roundTrip([{ id: 's12', parentId: 's2', index: 0 }]); });
  it('restores a reorder', async () => { await roundTrip([{ id: 's13', parentId: 's1', index: 0 }]); });
  it('restores a multi-move to another parent', async () => { await roundTrip([{ id: 's11', parentId: 's3', index: 0 }, { id: 's13', parentId: 's3', index: 1 }]); });
  it('restores a multi-move that mixes parents and positions', async () => {
    await roundTrip([{ id: 's11', parentId: 's2', index: 1 }, { id: 's3', parentId: 's1', index: 0 }, { id: 's21', parentId: null, index: 0 }, { id: 's121', parentId: 's3', index: 0 }]);
  });
  it('restores a move of a parent with its children', async () => { await roundTrip([{ id: 's1', parentId: 's2', index: 0 }]); });
  it('restores moves that cross (each takes the other\'s place)', async () => { await roundTrip([{ id: 's11', parentId: 's2', index: 0 }, { id: 's21', parentId: 's1', index: 0 }]); });

  it('is refused with a reason, not guessed, when what it sat after has been deleted meanwhile', async () => {
    const t = await tree();
    await as('alo', (c) => moveMany(c, t.v, { moves: [{ id: t.s13.id, parentId: t.s3.id, index: 0 }] }));
    const undo = lastUndo!;
    await as('alo', (c) => deleteMany(c, { ids: [t.s12.id] })); // S1.3 sat after S1.2
    await expect(as('alo', (c) => moveMany(c, t.v, undo.body as never))).rejects.toThrow(/cannot be put back exactly|not in this version/);
  });

  it('stays small enough for the header when a handful of items move, and carries one descriptor per request', async () => {
    const t = await tree();
    await as('alo', (c) => moveMany(c, t.v, { moves: [{ id: t.s11.id, parentId: t.s3.id, index: 0 }, { id: t.s12.id, parentId: t.s3.id, index: 1 }, { id: t.s13.id, parentId: t.s3.id, index: 2 }] }));
    expect(encodeURIComponent(JSON.stringify(lastUndo)).length).toBeLessThan(1500);
    expect((lastUndo!.body as { placements: unknown[] }).placements).toHaveLength(1); // one run: S1.1, S1.2, S1.3 sat together at the start of S1
  });
});
