// Mappings from an external standard onto the quality framework: who may propose and approve, what they may link,
// and that they carry over to a new version of the standard.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, ValidationError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { setUpQualityFramework } from '../framework/internal.js';
import { listRequirements, createRequirement, reviewRequirement } from '../framework/requirements.js';
import { newVersionFrom, publishVersion, submitForReview } from '../framework/versions.js';
import { createMapping, deleteMapping, getMappings, reviewMapping, updateMapping } from './mapping.js';

let w: World;
const ids: Record<string, string> = {};
beforeAll(async () => {
  w = await buildWorld('mappingsvc');
  const q = await w.as('admin', (c) => setUpQualityFramework(c));
  ids.qv = q.versions[0]!.id;
  const std = await w.as('admin', (c) => createRequirement(c, { versionId: ids.qv!, code: 'Q1', levelLabel: 'Standard', title: 'Teaching quality' }));
  const sub = await w.as('admin', (c) => createRequirement(c, { versionId: ids.qv!, code: 'Q1.1', levelLabel: 'Sub-standard', title: 'Course review', parentId: std.id }));
  for (const r of [std, sub]) await w.as('admin', (c) => reviewRequirement(c, r.id, 'approved'));
  await w.as('admin', (c) => submitForReview(c, ids.qv!));
  await w.as('admin', (c) => publishVersion(c, ids.qv!));
  ids.q1 = std.id; ids.q11 = sub.id;
  ids.ext = (await w.as('admin', (c) => listRequirements(c, w.ids.abet!))).find((r) => r.isAssessable)!.id;
}, 120000);
afterAll(() => w.close());

describe('mappings', () => {
  it('offers the quality framework\'s items and starts with no mappings', async () => {
    const m = await w.as('contrib', (c) => getMappings(c, w.ids.abet!));
    expect(m.mappings).toEqual([]);
    expect(m.internalOptions.map((o) => o.code)).toEqual(['Q1', 'Q1.1']);
    expect(m.internalVersionId).toBe(ids.qv);
  });

  it('is proposed by an editor, pending, and approved only by someone who reviews', async () => {
    const input = { externalRequirementId: ids.ext!, internalRequirementId: ids.q11!, relation: 'partly_covers' as const, rationale: 'Annual course review covers the assessment cycle' };
    await expect(w.as('contrib', (c) => createMapping(c, w.ids.abet!, input))).rejects.toThrow(ForbiddenError);
    const m = await w.as('alo', (c) => createMapping(c, w.ids.abet!, input));
    expect(m).toMatchObject({ internalCode: 'Q1.1', internalTitle: 'Course review', relation: 'partly_covers', reviewStatus: 'pending', origin: 'manual', stale: false });
    ids.map = m.id;
    await expect(w.as('alo', (c) => createMapping(c, w.ids.abet!, input))).rejects.toThrow(ConflictError);
    await expect(w.as('contrib', (c) => reviewMapping(c, m.id, 'approved'))).rejects.toThrow(ForbiddenError);
    expect((await w.as('admin', (c) => reviewMapping(c, m.id, 'approved'))).reviewStatus).toBe('approved');
  });

  it('returns to review when edited, and can be deleted', async () => {
    const m = await w.as('alo', (c) => updateMapping(c, ids.map!, { relation: 'covers' }));
    expect(m).toMatchObject({ relation: 'covers', reviewStatus: 'pending' });
    expect(m.rationale).toBe('Annual course review covers the assessment cycle');
  });

  it('links only an external requirement of this version to an item of the quality framework', async () => {
    const other = (await w.as('admin', (c) => listRequirements(c, w.ids.wscuc!))).find((r) => r.isAssessable)!.id;
    await expect(w.as('alo', (c) => createMapping(c, w.ids.abet!, { externalRequirementId: other, internalRequirementId: ids.q1!, relation: 'related' }))).rejects.toThrow(ValidationError);
    await expect(w.as('alo', (c) => createMapping(c, w.ids.abet!, { externalRequirementId: ids.ext!, internalRequirementId: other, relation: 'related' }))).rejects.toThrow(ValidationError);
    await expect(w.as('alo', (c) => getMappings(c, ids.qv!))).rejects.toThrow(ValidationError); // from the quality framework itself
  });

  it('carries over to a new version of the standard', async () => {
    const draft = await w.as('admin', (c) => newVersionFrom(c, w.ids.abet!, { edition: 'next' }));
    const m = await w.as('contrib', (c) => getMappings(c, draft.version.id));
    expect(m.mappings).toHaveLength(1);
    expect(m.mappings[0]).toMatchObject({ internalCode: 'Q1.1', stale: false });
    expect(m.mappings[0]!.externalRequirementId).not.toBe(ids.ext); // resolved against the new version's own row
  });

  it('is deleted by an editor', async () => {
    await w.as('alo', (c) => deleteMapping(c, ids.map!));
    expect((await w.as('alo', (c) => getMappings(c, w.ids.abet!))).mappings).toEqual([]);
  });
});
