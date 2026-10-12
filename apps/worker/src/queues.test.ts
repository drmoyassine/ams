// The three background services (worker, parser, agent) are one codebase told apart by WORKER_QUEUES (DEC-024).
// These tests need no database: the queue library is a recorder, and the compose files are read as data.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { handlers } from '@ams/core';
import { JOB_TYPES, QUEUE_GROUPS, QUEUE_GROUP_NAMES, parseWorkerQueues } from '@ams/shared';
import { PURGE_TRASH_CRON, startWorker } from './worker.js';

function recorder() {
  const created: string[] = [];
  const worked: string[] = [];
  const scheduled: { name: string; cron: string }[] = [];
  const boss = {
    createQueue: async (n: string) => { created.push(n); },
    work: async (n: string) => { worked.push(n); return 'id'; },
    schedule: async (name: string, cron: string) => { scheduled.push({ name, cron }); },
  } as unknown as PgBoss;
  return { boss, created, worked, scheduled };
}

describe('startWorker subscriptions', () => {
  it('takes only the queues it is given, but makes every queue exist', async () => {
    const r = recorder();
    const subscribed = await startWorker(r.boss, {} as pg.Pool, { queues: ['extract_text'] });
    expect(subscribed).toEqual(['extract_text']);
    expect(r.worked).toEqual(['extract_text']);
    expect([...r.created].sort()).toEqual([...JOB_TYPES].sort());
  });

  it('takes every type that has a handler by default (local development, tests)', async () => {
    const r = recorder();
    await startWorker(r.boss, {} as pg.Pool);
    // purge_trash is a scheduled tick with its own subscription rather than a handler (no job row), DEC-026.
    expect([...r.worked].sort()).toEqual(JOB_TYPES.filter((t) => handlers[t] || t === 'purge_trash').sort());
  });

  it('declares the daily Trash purge schedule only in the service that takes purge_trash', async () => {
    const general = recorder();
    await startWorker(general.boss, {} as pg.Pool, { queues: QUEUE_GROUPS.worker });
    expect(general.scheduled).toEqual([{ name: 'purge_trash', cron: PURGE_TRASH_CRON }]);
    const parser = recorder();
    await startWorker(parser.boss, {} as pg.Pool, { queues: QUEUE_GROUPS.parser });
    expect(parser.scheduled).toEqual([]);
  });

  it.each(QUEUE_GROUP_NAMES)('the %s group parses into its own types', (name) => {
    expect(parseWorkerQueues(QUEUE_GROUPS[name].join(','))).toEqual([...QUEUE_GROUPS[name]]);
  });
});

type Service = { environment?: Record<string, string>; depends_on?: Record<string, { condition: string }>; build?: { target: string } };

describe('compose files', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const load = (f: string) => parse(readFileSync(resolve(root, f), 'utf8')) as { services: Record<string, Service> };
  const compose = load('compose.yaml');

  it('each background service takes exactly the types of its group in QUEUE_GROUPS', () => {
    for (const name of QUEUE_GROUP_NAMES) {
      const svc = compose.services[name];
      expect(svc, `compose.yaml has no ${name} service`).toBeDefined();
      expect(parseWorkerQueues(svc!.environment?.WORKER_QUEUES)).toEqual([...QUEUE_GROUPS[name]]);
      expect(svc!.environment?.WORKER_NAME).toBe(name);
      expect(svc!.build?.target).toBe(name);
    }
  });

  it('together the services take every job type exactly once', () => {
    const all = QUEUE_GROUP_NAMES.flatMap((n) => parseWorkerQueues(compose.services[n]!.environment?.WORKER_QUEUES));
    expect([...all].sort()).toEqual([...JOB_TYPES].sort());
  });

  it('background services wait for postgres, garage and the app (which migrates and prepares the bucket)', () => {
    for (const name of QUEUE_GROUP_NAMES) {
      const dep = compose.services[name]!.depends_on ?? {};
      for (const needed of ['postgres', 'garage', 'app']) expect(dep[needed]?.condition, `${name} -> ${needed}`).toBe('service_healthy');
    }
  });

  it('the app prepares Garage itself: admin URL set, depends on garage, and there is no garage-init service', () => {
    expect(compose.services['garage-init']).toBeUndefined();
    expect(compose.services.app!.environment?.GARAGE_ADMIN_URL).toBe('http://garage:3903');
    expect(compose.services.app!.depends_on?.garage?.condition).toBe('service_healthy');
  });

  it('compose.local.yaml only adds to services that exist', () => {
    const local = load('compose.local.yaml');
    for (const name of Object.keys(local.services)) expect(compose.services[name], name).toBeDefined();
  });
});
