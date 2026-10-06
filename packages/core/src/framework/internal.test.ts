// The institution's own quality framework: set up once by someone who may edit, edited and published like any
// framework, kept out of the Standards list, and never the basis of an engagement (DEC-016).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, ValidationError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { createEngagement } from '../engagement/engagements.js';
import { listExternalTerms } from '../glossary/glossary.js';
import { getQualityFramework, setUpQualityFramework } from './internal.js';
import { createRequirement, reviewRequirement } from './requirements.js';
import { getVersionDetail, listFrameworks, newVersionFrom, publishVersion, returnToDraft, submitForReview, validateVersion } from './versions.js';

let w: World;
beforeAll(async () => { w = await buildWorld('internalfw'); }, 60000);
afterAll(() => w.close());

describe('quality framework', () => {
  it('starts unset, is set up once by an editor with a draft version and default level names', async () => {
    expect((await w.as('contrib', (c) => getQualityFramework(c))).framework).toBeNull();
    await expect(w.as('contrib', (c) => setUpQualityFramework(c))).rejects.toThrow(ForbiddenError);
    const set = await w.as('alo', (c) => setUpQualityFramework(c));
    expect(set.framework?.name).toBe('Quality framework');
    expect(set.versions).toHaveLength(1);
    expect(set.versions[0]).toMatchObject({ edition: '1', status: 'draft', levelLabels: ['Standard', 'Sub-standard'] });
    await expect(w.as('alo', (c) => setUpQualityFramework(c))).rejects.toThrow(ConflictError);
    expect((await w.as('contrib', (c) => getQualityFramework(c))).versions).toHaveLength(1);
  });

  it('is not an external standard: hidden from the Standards list and the glossary mapping', async () => {
    const list = await w.as('admin', (c) => listFrameworks(c));
    expect(list.map((f) => f.name)).not.toContain('Quality framework');
    expect((await w.as('admin', (c) => listExternalTerms(c))).map((s) => s.name)).not.toContain('Quality framework');
  });

  it('needs only level names and one approved requirement to be published, then is frozen', async () => {
    const { versions } = await w.as('admin', (c) => getQualityFramework(c));
    const id = versions[0]!.id;
    expect((await w.as('admin', (c) => getVersionDetail(c, id))).internal).toBe(true);
    expect(await w.as('admin', (c) => validateVersion(c, id))).toEqual({ ok: true });
    await expect(w.as('alo', (c) => submitForReview(c, id))).rejects.toThrow(ValidationError); // no requirement yet
    const std = await w.as('alo', (c) => createRequirement(c, { versionId: id, code: 'Q1', levelLabel: 'Standard', title: 'Teaching quality' }));
    const sub = await w.as('alo', (c) => createRequirement(c, { versionId: id, code: 'Q1.1', levelLabel: 'Sub-standard', title: 'Course review', parentId: std.id }));
    await w.as('alo', (c) => submitForReview(c, id));
    await expect(w.as('admin', (c) => publishVersion(c, id))).rejects.toThrow(ConflictError); // requirements not approved
    await w.as('admin', (c) => returnToDraft(c, id));
    for (const r of [std, sub]) await w.as('admin', (c) => reviewRequirement(c, r.id, 'approved'));
    await w.as('alo', (c) => submitForReview(c, id));
    expect((await w.as('admin', (c) => publishVersion(c, id))).status).toBe('published');
    await expect(w.as('alo', (c) => createRequirement(c, { versionId: id, code: 'Q2', levelLabel: 'Standard', title: 'More' }))).rejects.toThrow(ConflictError);
    const next = await w.as('alo', (c) => newVersionFrom(c, id, { edition: '2' }));
    expect(next.requirementsCopied).toBe(2);
  });

  it('cannot be the basis of an engagement', async () => {
    const { versions } = await w.as('admin', (c) => getQualityFramework(c));
    await expect(w.as('alo', (c) => createEngagement(c, {
      frameworkVersionId: versions[0]!.id, subjectType: 'institution', subjectId: w.ids.inst!, kind: 'initial', reviewYear: 2027, leadUserId: w.ids.alo!,
    }))).rejects.toThrow(/own quality framework/);
  });
});
