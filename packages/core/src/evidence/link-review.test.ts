// TASK-088: a reviewer's own links are approved at once, a rejection needs a reason, the proposer is told in the app and can resubmit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { listEngagementRequirements } from '../engagement/workspace.js';
import { listRequirements } from '../framework/requirements.js';
import { dismissNotification, listMyNotifications, markNotificationRead } from '../notifications/notifications.js';
import { addFileVersion, createEvidence, linksForEngagementRequirement, linksForInternal, linkToEngagementRequirement, linkToRequirement, resubmitLink, reviewLink } from './evidence.js';

let w: World;
const ids: Record<string, string> = {};
const bytes = (s: string) => new TextEncoder().encode(s);
const evidenceVersion = async (title: string) => {
  const item = await w.as('contrib', (c) => createEvidence(c, { title, type: 'document' }));
  return (await w.as('contrib', (c) => addFileVersion(c, item.id, { fileName: `${title}.pdf`, mime: 'application/pdf', bytes: bytes(title) }))).id;
};

beforeAll(async () => {
  w = await buildWorld('linkreview');
  const reqs = (await w.as('alo', (c) => listRequirements(c, w.ids.abet!))).filter((r) => r.isAssessable);
  ids.req1 = reqs[0]!.id; ids.req2 = reqs[1]!.id; ids.req3 = reqs[2]!.id;
  ids.eng = (await w.create('alo', { subjectType: 'program', subjectId: w.ids.mech!, kind: 'initial' })).engagement.id;
  ids.er = (await w.as('coord', (c) => listEngagementRequirements(c, ids.eng!))).items.find((i) => i.applicable)!.id;
  ids.er2 = (await w.as('coord', (c) => listEngagementRequirements(c, ids.eng!))).items.filter((i) => i.applicable)[1]!.id;
}, 120000);
afterAll(() => w.close());

describe('a link made by someone who may review it is approved at once', () => {
  it('library links: a reviewer approves their own, a contributor proposes', async () => {
    const v = await evidenceVersion('Audit report');
    const mine = await w.as('alo', (c) => linkToRequirement(c, ids.req1!, { evidenceVersionId: v, rationale: 'Covers it' }));
    expect(mine).toMatchObject({ reviewStatus: 'approved', reviewedByName: 'alo', reviewComment: null });
    expect(mine.reviewedAt).toEqual(expect.any(String));
    const theirs = await w.as('contrib', (c) => linkToRequirement(c, ids.req2!, { evidenceVersionId: v, rationale: 'Covers this too' }));
    expect(theirs).toMatchObject({ reviewStatus: 'proposed', reviewedByName: null, reviewedAt: null });
    // The creation is audited with the approved state and who approved it.
    const audit = (await w.db.su.query(`select after from audit_event where target_type = 'evidence_link' and target_id = $1 and action = 'insert'`, [mine.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].after).toMatchObject({ review_status: 'approved', reviewed_by: w.ids.alo, review_comment: null });
    // Nobody is notified of their own approval.
    expect(await w.as('alo', (c) => listMyNotifications(c))).toEqual([]);
  });

  it('engagement links: the same, by the right to review that engagement', async () => {
    const v = await evidenceVersion('Course files');
    const proposed = await w.as('contrib', (c) => linkToEngagementRequirement(c, ids.er!, { evidenceVersionId: v, rationale: 'Shows the courses' }));
    expect(proposed.reviewStatus).toBe('proposed');
    const approved = await w.as('coord', (c) => linkToEngagementRequirement(c, ids.er2!, { evidenceVersionId: v, rationale: 'Shows the courses, too' }));
    expect(approved).toMatchObject({ reviewStatus: 'approved', reviewedByName: 'coord' });
    expect((await w.as('coord', (c) => linksForEngagementRequirement(c, ids.er2!))).map((l) => l.reviewStatus)).toEqual(['approved']);
  });

  it('the AI never approves, whoever it runs as', async () => {
    const v = await evidenceVersion('AI attempt');
    await expect(w.as('alo', (c) => linkToRequirement({ ...c, caller: { ...c.caller, actorType: 'ai' } }, ids.req3!, { evidenceVersionId: v, rationale: 'x' }))).rejects.toThrow(ConflictError);
  });
});

describe('rejecting', () => {
  it('needs a reason; approving does not', async () => {
    const v = await evidenceVersion('Policy');
    const link = await w.as('contrib', (c) => linkToRequirement(c, ids.req3!, { evidenceVersionId: v, rationale: 'It is the policy' }));
    ids.link = link.id;
    await expect(w.as('alo', (c) => reviewLink(c, link.id, { decision: 'rejected' }))).rejects.toThrow(/say why it is rejected/);
    await expect(w.as('alo', (c) => reviewLink(c, link.id, { decision: 'rejected', comment: '   ' }))).rejects.toThrow();
    const rejected = await w.as('alo', (c) => reviewLink(c, link.id, { decision: 'rejected', comment: 'هذه السياسة قديمة' }));
    expect(rejected).toMatchObject({ reviewStatus: 'rejected', reviewComment: 'هذه السياسة قديمة', reviewedByName: 'alo', linkedBy: w.ids.contrib });
    expect(rejected.reviewedAt).toEqual(expect.any(String));
    const again = await w.as('alo', (c) => reviewLink(c, link.id, { decision: 'approved' }));
    expect(again).toMatchObject({ reviewStatus: 'approved', reviewComment: null });
    await w.as('alo', (c) => reviewLink(c, link.id, { decision: 'rejected', comment: 'Outdated after all' }));
  });

  it('tells the proposer, with the reason, and never the person who rejected', async () => {
    const [note, ...rest] = await w.as('contrib', (c) => listMyNotifications(c));
    expect(rest.length).toBe(2);
    expect(rest.map((n) => n.kind).sort()).toEqual(['link_approved', 'link_rejected']);
    expect(note).toMatchObject({ kind: expect.stringMatching(/link_/), refKind: 'evidence_link', refId: ids.link, readAt: null });
    const latest = (await w.as('contrib', (c) => listMyNotifications(c))).filter((n) => n.kind === 'link_rejected');
    expect(latest.map((n) => n.body)).toContain('Your link of Policy to ' + latest[0]!.link!.target.code + (latest[0]!.link!.target.title ? ` · ${latest[0]!.link!.target.title}` : '') + ' was rejected: Outdated after all');
    expect(latest[0]!.link).toMatchObject({ id: ids.link, reviewStatus: 'rejected', reviewComment: 'Outdated after all' });
    expect(await w.as('alo', (c) => listMyNotifications(c))).toEqual([]);
    // A reviewer who rejects a link they made themselves is not told either.
    const v = await evidenceVersion('Own');
    const own = await w.as('coord', (c) => linkToRequirement(c, ids.req2!, { evidenceVersionId: v, rationale: 'Mine' }));
    await w.as('coord', (c) => reviewLink(c, own.id, { decision: 'rejected', comment: 'Changed my mind' }));
    expect(await w.as('coord', (c) => listMyNotifications(c))).toEqual([]);
  });
});

describe('notifications are private to their person', () => {
  it('nobody reads, marks or dismisses another person\'s', async () => {
    const [mine] = await w.as('contrib', (c) => listMyNotifications(c));
    expect(await w.as('admin', (c) => listMyNotifications(c))).toEqual([]);
    await expect(w.as('admin', (c) => markNotificationRead(c, mine!.id))).rejects.toThrow(NotFoundError);
    await expect(w.as('admin', (c) => dismissNotification(c, mine!.id))).rejects.toThrow(NotFoundError);
    await expect(w.as('outsider', (c) => listMyNotifications(c))).rejects.toThrow(ForbiddenError);
    // Even with superuser-free access through the app role, the rows are filtered by user.
    const seen = await w.db.as({ userId: w.ids.admin!, institutionId: w.ids.inst! }, (c) => c.query('select id from notification'));
    expect(seen.rows).toEqual([]);
  });

  it('marks read (unread listed first) and dismisses', async () => {
    const all = await w.as('contrib', (c) => listMyNotifications(c));
    const first = all[0]!;
    await w.as('contrib', (c) => markNotificationRead(c, first.id));
    const after = await w.as('contrib', (c) => listMyNotifications(c));
    expect(after.find((n) => n.id === first.id)!.readAt).toEqual(expect.any(String));
    expect(after[after.length - 1]!.id).toBe(first.id); // read ones sort after unread ones
    await w.as('contrib', (c) => dismissNotification(c, first.id));
    expect((await w.as('contrib', (c) => listMyNotifications(c))).map((n) => n.id)).not.toContain(first.id);
  });
});

describe('resubmitting a rejected link', () => {
  it('only its proposer, only while rejected; it goes back to review with the new reason and keeps its history', async () => {
    await expect(w.as('alo', (c) => resubmitLink(c, ids.link!, { rationale: 'x' }))).rejects.toThrow(ForbiddenError);
    await expect(w.as('contrib', (c) => resubmitLink(c, ids.link!, { rationale: '  ' }))).rejects.toThrow();
    const back = await w.as('contrib', (c) => resubmitLink(c, ids.link!, { rationale: 'The 2026 revision of the policy' }));
    expect(back).toMatchObject({ reviewStatus: 'proposed', rationale: 'The 2026 revision of the policy', reviewComment: null, reviewedByName: null, reviewedAt: null });
    expect((await w.as('contrib', (c) => linksForInternal(c, ids.req3!)))[0]).toMatchObject({ id: ids.link, reviewStatus: 'proposed' });
    // Its "rejected" notices are gone; the audit trail keeps the rejection and its reason.
    expect((await w.as('contrib', (c) => listMyNotifications(c))).filter((n) => n.refId === ids.link)).toEqual([]);
    const rejectedBefore = (await w.db.su.query(`select before from audit_event where target_type = 'evidence_link' and target_id = $1 and action = 'update' and after ->> 'review_status' = 'proposed'`, [ids.link])).rows;
    expect(rejectedBefore[0].before).toMatchObject({ review_status: 'rejected', review_comment: 'Outdated after all' });
    await expect(w.as('contrib', (c) => resubmitLink(c, ids.link!, { rationale: 'again' }))).rejects.toThrow(ConflictError);
  });
});
