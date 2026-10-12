// M3 evidence (PRD 9, DEC-016): stored once, attached to the internal framework, offered to every accreditor
// requirement mapped there, linked to each with its own reason, versions kept, newer versions and staleness shown.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, ValidationError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { listEngagementRequirements } from '../engagement/workspace.js';
import { setUpQualityFramework } from '../framework/internal.js';
import { listRequirements, reviewRequirement } from '../framework/requirements.js';
import { publishVersion, submitForReview } from '../framework/versions.js';
import { createMapping, reviewMapping } from '../mapping/mapping.js';
import { saveDatasetRows, saveDatasetSpec } from './dataset.js';
import {
  addFileVersion, addUrlVersion, createEvidence, getEvidence, linksForEngagementRequirement, linksForInternal, linkToEngagementRequirement, linkToInternal,
  listEvidence, readVersionFile, removeLink, reviewLink, suggestionsFor, updateEvidence,
} from './evidence.js';
import { setDataFormOpen, submitDataResponse } from './forms.js';
import { cancelEvidenceRequest, createFormRequests } from './requests.js';
import { listTrash, restoreTrash } from '../trash/index.js';

let w: World;
const ids: Record<string, string> = {};
const bytes = (s: string) => new TextEncoder().encode(s);

beforeAll(async () => {
  w = await buildWorld('evidencesvc');
  // The internal framework from the template, published.
  const qf = await w.as('admin', (c) => setUpQualityFramework(c, { template: true }));
  const qv = qf.versions[0]!.id;
  const items = await w.as('admin', (c) => listRequirements(c, qv));
  for (const r of items) await w.as('admin', (c) => reviewRequirement(c, r.id, 'approved'));
  await w.as('admin', (c) => submitForReview(c, qv));
  await w.as('admin', (c) => publishVersion(c, qv));
  ids.assessment = items.find((r) => r.title === 'Assessment of learning')!.id;

  // An ABET program engagement (led by coord) and a WSCUC institutional one (led by alo).
  ids.abetEng = (await w.create('alo', { subjectType: 'program', subjectId: w.ids.mech!, kind: 'initial' })).engagement.id;
  ids.wscucEng = (await w.create('alo', { frameworkVersionId: w.ids.wscuc!, subjectType: 'institution', subjectId: w.ids.inst!, kind: 'reaffirmation', reviewYear: 2028, leadUserId: w.ids.alo!, keyDates: { submission_date: '2028-03-01' } })).engagement.id;
  const pick = async (who: string, eng: string) => (await w.as(who, (c) => listEngagementRequirements(c, eng))).items.find((i) => i.applicable)!;
  const abetItem = await pick('coord', ids.abetEng);
  const wscucItem = await pick('alo', ids.wscucEng);
  ids.abetER = abetItem.id; ids.wscucER = wscucItem.id;

  // Both requirements are mapped (and the mappings approved) onto "Assessment of learning".
  for (const [version, item] of [[w.ids.abet!, abetItem], [w.ids.wscuc!, wscucItem]] as const) {
    const m = await w.as('alo', (c) => createMapping(c, version, { externalRequirementId: item.requirementId, internalRequirementId: ids.assessment!, relation: 'covers' }));
    await w.as('admin', (c) => reviewMapping(c, m.id, 'approved'));
  }
}, 120000);
afterAll(() => w.close());

describe('the repository', () => {
  it('stores a file once as version 1, with its size and hash, and serves it back', async () => {
    await expect(w.as('outsider', (c) => listEvidence(c))).rejects.toThrow(ForbiddenError);
    const item = await w.as('contrib', (c) => createEvidence(c, { title: 'Course review minutes', type: 'document', periodLabel: 'AY2025-26', tags: ['assessment'] }));
    ids.minutes = item.id;
    const v1 = await w.as('contrib', (c) => addFileVersion(c, item.id, { fileName: 'minutes.pdf', mime: 'application/pdf', bytes: bytes('first') }));
    expect(v1).toMatchObject({ versionNo: 1, fileName: 'minutes.pdf', size: 5 });
    expect(v1.sha256).toMatch(/^[0-9a-f]{64}$/);
    ids.v1 = v1.id;
    const file = await w.as('alo', (c) => readVersionFile(c, v1.id));
    expect(new TextDecoder().decode(file.bytes)).toBe('first');
    await expect(w.as('contrib', (c) => addFileVersion(c, item.id, { fileName: 'x', mime: 'text/plain', bytes: new Uint8Array() }))).rejects.toThrow(ValidationError);
    expect((await w.as('alo', (c) => listEvidence(c, { q: 'assessment' }))).map((e) => e.title)).toEqual(['Course review minutes']);
  });

  it('says what the storage service answered when it refuses a file', async () => {
    const put = w.store.put.bind(w.store);
    w.store.put = async () => { throw Object.assign(new Error('Bad request'), { name: 'InvalidRequest', $metadata: { httpStatusCode: 400 } }); };
    try {
      await expect(w.as('contrib', (c) => addFileVersion(c, ids.minutes!, { fileName: 'x.pdf', mime: 'application/pdf', bytes: bytes('x') })))
        .rejects.toThrow('the file could not be stored (InvalidRequest 400 Bad request)');
    } finally { w.store.put = put; }
  });

  it('keeps versions as they were uploaded', async () => {
    await expect(w.db.su.query(`update evidence_version set file_name = 'changed.pdf' where id = $1`, [ids.v1])).rejects.toThrow(/kept as they were uploaded/);
    await expect(w.db.su.query(`delete from evidence_version where id = $1`, [ids.v1])).rejects.toThrow(/kept as they were uploaded/);
  });

  it('shows a restricted item only to institution-wide roles and its owner', async () => {
    const secret = await w.as('alo', (c) => createEvidence(c, { title: 'Salary survey', type: 'data', confidentiality: 'restricted' }));
    expect((await w.as('alo', (c) => listEvidence(c))).map((e) => e.id)).toContain(secret.id);
    expect((await w.as('contrib', (c) => listEvidence(c))).map((e) => e.id)).not.toContain(secret.id);
  });
});

describe('attached once to the internal framework, offered to every mapped requirement', () => {
  it('attaches evidence to an internal item with a reason, for review', async () => {
    await expect(w.as('contrib', (c) => linkToInternal(c, ids.assessment!, { evidenceVersionId: ids.v1!, rationale: '  ' }))).rejects.toThrow();
    const link = await w.as('contrib', (c) => linkToInternal(c, ids.assessment!, { evidenceVersionId: ids.v1!, rationale: 'Minutes of the annual course review' }));
    expect(link).toMatchObject({ reviewStatus: 'proposed', target: { kind: 'internal', title: 'Assessment of learning' } });
    await expect(w.as('contrib', (c) => linkToInternal(c, ids.assessment!, { evidenceVersionId: ids.v1!, rationale: 'again' }))).rejects.toThrow(ConflictError);
    await expect(w.as('contrib', (c) => reviewLink(c, link.id, { decision: 'approved' }))).rejects.toThrow(ForbiddenError);
    // proposed links are not offered yet
    expect(await w.as('coord', (c) => suggestionsFor(c, ids.abetER!))).toEqual([]);
    await w.as('admin', (c) => reviewLink(c, link.id, { decision: 'approved' }));
    expect((await w.as('contrib', (c) => linksForInternal(c, ids.assessment!))).map((l) => l.reviewStatus)).toEqual(['approved']);
  });

  it('offers it to the ABET and the WSCUC requirement, each linked with its own reason', async () => {
    const abet = await w.as('coord', (c) => suggestionsFor(c, ids.abetER!));
    expect(abet).toEqual([expect.objectContaining({ title: 'Course review minutes', internalTitle: 'Assessment of learning', relation: 'covers', versionNo: 1 })]);
    expect(await w.as('alo', (c) => suggestionsFor(c, ids.wscucER!))).toHaveLength(1);

    await expect(w.as('contrib', (c) => linkToEngagementRequirement(c, ids.wscucER!, { evidenceVersionId: ids.v1!, rationale: 'x' }))).rejects.toThrow(); // not their engagement: they cannot even see it
    const a = await w.as('coord', (c) => linkToEngagementRequirement(c, ids.abetER!, { evidenceVersionId: ids.v1!, rationale: 'Shows the program reviews assessment results every year' }));
    const b = await w.as('alo', (c) => linkToEngagementRequirement(c, ids.wscucER!, { evidenceVersionId: ids.v1!, rationale: 'Evidence of institution-wide assessment of learning' }));
    expect(a.rationale).not.toBe(b.rationale);
    expect(a).toMatchObject({ reviewStatus: 'proposed', target: { kind: 'engagement', engagementId: ids.abetEng } });
    expect(await w.as('coord', (c) => suggestionsFor(c, ids.abetER!))).toEqual([]); // linked now, so no longer offered
    await w.as('coord', (c) => reviewLink(c, a.id, { decision: 'approved', comment: 'Good' }));
    ids.abetLink = a.id;
  });

  it('shows "newer version available" on every link once the file is uploaded again', async () => {
    await w.as('contrib', (c) => addFileVersion(c, ids.minutes!, { fileName: 'minutes-v2.pdf', mime: 'application/pdf', bytes: bytes('second') }));
    for (const [who, er] of [['coord', ids.abetER!], ['alo', ids.wscucER!]] as const) {
      const [link] = await w.as(who, (c) => linksForEngagementRequirement(c, er));
      expect(link).toMatchObject({ versionNo: 1, latestVersionNo: 2, newerVersionAvailable: true, stale: false });
    }
    const detail = await w.as('alo', (c) => getEvidence(c, ids.minutes!));
    expect(detail.versions.map((v) => v.versionNo)).toEqual([2, 1]);
    expect(detail.links.map((l) => l.target.kind).sort()).toEqual(['engagement', 'engagement', 'internal']);
  });

  it('flags evidence older than the review year allows as stale', async () => {
    const old = await w.as('contrib', (c) => createEvidence(c, { title: 'Old policy', type: 'document', periodLabel: 'AY2019-20' }));
    const v = await w.as('contrib', (c) => addFileVersion(c, old.id, { fileName: 'p.pdf', mime: 'application/pdf', bytes: bytes('old') }));
    await w.as('coord', (c) => linkToEngagementRequirement(c, ids.abetER!, { evidenceVersionId: v.id, rationale: 'Policy in force at the time' }));
    const links = await w.as('coord', (c) => linksForEngagementRequirement(c, ids.abetER!));
    expect(links.find((l) => l.evidenceTitle === 'Old policy')!.stale).toBe(true); // 2019 < 2027 - 3
  });

  it('removes a proposed link, but an approved one only by someone who reviews', async () => {
    await expect(w.as('contrib', (c) => removeLink(c, ids.abetLink!))).rejects.toThrow(ForbiddenError);
    await w.as('coord', (c) => removeLink(c, ids.abetLink!));
    expect((await w.as('coord', (c) => linksForEngagementRequirement(c, ids.abetER!))).map((l) => l.evidenceTitle)).toEqual(['Old policy']);

    // The removed link is in the Trash (the evidence itself was never deleted) and comes back with its reason and review state.
    const bin = (await w.as('coord', (c) => listTrash(c, { kind: 'evidence_link' }))).groups[0]!;
    expect(bin.kinds).toEqual(['evidence_link']);
    await w.as('coord', (c) => restoreTrash(c, { groupId: bin.groupId }));
    const back = await w.as('coord', (c) => linksForEngagementRequirement(c, ids.abetER!));
    expect(back.map((l) => l.id)).toContain(ids.abetLink);
    expect(back.find((l) => l.id === ids.abetLink)!.rationale.length).toBeGreaterThan(0);
    // Leave things as the next tests expect them: the link removed again.
    await w.as('coord', (c) => removeLink(c, ids.abetLink!));
  });
});

describe('what the repository list shows', () => {
  it('counts links to review, open form requests and new responses, without one query per item', async () => {
    const doc = (await w.as('alo', (c) => listEvidence(c))).find((e) => e.id === ids.minutes)!;
    // Two links on v1: the internal one (approved) and the WSCUC one (proposed); the ABET one was removed above.
    expect(doc).toMatchObject({ linkCount: 2, proposedLinkCount: 1, openRequestCount: 0, formOpen: false, pendingResponses: 0 });

    const data = await w.as('contrib', (c) => createEvidence(c, { title: 'Employer survey', type: 'data' }));
    await w.as('contrib', (c) => saveDatasetSpec(c, data.id, { columns: [{ key: 'employer', label: 'Employer', type: 'text', required: true }] }));
    await w.as('contrib', (c) => setDataFormOpen(c, data.id, true));
    await w.as('alo', (c) => submitDataResponse(c, data.id, { answers: { employer: 'Aramco' } }));
    const [asked] = await w.as('contrib', (c) => createFormRequests(c, data.id, { assigneeEmails: ['hr@partner.com', 'ops@partner.com'] }));
    await w.as('contrib', (c) => cancelEvidenceRequest(c, asked!.request.id));
    const listed = (await w.as('alo', (c) => listEvidence(c))).find((e) => e.id === data.id)!;
    expect(listed).toMatchObject({ linkCount: 0, proposedLinkCount: 0, openRequestCount: 1, formOpen: true, pendingResponses: 1 });
    expect((await w.as('alo', (c) => getEvidence(c, data.id))).item).toMatchObject({ openRequestCount: 1, formOpen: true, pendingResponses: 1 });
    ids.data = data.id;
  });

  it('archives and restores an item; archived items are listed only when asked for', async () => {
    const archived = await w.as('contrib', (c) => updateEvidence(c, ids.minutes!, { status: 'archived' }));
    expect(archived).toMatchObject({ status: 'archived', linkCount: 1 }); // contrib cannot see the WSCUC engagement's link
    expect((await w.as('alo', (c) => listEvidence(c))).map((e) => e.id)).not.toContain(ids.minutes);
    expect((await w.as('alo', (c) => listEvidence(c, { includeArchived: true }))).find((e) => e.id === ids.minutes)?.status).toBe('archived');
    await expect(w.as('contrib', (c) => addFileVersion(c, ids.minutes!, { fileName: 'x.pdf', mime: 'application/pdf', bytes: bytes('x') }))).rejects.toThrow(/archived/);
    await w.as('contrib', (c) => updateEvidence(c, ids.minutes!, { status: 'active' }));
    expect((await w.as('alo', (c) => listEvidence(c))).map((e) => e.id)).toContain(ids.minutes);
    await expect(w.as('outsider', (c) => updateEvidence(c, ids.minutes!, { status: 'archived' }))).rejects.toThrow(ForbiddenError);
  });

  it('changes a document to data only while it holds no file, and data to a document only while it holds no data', async () => {
    await expect(w.as('contrib', (c) => updateEvidence(c, ids.minutes!, { type: 'data' }))).rejects.toThrow('this document has file versions; it cannot become data');
    const linked = await w.as('contrib', (c) => createEvidence(c, { title: 'Policy on SharePoint', type: 'document' }));
    await w.as('contrib', (c) => addUrlVersion(c, linked.id, { url: 'https://example.org/policy' }));
    await expect(w.as('contrib', (c) => updateEvidence(c, linked.id, { type: 'data' }))).rejects.toThrow(ConflictError);

    const empty = await w.as('contrib', (c) => createEvidence(c, { title: 'Headcount', type: 'document' }));
    expect(await w.as('contrib', (c) => updateEvidence(c, empty.id, { type: 'data', title: 'Fall headcount', description: 'By program' })))
      .toMatchObject({ type: 'data', title: 'Fall headcount', description: 'By program' });
    await w.as('contrib', (c) => saveDatasetSpec(c, empty.id, { columns: [{ key: 'program', label: 'Program', type: 'text', required: true }] }));
    await w.as('contrib', (c) => saveDatasetRows(c, empty.id, { rows: [{ program: 'BS Mechanical' }] }));
    await expect(w.as('contrib', (c) => updateEvidence(c, empty.id, { type: 'document' }))).rejects.toThrow('this data has saved data or form responses; it cannot become a document');
    await expect(w.as('contrib', (c) => updateEvidence(c, ids.data!, { type: 'document' }))).rejects.toThrow(ConflictError); // a response, no data yet
  });
});
