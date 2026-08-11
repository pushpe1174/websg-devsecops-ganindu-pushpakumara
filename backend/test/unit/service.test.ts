import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError, VersionConflictError } from '../../src/lib/errors.ts';
import type { Principal } from '../../src/lib/jwt.ts';
import { createAllowlistService } from '../../src/modules/ip-allowlist/service.ts';
import { createMemoryRepository, testConfig } from '../helpers/index.ts';

const userA: Principal = { userId: 'user-a', tenantId: 'tenant-a' };

const buildService = (repository = createMemoryRepository(), config = testConfig) =>
  createAllowlistService(repository, config);

test('returns an empty allowlist for a user who has never written one', async () => {
  const record = await buildService().get(userA);
  assert.deepEqual(record, {
    ownerId: 'user-a',
    tenantId: 'tenant-a',
    cidrs: [],
    version: 0,
    updatedAt: '',
    syncedVersion: 0,
    // Nothing outstanding, so nothing is pending.
    syncStatus: 'APPLIED',
  });
});

test('a fresh write is PENDING until the worker acknowledges it', async () => {
  const service = buildService();
  const written = await service.replace({
    principal: userA,
    cidrs: ['203.0.113.9'],
    expectedVersion: 0,
  });

  assert.equal(written.syncStatus, 'PENDING');
  assert.equal(written.syncedVersion, undefined);
  assert.equal((await service.get(userA)).syncStatus, 'PENDING');
});

test('a write returns APPLIED once the worker acknowledges within the wait', async () => {
  const repository = createMemoryRepository();
  const service = buildService(repository, { ...testConfig, syncWaitMs: 2000, syncPollMs: 5 });

  // The worker confirming the version live in WAF, mid-wait.
  const acknowledge = setTimeout(async () => {
    const stored = await repository.get('tenant-a', 'user-a');
    if (stored) Object.assign(stored, { syncedVersion: stored.version, syncedAt: 'now' });
  }, 20);

  const written = await service.replace({
    principal: userA,
    cidrs: ['203.0.113.9'],
    expectedVersion: 0,
  });
  clearTimeout(acknowledge);

  assert.equal(written.syncStatus, 'APPLIED');
  assert.equal(written.syncedVersion, written.version);
});

test('a write that is never acknowledged answers PENDING rather than hanging', async () => {
  const service = buildService(createMemoryRepository(), {
    ...testConfig,
    syncWaitMs: 30,
    syncPollMs: 5,
  });

  const written = await service.replace({
    principal: userA,
    cidrs: ['203.0.113.9'],
    expectedVersion: 0,
  });

  assert.equal(written.syncStatus, 'PENDING');
});

test('a write never carries the previous acknowledgement', async () => {
  // The EventBridge Pipe filter treats "no syncedVersion" as a user edit. If a
  // write ever preserved it, the worker would stop seeing changes.
  const repository = createMemoryRepository([
    {
      tenantId: 'tenant-a',
      ownerId: 'user-a',
      cidrs: ['198.51.100.0/24'],
      version: 3,
      updatedAt: '2026-08-11T09:12:00.000Z',
      syncedVersion: 3,
      syncedAt: '2026-08-11T09:12:04.000Z',
    },
  ]);

  const written = await buildService(repository).replace({
    principal: userA,
    cidrs: ['203.0.113.9'],
    expectedVersion: 3,
  });

  assert.equal(written.syncedVersion, undefined);
  assert.equal(written.syncedAt, undefined);
  assert.equal(written.syncStatus, 'PENDING');
});

test('normalises entries before storing them', async () => {
  const service = buildService();
  const record = await service.replace({
    principal: userA,
    cidrs: ['203.0.113.9', '198.51.100.0/24'],
    expectedVersion: 0,
  });

  assert.deepEqual(record.cidrs, ['198.51.100.0/24', '203.0.113.9/32']);
  assert.equal(record.version, 1);
  assert.deepEqual((await service.get(userA)).cidrs, record.cidrs);
});

test('rejects an invalid list without writing anything', async () => {
  const service = buildService();
  await assert.rejects(
    service.replace({ principal: userA, cidrs: ['10.0.0.1'], expectedVersion: 0 }),
    ValidationError,
  );
  assert.equal((await service.get(userA)).version, 0);
});

test('rejects a write against a stale version', async () => {
  const service = buildService();
  const write = () =>
    service.replace({ principal: userA, cidrs: ['203.0.113.9'], expectedVersion: 0 });

  await write();
  await assert.rejects(write(), VersionConflictError);
});
