// Evidence requests (DEC-018): asked of a person by email; an AMS user answers in the AMS, anyone else through a
// one-time link; the answer becomes evidence proposed on the item, for review.
import { resolveRequestLink, withIdentity } from '@ams/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../ctx.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { setUpQualityFramework } from '../framework/internal.js';
import { listRequirements } from '../framework/requirements.js';
import { getEvidence, linksForInternal, readVersionFile } from './evidence.js';
import { saveDatasetSpec } from './dataset.js';
import { createEvidence } from './evidence.js';
import { listDataResponses } from './forms.js';
import {
  answerFormByLink, answerRequestWithForm, createFormRequests, formForRequest, requestsForDataItem,
  answerByLink, answerEvidenceRequest, cancelEvidenceRequest, createEvidenceRequest, hashLinkToken, listEvidenceRequests, renewRequestLink,
  requestByLink, requestsForInternal,
} from './requests.js';

let w: World;
const ids: Record<string, string> = {};
const bytes = (s: string) => new TextEncoder().encode(s);
const file = (s: string) => ({ fileName: 'survey.pdf', mime: 'application/pdf', bytes: bytes(s) });

/** What the API does for a one-time link: resolve it, then act with no user in that institution. */
async function viaLink<T>(token: string, fn: (ctx: Ctx, requestId: string) => Promise<T>): Promise<T> {
  const found = await resolveRequestLink(w.pool, hashLinkToken(token));
  if (!found) throw new NotFoundError('link');
  const caller = { userId: null, institutionId: found.institutionId, requestId: crypto.randomUUID(), actorType: 'system' as const };
  return withIdentity(w.pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined, store: w.store }, found.requestId));
}

beforeAll(async () => {
  w = await buildWorld('requestsvc');
  const qf = await w.as('admin', (c) => setUpQualityFramework(c, { template: true }));
  const items = await w.as('admin', (c) => listRequirements(c, qf.versions[0]!.id));
  ids.assessment = items.find((r) => r.title === 'Assessment of learning')!.id;
}, 120000);
afterAll(() => w.close());

describe('asking an AMS user', () => {
  it('finds the user by email; no link is issued; it shows in their requests', async () => {
    await expect(w.as('outsider', (c) => createEvidenceRequest(c, ids.assessment!, { title: 'x', assigneeEmail: 'second@x.org' }))).rejects.toThrow(ForbiddenError);
    const { request, linkToken } = await w.as('alo', (c) => createEvidenceRequest(c, ids.assessment!, {
      title: 'Graduate survey 2025', assigneeEmail: 'Contrib@X.org', message: 'The summary report, please', dueDate: '2020-01-01',
    }));
    expect(linkToken).toBeNull();
    expect(request).toMatchObject({ status: 'open', overdue: true, assigneeHasAccount: true, assigneeName: 'contrib', requestedByName: 'alo', internalTitle: 'Assessment of learning' });
    ids.r1 = request.id;
    expect((await w.as('contrib', (c) => listEvidenceRequests(c, { mine: true }))).map((r) => r.id)).toEqual([request.id]);
    expect(await w.as('coord', (c) => listEvidenceRequests(c, { mine: true }))).toEqual([]);
    expect((await w.as('alo', (c) => requestsForInternal(c, ids.assessment!))).map((r) => r.id)).toEqual([request.id]);
  });

  it('the person asked answers; the file becomes evidence proposed on the item, and the request closes', async () => {
    await expect(w.as('second', (c) => answerEvidenceRequest(c, ids.r1!, file('x')))).rejects.toThrow(ForbiddenError);
    const done = await w.as('contrib', (c) => answerEvidenceRequest(c, ids.r1!, file('survey'), 'Final report as approved by council'));
    expect(done).toMatchObject({ status: 'supplied', overdue: false, suppliedNote: 'Final report as approved by council' });
    const ev = await w.as('alo', (c) => getEvidence(c, done.evidenceItemId!));
    expect(ev.item).toMatchObject({ title: 'Graduate survey 2025', type: 'document' });
    expect(ev.links[0]).toMatchObject({ reviewStatus: 'proposed', rationale: 'Final report as approved by council', target: { kind: 'internal', code: expect.any(String) } });
    await expect(w.as('contrib', (c) => answerEvidenceRequest(c, ids.r1!, file('again')))).rejects.toThrow(ConflictError);
    await expect(w.as('alo', (c) => cancelEvidenceRequest(c, ids.r1!))).rejects.toThrow(ConflictError);
  });
});

describe('asking someone without an account', () => {
  it('issues a one-time link that opens only that request', async () => {
    const { request, linkToken } = await w.as('alo', (c) => createEvidenceRequest(c, ids.assessment!, { title: 'Employer survey', assigneeEmail: 'partner@example.com' }));
    expect(linkToken).toMatch(/^[\w-]{40,}$/);
    expect(request).toMatchObject({ assigneeHasAccount: false, linkExpiresAt: expect.any(String) });
    ids.r2 = request.id; ids.token = linkToken!;
    // Only the hash is kept.
    const { rows } = await w.db.su.query('select token_hash from evidence_request where id = $1', [request.id]);
    expect(rows[0].token_hash).toBe(hashLinkToken(linkToken!));
    expect(rows[0].token_hash).not.toContain(linkToken);
    const shown = await viaLink(linkToken!, (c, id) => requestByLink(c, id));
    expect(shown).toMatchObject({ title: 'Employer survey', institutionName: 'Gulf University', requestedByName: 'alo', internalTitle: 'Assessment of learning' });
    expect(await resolveRequestLink(w.pool, hashLinkToken('not-a-real-link-token-at-all'))).toBeNull();
  });

  it('a new link replaces the old one', async () => {
    const renewed = await w.as('alo', (c) => renewRequestLink(c, ids.r2!));
    expect(await resolveRequestLink(w.pool, hashLinkToken(ids.token!))).toBeNull();
    ids.token = renewed.linkToken!;
    await expect(w.as('alo', (c) => renewRequestLink(c, ids.r1!))).rejects.toThrow(ConflictError);
  });

  it('the answer is stored as proposed evidence, audited, and the link stops working', async () => {
    await viaLink(ids.token!, (c, id) => answerByLink(c, id, file('employer'), 'Survey of 40 employers'));
    expect(await resolveRequestLink(w.pool, hashLinkToken(ids.token!))).toBeNull();
    const [r] = (await w.as('alo', (c) => requestsForInternal(c, ids.assessment!))).filter((x) => x.id === ids.r2);
    expect(r).toMatchObject({ status: 'supplied', linkExpiresAt: null });
    const links = await w.as('alo', (c) => linksForInternal(c, ids.assessment!));
    const link = links.find((l) => l.evidenceItemId === r!.evidenceItemId)!;
    expect(link).toMatchObject({ reviewStatus: 'proposed', rationale: 'Survey of 40 employers', linkedByName: null });
    const f = await w.as('alo', (c) => readVersionFile(c, link.evidenceVersionId));
    expect(new TextDecoder().decode(f.bytes)).toBe('employer');
    const { rows } = await w.db.su.query(`select actor_type from audit_event where target_type = 'evidence_request' and target_id = $1 and action = 'update'`, [ids.r2]);
    expect(rows.map((x) => x.actor_type)).toContain('system');
  });

  it('a cancelled request closes its link and cannot be reopened', async () => {
    const { request, linkToken } = await w.as('alo', (c) => createEvidenceRequest(c, ids.assessment!, { title: 'Advisory board minutes', assigneeEmail: 'board@example.com' }));
    await w.as('alo', (c) => cancelEvidenceRequest(c, request.id));
    expect(await resolveRequestLink(w.pool, hashLinkToken(linkToken!))).toBeNull();
    await expect(w.db.su.query(`update evidence_request set status = 'open' where id = $1`, [request.id])).rejects.toThrow(/closed/);
  });
});

describe('asking people to fill in a form', () => {
  it('sends one request per address, a link to those without an account', async () => {
    const item = await w.as('alo', (c) => createEvidence(c, { title: 'Unit headcount', type: 'data' }));
    ids.data = item.id;
    await expect(w.as('alo', (c) => createFormRequests(c, item.id, { assigneeEmails: ['contrib@x.org'] }))).rejects.toThrow(/define the columns first/);
    await w.as('alo', (c) => saveDatasetSpec(c, item.id, { columns: [{ key: 'unit', label: 'Unit', type: 'text', required: true }, { key: 'staff', label: 'Staff', type: 'integer' }] }));
    const out = await w.as('alo', (c) => createFormRequests(c, item.id, { assigneeEmails: ['Contrib@x.org', 'dean@partner.org', 'contrib@x.org'], dueDate: '2030-01-01' }));
    expect(out.map((o) => [o.request.assigneeEmail, !!o.linkToken])).toEqual([['contrib@x.org', false], ['dean@partner.org', true]]);
    expect(out[0]!.request).toMatchObject({ dataItemId: item.id, dataItemTitle: 'Unit headcount', internalCode: null, title: 'Unit headcount' });
    ids.formReq = out[0]!.request.id; ids.formToken = out[1]!.linkToken!;
    expect((await w.as('alo', (c) => requestsForDataItem(c, item.id))).length).toBe(2);
  });

  it('the person asked fills it in, even though the form is not open to everyone', async () => {
    await expect(w.as('coord', (c) => formForRequest(c, ids.formReq!))).resolves.toBeTruthy(); // coord may add evidence
    await expect(w.as('second', (c) => formForRequest(c, ids.formReq!))).rejects.toThrow(ForbiddenError);
    expect((await w.as('contrib', (c) => formForRequest(c, ids.formReq!))).columns.map((x) => x.key)).toEqual(['unit', 'staff']);
    await expect(w.as('contrib', (c) => answerEvidenceRequest(c, ids.formReq!, file('x')))).rejects.toThrow(/form to be filled in/);
    await expect(w.as('contrib', (c) => answerRequestWithForm(c, ids.formReq!, { answers: { staff: 'many' } }))).rejects.toThrow();
    const done = await w.as('contrib', (c) => answerRequestWithForm(c, ids.formReq!, { answers: { unit: 'Engineering', staff: '42' } }));
    expect(done).toMatchObject({ status: 'supplied', evidenceItemId: ids.data });
  });

  it('through the one-time link the page shows the form, and one answer closes it', async () => {
    const shown = await viaLink(ids.formToken!, (c, id) => requestByLink(c, id));
    expect(shown.form?.columns.map((x) => x.label)).toEqual(['Unit', 'Staff']);
    await expect(viaLink(ids.formToken!, (c, id) => answerByLink(c, id, file('x')))).rejects.toThrow(/form to be filled in/);
    await viaLink(ids.formToken!, (c, id) => answerFormByLink(c, id, { answers: { unit: 'كلية الهندسة', staff: '١٥' } }));
    expect(await resolveRequestLink(w.pool, hashLinkToken(ids.formToken!))).toBeNull();
    const responses = await w.as('alo', (c) => listDataResponses(c, ids.data!));
    expect(responses.map((r) => [r.via, r.answers.staff])).toEqual([['link', 15], ['ams', 42]]);
  });
});
