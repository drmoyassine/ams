import { describe, expect, it } from 'vitest';
import { oauthContinuation } from './oauth-continue';

describe('continuing the BI sign-in after the AMS sign-in (DEC-035)', () => {
  it('sends the authorization request back to the issuer without its signature', () => {
    const to = oauthContinuation('?response_type=code&client_id=bi-app&redirect_uri=https%3A%2F%2Fbi.example.org%2Fcb&state=x&exp=1&ba_iat=2&ba_param=a&ba_param=b&sig=zz');
    expect(to).toBe('/api/auth/oauth2/authorize?response_type=code&client_id=bi-app&redirect_uri=https%3A%2F%2Fbi.example.org%2Fcb&state=x');
  });

  it('does nothing for an ordinary sign-in', () => {
    expect(oauthContinuation('')).toBeNull();
    expect(oauthContinuation('?client_id=x')).toBeNull();
    expect(oauthContinuation('?next=/reports')).toBeNull();
  });
});
