// SAML spike (TASK-006): can @better-auth/sso complete a SAML login against a standards-compliant IdP?
// The IdP here is a local mock built with samlify; a real IdP (QuickLaunch) has not been exercised. The mock IdP
// signs with the committed throwaway keypair in ../fixtures (self-signed, mock-idp, ten years) — nothing real.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import pg from 'pg';
import * as samlify from 'samlify';
import { betterAuth } from 'better-auth';
import { sso } from '@better-auth/sso';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';

let db: TestDb;
let pool: pg.Pool;
const APP = 'http://localhost:3000';

beforeAll(async () => {
  db = await createTestDb('saml');
  pool = new pg.Pool({ connectionString: db.url });
  await db.su.query(`create table "ssoProvider" ("id" text not null primary key, "issuer" text not null, "oidcConfig" text, "samlConfig" text, "userId" text not null references "user" ("id") on delete cascade, "providerId" text not null unique, "organizationId" text, "domain" text not null)`);
});
afterAll(async () => { await pool.end(); await db.close(); });

it('completes a SAML login against a mock IdP', async () => {
  const key = readFileSync(resolve(import.meta.dirname, '../fixtures/mock-idp-key.pem'), 'utf8');
  const cert = readFileSync(resolve(import.meta.dirname, '../fixtures/mock-idp-cert.pem'), 'utf8');
  const certBody = cert.replace(/-----[A-Z ]+-----|\s/g, '');
  const idpEntity = 'https://idp.test/';
  const idpXml = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${idpEntity}"><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAuthnRequestsSigned="false"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${certBody}</X509Certificate></X509Data></KeyInfo></KeyDescriptor><NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.test/sso"/><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.test/sso"/></IDPSSODescriptor></EntityDescriptor>`;

  const auth = betterAuth({
    database: pool, secret: 'spike-secret-'.repeat(4), baseURL: APP,
    emailAndPassword: { enabled: true },
    plugins: [sso({ disableImplicitSignUp: false })],
    trustedOrigins: [APP],
  });
  const ctx = await auth.$context;
  const admin = await ctx.internalAdapter.createUser({ email: 'a@test.edu', name: 'A', emailVerified: true }, { method: 'admin' });
  await ctx.internalAdapter.linkAccount({ userId: admin.id, providerId: 'credential', accountId: admin.id, password: await ctx.password.hash('admin password 1') });
  const login = await auth.handler(new Request(`${APP}/api/auth/sign-in/email`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: APP }, body: JSON.stringify({ email: 'a@test.edu', password: 'admin password 1' }),
  }));
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const reg = await auth.handler(new Request(`${APP}/api/auth/sso/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: APP, cookie },
    body: JSON.stringify({
      providerId: 'saml-mock', issuer: idpEntity, domain: 'test.edu',
      samlConfig: {
        issuer: `${APP}/api/auth/sso/saml2/sp/metadata?providerId=saml-mock`,
        entryPoint: 'https://idp.test/sso', cert, callbackUrl: `${APP}/dashboard`,
        audience: `${APP}/api/auth/sso/saml2/sp/metadata?providerId=saml-mock`,
        wantAssertionsSigned: true,
        idpMetadata: { metadata: idpXml },
        identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      },
    }),
  }));
  expect(reg.status, await reg.clone().text()).toBe(200);

  const metaRes = await auth.handler(new Request(`${APP}/api/auth/sso/saml2/sp/metadata?providerId=saml-mock`));
  expect(metaRes.status).toBe(200);
  const spXml = await metaRes.text();
  expect(spXml).toContain('AssertionConsumerService');

  // SP-initiated: the app redirects the browser to the IdP with an AuthnRequest.
  const start = await auth.handler(new Request(`${APP}/api/auth/sign-in/sso`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: APP },
    body: JSON.stringify({ providerId: 'saml-mock', callbackURL: '/dashboard' }),
  }));
  const startBody = await start.text();
  expect(start.status, startBody).toBe(200);
  const redirect = new URL((JSON.parse(startBody) as { url: string }).url);
  expect(redirect.origin + redirect.pathname).toBe('https://idp.test/sso');
  expect(redirect.searchParams.get('SAMLRequest')).toBeTruthy();
  const relayState = redirect.searchParams.get('RelayState') ?? '';

  // The mock IdP answers with a signed assertion for a user the app has never seen.
  samlify.setSchemaValidator({ validate: async () => 'skipped' });
  const idp = samlify.IdentityProvider({ metadata: idpXml, privateKey: key, isAssertionEncrypted: false, wantAuthnRequestsSigned: false,
    loginResponseTemplate: { context: '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{ID}" Version="2.0" IssueInstant="{IssueInstant}" Destination="{Destination}" InResponseTo="{InResponseTo}"><saml:Issuer>{Issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema" ID="{AssertionID}" Version="2.0" IssueInstant="{IssueInstant}"><saml:Issuer>{Issuer}</saml:Issuer><saml:Subject><saml:NameID Format="{NameIDFormat}">{NameID}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="{SubjectConfirmationDataNotOnOrAfter}" Recipient="{SubjectRecipient}" InResponseTo="{InResponseTo}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="{ConditionsNotBefore}" NotOnOrAfter="{ConditionsNotOnOrAfter}"><saml:AudienceRestriction><saml:Audience>{Audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="{IssueInstant}" SessionIndex="{SessionIndex}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>{AttributeStatement}</saml:AttributeStatement></saml:Assertion></samlp:Response>' } });
  const sp = samlify.ServiceProvider({ metadata: spXml, wantAssertionsSigned: true });
  const requestId = (() => {
    const raw = Buffer.from(redirect.searchParams.get('SAMLRequest')!, 'base64');
    const xml = inflateRawSync(raw).toString();
    return /ID="([^"]+)"/.exec(xml)![1]!;
  })();
  const { context } = await idp.createLoginResponse(sp, { extract: { request: { id: requestId } } } as never, 'post', {} as never, (template: string) => {
    const now = new Date();
    const later = new Date(now.getTime() + 5 * 60_000).toISOString();
    const id = `_${randomUUID()}`;
    const fields: Record<string, string> = {
      ID: id, AssertionID: `_${randomUUID()}`, IssueInstant: now.toISOString(), Destination: `${APP}/api/auth/sso/saml2/sp/acs/saml-mock`,
      InResponseTo: requestId, Issuer: idpEntity, NameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      NameID: 'sso-user@test.edu', SubjectConfirmationDataNotOnOrAfter: later, SubjectRecipient: `${APP}/api/auth/sso/saml2/sp/acs/saml-mock`,
      ConditionsNotBefore: now.toISOString(), ConditionsNotOnOrAfter: later, Audience: `${APP}/api/auth/sso/saml2/sp/metadata?providerId=saml-mock`,
      SessionIndex: `_${randomUUID()}`,
      AttributeStatement: '<saml:Attribute Name="email"><saml:AttributeValue>sso-user@test.edu</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>SSO User</saml:AttributeValue></saml:Attribute>',
    };
    return { id, context: template.replace(/\{(\w+)\}/g, (_m, k: string) => fields[k] ?? '') };
  }, false);

  const acs = await auth.handler(new Request(`${APP}/api/auth/sso/saml2/sp/acs/saml-mock`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.test' },
    body: new URLSearchParams({ SAMLResponse: context, RelayState: relayState }),
  }));
  const loc = acs.headers.get('location') ?? '';
  expect(acs.status, `${acs.status} ${loc} ${await acs.clone().text()}`).toBe(302);
  expect(acs.headers.getSetCookie().join(';')).toContain('session_token');
  const { rows } = await db.su.query(`select email from "user" where email = 'sso-user@test.edu'`);
  expect(rows).toHaveLength(1);
}, 30000);
