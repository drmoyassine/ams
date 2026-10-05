/* global process, fetch, setTimeout, console */
// One-shot bootstrap for a single-node Garage: assign the layout, import the S3 key the app is configured with,
// create the bucket and grant the key access. Idempotent; safe to re-run on every `docker compose up`.
// Uses the Garage admin API v1 (pinned image in compose.yaml).
const admin = process.env.GARAGE_ADMIN_URL ?? 'http://garage:3903';
const token = process.env.GARAGE_ADMIN_TOKEN;
const keyId = process.env.S3_ACCESS_KEY_ID;
const secret = process.env.S3_SECRET_ACCESS_KEY;
const bucket = process.env.S3_BUCKET ?? 'ams';
if (!token || !keyId || !secret) throw new Error('GARAGE_ADMIN_TOKEN, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required');
if (!/^GK[0-9a-f]{24}$/.test(keyId) || !/^[0-9a-f]{64}$/.test(secret)) {
  throw new Error('Garage keys must look like GK + 24 hex chars (id) and 64 hex chars (secret); see .env.example');
}

async function call(method, path, body, okStatuses = [200]) {
  const res = await fetch(`${admin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!okStatuses.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return { status: res.status, json: text ? safeJson(text) : null };
}
const safeJson = (t) => { try { return JSON.parse(t); } catch { return t; } };

let status;
for (let i = 0; i < 60; i++) {
  try { status = (await call('GET', '/v1/status')).json; break; } catch { await new Promise((r) => setTimeout(r, 2000)); }
}
if (!status) throw new Error('Garage admin API did not become ready');

if (!status.layout?.roles?.length) {
  await call('POST', '/v1/layout', [{ id: status.node, zone: 'dc1', capacity: 1073741824, tags: [] }]);
  await call('POST', '/v1/layout/apply', { version: (status.layout?.version ?? 0) + 1 });
  console.log('layout applied');
}

// Importing an existing key is not idempotent: a repeat is reported as a conflict/bad request; both mean "already there".
await call('POST', '/v1/key/import', { accessKeyId: keyId, secretAccessKey: secret, name: 'ams' }, [200, 400, 409]);

const created = await call('POST', '/v1/bucket', { globalAlias: bucket }, [200, 409]);
const info = created.status === 200 ? created.json : (await call('GET', `/v1/bucket?globalAlias=${encodeURIComponent(bucket)}`)).json;
await call('POST', '/v1/bucket/allow', {
  bucketId: info.id, accessKeyId: keyId, permissions: { read: true, write: true, owner: true },
});
console.log(`garage ready: bucket ${bucket}`);
