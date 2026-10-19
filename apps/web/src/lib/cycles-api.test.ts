import { describe, expect, it } from 'vitest';
import { createApi } from './api';
import { cyclesApi } from './cycles-api';

/** A fetch that records each request and answers with JSON (`{}` unless given). */
function recorder(reply: unknown = {}) {
  const calls: { method: string; url: string; body: string | null }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input instanceof Request ? input : new URL(String(input), 'http://x'), init);
    calls.push({ method: req.method, url: new URL(req.url).pathname + new URL(req.url).search, body: req.method === 'GET' ? null : await req.text() });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, api: cyclesApi(createApi(fetcher), fetcher) };
}

describe('cyclesApi', () => {
  it('reaches the template, cycle, stage, output and input routes with the bodies the API expects', async () => {
    const { calls, api } = recorder();
    await api.templates({ status: 'published', anchorKind: 'program' });
    await api.launch({ templateId: 't1', anchorKind: 'org_unit', anchorId: 'u1', startDate: '2026-09-01' });
    await api.list({ anchorKind: 'program', anchorId: 'p1', status: 'active' });
    await api.activate('c1');
    await api.cancel('c1', 'merged');
    await api.startStage('s1');
    await api.skipStage('s1', 'not needed');
    await api.setNote('o1', 'text');
    await api.decide('o1', { decision: 'returned', comment: 'add data' });
    await api.setPick('i1', { refKind: 'evidence_item', refId: 'e1' });
    await api.myWork();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/cycle-templates?status=published&anchorKind=program', 'POST /api/cycles', 'GET /api/cycles?anchorKind=program&anchorId=p1&status=active',
      'POST /api/cycles/c1/activate', 'POST /api/cycles/c1/cancel', 'POST /api/cycle-stages/s1/start', 'POST /api/cycle-stages/s1/skip', 'PUT /api/cycle-outputs/o1/note',
      'POST /api/cycle-outputs/o1/decision', 'PUT /api/cycle-inputs/i1/pick', 'GET /api/my-cycle-work',
    ]);
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ templateId: 't1', anchorKind: 'org_unit', startDate: '2026-09-01' });
    expect(JSON.parse(calls[8]!.body!)).toEqual({ decision: 'returned', comment: 'add data' });
  });

  it('sends a file as the request body with its name in the query, and names the download address', async () => {
    const { calls, api } = recorder();
    const file = new File([new Uint8Array([1, 2, 3])], 'ملخص.pdf', { type: 'application/pdf' });
    await api.uploadFile('o1', file);
    expect(calls[0]).toMatchObject({ method: 'PUT', url: `/api/cycle-outputs/o1/file?fileName=${encodeURIComponent('ملخص.pdf')}` });
    expect(api.fileUrl('o1')).toBe('/api/cycle-outputs/o1/file');
  });
});
