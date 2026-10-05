/* global process, fetch, setTimeout, console */
// One-shot bootstrap for a single-node Garage: assign the layout, import the S3 key the app is configured with,
// create the bucket and grant the key access. Idempotent: every step first checks whether it is already done, so it is
// safe to re-run on every `docker compose up` / redeploy. Uses the Garage admin API v1 (pinned image in compose.yaml).
const admin = process.env.GARAGE_ADMIN_URL ?? 'http://garage:3903';
const token = process.env.GARAGE_ADMIN_TOKEN;
const keyId = process.env.S3_ACCESS_KEY_ID;
const secret = process.env.S3_SECRET_ACCESS_KEY;
const bucket = process.env.S3_BUCKET ?? 'ams';
const attempts = Number(process.env.GARAGE_INIT_ATTEMPTS ?? 60); // x 2 s while Garage starts
if (!token || !keyId || !secret) throw new Error('GARAGE_ADMIN_TOKEN, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required');
if (!/^GK[0-9a-f]{24}$/.test(keyId) || !/^[0-9a-f]{64}$/.test(secret)) {
  throw new Error('Garage keys must look like GK + 24 hex chars (id) and 64 hex chars (secret); see .env.example');
}

const log = (msg) => console.log(`[garage-init] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeJson = (t) => { try { return JSON.parse(t); } catch { return t; } };

/** One admin API call. Returns { status, json }; throws only on network errors. */
async function raw(method, path, body) {
  const res = await fetch(`${admin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? safeJson(text) : null, text };
}

/** Like raw, but any status outside `ok` is an error that shows what Garage answered. Retries network failures. */
async function call(method, path, body, ok = [200]) {
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await raw(method, path, body);
      if (!ok.includes(r.status)) throw new Error(`${method} ${path} -> ${r.status}: ${r.text}`);
      return r;
    } catch (e) {
      last = e;
      if (String(e.message).includes(' -> ')) throw e; // a real answer from Garage: do not retry
      log(`${method} ${path} failed (${e.message}); retry ${attempt}/5`);
      await sleep(2000);
    }
  }
  throw last;
}

let status;
for (let i = 0; i < attempts && !status; i++) {
  try { const r = await raw('GET', '/v1/status'); if (r.status === 200) status = r.json; else log(`status -> ${r.status}: ${r.text}`); } catch (e) { log(`waiting for admin API: ${e.message}`); }
  if (!status) await sleep(2000);
}
if (!status) throw new Error('Garage admin API did not become ready');
const layout = (await call('GET', '/v1/layout')).json; // {version, roles, stagedRoleChanges}
log(`connected to node ${status.node}, layout version ${layout.version ?? 0}, ${layout.roles?.length ?? 0} role(s)`);

if (!layout.roles?.length) {
  await call('POST', '/v1/layout', [{ id: status.node, zone: 'dc1', capacity: 1073741824, tags: [] }]);
  await call('POST', '/v1/layout/apply', { version: (layout.version ?? 0) + 1 });
  log('layout applied');
} else {
  log('layout already present');
}

const existingKey = await raw('GET', `/v1/key?id=${encodeURIComponent(keyId)}`);
if (existingKey.status === 200) {
  log('access key already present');
} else {
  await call('POST', '/v1/key/import', { accessKeyId: keyId, secretAccessKey: secret, name: 'ams' });
  log('access key imported');
}

let info = await raw('GET', `/v1/bucket?globalAlias=${encodeURIComponent(bucket)}`);
if (info.status !== 200) {
  info = await call('POST', '/v1/bucket', { globalAlias: bucket });
  log('bucket created');
} else {
  log('bucket already present');
}
await call('POST', '/v1/bucket/allow', { bucketId: info.json.id, accessKeyId: keyId, permissions: { read: true, write: true, owner: true } });
log(`garage ready: bucket ${bucket}`);
