import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError, VersionConflictError } from '../../src/domain/errors.ts';
import type { Principal } from '../../src/domain/allowlist.ts';
import { createAllowlistService } from '../../src/services/allowlist-service.ts';
import { createMemoryNotifier, createMemoryRepository, testConfig } from '../helpers/index.ts';

const userA: Principal = { userId: 'user-a', tenantId: 'tenant-a' };

const buildService = (
  repository = createMemoryRepository(),
  config = testConfig,
  notifier = createMemoryNotifier(),
) => createAllowlistService({ repository, notifier, config });

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
  // A new version has not reached WAF, so it must not inherit the last one's
  // acknowledgement - that would report an unapplied edit as already live.
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

test('signals the sync worker once per write, grouped by tenant', async () => {
  const notifier = createMemoryNotifier();
  const service = buildService(createMemoryRepository(), testConfig, notifier);

  await service.replace({ principal: userA, cidrs: ['203.0.113.9'], expectedVersion: 0 });
  await service.replace({ principal: userA, cidrs: ['198.51.100.7'], expectedVersion: 1 });

  // Version is part of the signal, so the queue's dedup id distinguishes a
  // genuine second edit from a retry of the first.
  assert.deepEqual(notifier.sent, [
    { tenantId: 'tenant-a', ownerId: 'user-a', version: 1 },
    { tenantId: 'tenant-a', ownerId: 'user-a', version: 2 },
  ]);
});

test('a failed signal still stores the write and answers PENDING', async () => {
  // The write and the send are not atomic. The write is the durable one; the
  // 15-minute sweep reconciles a tenant whose message never arrived, so losing
  // the signal must not lose the edit.
  const repository = createMemoryRepository();
  const errors: string[] = [];
  const service = createAllowlistService({
    repository,
    notifier: createMemoryNotifier({ fail: true }),
    config: testConfig,
    logger: { error: (_context, message) => errors.push(message) },
  });

  const written = await service.replace({
    principal: userA,
    cidrs: ['203.0.113.9'],
    expectedVersion: 0,
  });

  assert.equal(written.syncStatus, 'PENDING');
  assert.deepEqual((await repository.get('tenant-a', 'user-a'))?.cidrs, ['203.0.113.9/32']);
  assert.equal(errors.length, 1, 'a lost signal is logged, not swallowed');
});

test('does not signal when validation rejects the write', async () => {
  const notifier = createMemoryNotifier();
  const service = buildService(createMemoryRepository(), testConfig, notifier);

  await assert.rejects(
    service.replace({ principal: userA, cidrs: ['10.0.0.1'], expectedVersion: 0 }),
    ValidationError,
  );
  assert.deepEqual(notifier.sent, []);
});

test('rejects a write against a stale version', async () => {
  const service = buildService();
  const write = () =>
    service.replace({ principal: userA, cidrs: ['203.0.113.9'], expectedVersion: 0 });

  await write();
  await assert.rejects(write(), VersionConflictError);
});
