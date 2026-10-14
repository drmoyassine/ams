// @vitest-environment jsdom
// External standards live in Settings; the old addresses still lead there.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./lib/auth', () => ({ authClient: { getSession: async () => ({ data: { user: { id: 'u' } } }), signOut: async () => undefined } }));

async function open(path: string) {
  window.history.pushState({}, '', path);
  const { router } = await import('./router');
  await router.load();
  return router.state.location.pathname;
}

describe('routes', () => {
  it('sends the old Standards address to External Standards in Settings', async () => {
    expect(await open('/standards')).toBe('/settings/external-standards');
  });
  it('sends an old version address to the same version in Settings', async () => {
    expect(await open('/versions/abc-123')).toBe('/settings/versions/abc-123');
  });
  it('sends the old Sources address (tab=settings, section=sources) to the Docs tab, and keeps the other addresses as they are', async () => {
    const { router } = await import('./router');
    await open('/settings/versions/abc-123?tab=settings&section=sources');
    expect(router.state.location.pathname).toBe('/settings/versions/abc-123');
    expect(router.state.location.search).toEqual({ tab: 'docs' });
    await open('/settings/versions/abc-123?tab=settings&section=details');
    expect(router.state.location.search).toEqual({ tab: 'settings', section: 'details' });
    await open('/settings/versions/abc-123?tab=docs');
    expect(router.state.location.search).toEqual({ tab: 'docs' });
    await open('/settings/versions/abc-123?doc=0b1a7a52-6d0e-4f04-b0c7-5a1b7e0f7c11&page=4');
    expect(router.state.location.search).toEqual({ doc: '0b1a7a52-6d0e-4f04-b0c7-5a1b7e0f7c11', page: 4 });
  });
  it('has Settings -> Documents', async () => {
    expect(await open('/settings/documents')).toBe('/settings/documents');
  });
});
