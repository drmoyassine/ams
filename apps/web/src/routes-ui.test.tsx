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
});
