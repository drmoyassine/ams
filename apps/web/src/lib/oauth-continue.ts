// The BI's sign-in through the AMS (DEC-035): the issuer sends a person who is not signed in to /login with the authorization
// request in the query (and its signature). Once they have signed in, the same request is sent to the issuer again, which now
// finds the session and answers the client. Only this path on this origin is ever the target, so the query cannot redirect anywhere
// else; the issuer checks the client and its redirect address again.
const SIGNATURE_PARAMS = new Set(['exp', 'sig', 'ba_iat', 'ba_param']);

/** The issuer address to continue to after sign-in, or null when this sign-in was not asked for by a client. */
export function oauthContinuation(search: string): string | null {
  const params = new URLSearchParams(search);
  if (!params.get('client_id') || params.get('response_type') !== 'code') return null;
  const next = new URLSearchParams();
  for (const [k, v] of params) if (!SIGNATURE_PARAMS.has(k)) next.append(k, v);
  return `/api/auth/oauth2/authorize?${next.toString()}`;
}
