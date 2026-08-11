import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError, VersionConflictError } from '../../src/lib/errors.ts';
import { createAllowlistService } from '../../src/modules/ip-allowlist/service.ts';
import { createMemoryRepository, testConfig } from '../helpers/index.ts';

const buildService = () => createAllowlistService(createMemoryRepository(), testConfig);

test('returns an empty allowlist for an unknown tenant', async () => {
  const record = await buildService().get('agency-a');
  assert.deepEqual(record, {
    tenantId: 'agency-a',
    cidrs: [],
    version: 0,
    updatedAt: '',
    updatedBy: '',
    syncedVersion: 0,
    // Nothing outstanding, so nothing is pending.
    syncStatus: 'APPLIED',
  });
});

test('a fresh write is PENDING until the worker acknowledges it', async () => {
  const service = buildService();
  const written = await service.replace({
    tenantId: 'agency-a',
    cidrs: ['203.0.113.9'],
    updatedBy: 'user-1',
    expectedVersion: 0,
  });

  assert.equal(written.syncStatus, 'PENDING');
  assert.equal(written.syncedVersion, undefined);
  assert.equal((await service.get('agency-a')).syncStatus, 'PENDING');
});

test('a write never carries the previous acknowledgement', async () => {
  // The EventBridge Pipe filter treats "no syncedVersion" as "tenant edit". If
  // a write ever preserved it, the worker would stop seeing tenant changes.
  const repository = createMemoryRepository([
    {
      tenantId: 'agency-a',
      cidrs: ['198.51.100.0/24'],
      version: 3,
      updatedAt: '2026-08-11T09:12:00.000Z',
      updatedBy: 'user-1',
      syncedVersion: 3,
      syncedAt: '2026-08-11T09:12:04.000Z',
    },
  ]);
  const service = createAllowlistService(repository, testConfig);

  const written = await service.replace({
    tenantId: 'agency-a',
    cidrs: ['203.0.113.9'],
    updatedBy: 'user-1',
    expectedVersion: 3,
  });

  assert.equal(written.syncedVersion, undefined);
  assert.equal(written.syncedAt, undefined);
  assert.equal(written.syncStatus, 'PENDING');
});

test('normalises entries before storing them', async () => {
  const service = buildService();
  const record = await service.replace({
    tenantId: 'agency-a',
    cidrs: ['203.0.113.9', '198.51.100.0/24'],
    updatedBy: 'user-1',
    expectedVersion: 0,
  });

  assert.deepEqual(record.cidrs, ['198.51.100.0/24', '203.0.113.9/32']);
  assert.equal(record.version, 1);
  assert.deepEqual((await service.get('agency-a')).cidrs, record.cidrs);
});

test('rejects an invalid list without writing anything', async () => {
  const service = buildService();
  await assert.rejects(
    service.replace({ tenantId: 'agency-a', cidrs: ['10.0.0.1'], updatedBy: 'user-1', expectedVersion: 0 }),
    ValidationError,
  );
  assert.equal((await service.get('agency-a')).version, 0);
});

test('rejects a write against a stale version', async () => {
  const service = buildService();
  const write = () =>
    service.replace({ tenantId: 'agency-a', cidrs: ['203.0.113.9'], updatedBy: 'user-1', expectedVersion: 0 });

  await write();
  await assert.rejects(write(), VersionConflictError);
});
