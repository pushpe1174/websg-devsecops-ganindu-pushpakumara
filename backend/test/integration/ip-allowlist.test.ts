import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTestApp,
  createMemoryNotifier,
  createMemoryRepository,
  signToken,
} from '../helpers/index.ts';

const PATH = '/v1/allowlist';

const call = async (
  userId: string,
  options: { method?: 'GET' | 'PUT'; payload?: unknown; ifMatch?: string } = {},
  app = buildTestApp(),
) => {
  const token = await signToken(userId);
  return app.inject({
    method: options.method ?? 'GET',
    url: PATH,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.ifMatch === undefined ? {} : { 'if-match': options.ifMatch }),
    },
    payload: options.payload as never,
  });
};

test('health probe needs no token', async () => {
  const res = await buildTestApp().inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
});

test('rejects a request without a token', async () => {
  const res = await buildTestApp().inject({ method: 'GET', url: PATH });
  assert.equal(res.statusCode, 401);
});

test('rejects a token signed with the wrong key', async () => {
  const res = await buildTestApp().inject({
    method: 'GET',
    url: PATH,
    headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.bad-signature' },
  });
  assert.equal(res.statusCode, 401);
});

test('rejects a user who is not in the directory', async () => {
  const res = await call('user-unknown');
  assert.equal(res.statusCode, 401);
});

test('resolves the tenant from the directory, not from the caller', async () => {
  // user-a -> tenant-a, user-c and user-d -> tenant-shared.
  assert.equal((await call('user-a')).json().tenantId, 'tenant-a');
  assert.equal((await call('user-c')).json().tenantId, 'tenant-shared');
  assert.equal((await call('user-d')).json().tenantId, 'tenant-shared');
});

test('returns an empty allowlist at version 0 for a new user', async () => {
  const res = await call('user-a');

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    ownerId: 'user-a',
    tenantId: 'tenant-a',
    cidrs: [],
    version: 0,
    updatedAt: '',
    syncedVersion: 0,
    syncStatus: 'APPLIED',
  });
});

test('stores a normalised allowlist against the caller', async () => {
  const res = await call('user-a', {
    method: 'PUT',
    ifMatch: '0',
    payload: { cidrs: ['203.0.113.9', '198.51.100.0/24', '203.0.113.9'] },
  });

  // 202: stored and durable, but WAF has not acknowledged it yet.
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.json().cidrs, ['198.51.100.0/24', '203.0.113.9/32']);
  assert.equal(res.json().version, 1);
  assert.equal(res.json().ownerId, 'user-a');
  assert.equal(res.json().syncStatus, 'PENDING');
  assert.equal(res.headers.etag, '1');
});

test('a write signals the sync worker with the tenant resolved from the token', async () => {
  const notifier = createMemoryNotifier();
  const app = buildTestApp(createMemoryRepository(), notifier);

  // user-c is in tenant-shared per the directory; the caller never supplies it.
  await call('user-c', { method: 'PUT', ifMatch: '0', payload: { cidrs: ['203.0.113.9'] } }, app);

  assert.deepEqual(notifier.sent, [
    { tenantId: 'tenant-shared', ownerId: 'user-c', version: 1 },
  ]);
});

test('a rejected write signals nothing', async () => {
  const notifier = createMemoryNotifier();
  const app = buildTestApp(createMemoryRepository(), notifier);

  await call('user-a', { method: 'PUT', ifMatch: '0', payload: { cidrs: ['10.0.0.1'] } }, app);
  await call('user-a', { method: 'PUT', payload: { cidrs: ['203.0.113.9'] } }, app); // no If-Match

  assert.deepEqual(notifier.sent, []);
});

test('a user only ever writes its own list', async () => {
  const repository = createMemoryRepository();
  const app = buildTestApp(repository);

  await call('user-a', { method: 'PUT', ifMatch: '0', payload: { cidrs: ['203.0.113.9'] } }, app);

  // Same request from user-b lands in tenant-b's table, untouched by user-a.
  assert.deepEqual((await call('user-b', {}, app)).json().cidrs, []);
  assert.deepEqual(
    (await repository.get('tenant-a', 'user-a'))?.cidrs,
    ['203.0.113.9/32'],
  );
  assert.equal(await repository.get('tenant-b', 'user-a'), null);
});

test('users sharing a tenant keep separate lists in one table', async () => {
  const repository = createMemoryRepository();
  const app = buildTestApp(repository);

  await call('user-c', { method: 'PUT', ifMatch: '0', payload: { cidrs: ['203.0.113.9'] } }, app);
  await call('user-d', { method: 'PUT', ifMatch: '0', payload: { cidrs: ['198.51.100.7'] } }, app);

  // The worker applies the union of the two to the shared IPSet.
  assert.deepEqual((await repository.get('tenant-shared', 'user-c'))?.cidrs, ['203.0.113.9/32']);
  assert.deepEqual((await repository.get('tenant-shared', 'user-d'))?.cidrs, ['198.51.100.7/32']);
});

test('rejects invalid addresses with per-entry reasons', async () => {
  const res = await call('user-a', { method: 'PUT', ifMatch: '0', payload: { cidrs: ['10.0.0.1'] } });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().reasons.length, 1);
});

test('rejects a body that does not match the schema', async () => {
  const res = await call('user-a', {
    method: 'PUT',
    ifMatch: '0',
    payload: { cidrs: 'not-an-array' },
  });
  assert.equal(res.statusCode, 400);
});

test('requires If-Match to prevent lost updates', async () => {
  const res = await call('user-a', { method: 'PUT', payload: { cidrs: ['203.0.113.9'] } });
  assert.equal(res.statusCode, 428);
});

test('returns 409 when If-Match is stale', async () => {
  const app = buildTestApp();
  const write = (version: string) =>
    call('user-a', { method: 'PUT', ifMatch: version, payload: { cidrs: ['203.0.113.9'] } }, app);

  assert.equal((await write('0')).statusCode, 202);
  assert.equal((await write('0')).statusCode, 409);
});

test('returns 200 APPLIED once the worker has acknowledged that version', async () => {
  const app = buildTestApp(
    createMemoryRepository([
      {
        tenantId: 'tenant-a',
        ownerId: 'user-a',
        cidrs: ['198.51.100.0/24'],
        version: 3,
        updatedAt: '2026-08-11T09:12:00.000Z',
        syncedVersion: 3,
        syncedAt: '2026-08-11T09:12:04.000Z',
      },
    ]),
  );

  const res = await call('user-a', {}, app);
  assert.equal(res.json().syncStatus, 'APPLIED');
});

test('reports PENDING when the stored version is ahead of the applied one', async () => {
  const app = buildTestApp(
    createMemoryRepository([
      {
        tenantId: 'tenant-a',
        ownerId: 'user-a',
        cidrs: ['198.51.100.0/24'],
        version: 4,
        updatedAt: '2026-08-11T09:12:00.000Z',
        syncedVersion: 3,
        syncedAt: '2026-08-11T09:12:04.000Z',
      },
    ]),
  );

  const res = await call('user-a', {}, app);
  assert.equal(res.json().syncStatus, 'PENDING');
});

test('returns 404 for an unknown route', async () => {
  const token = await signToken('user-a');
  const res = await buildTestApp().inject({
    method: 'GET',
    url: '/v1/unknown',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 404);
});
