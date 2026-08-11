import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTestApp, createMemoryRepository, signToken } from '../helpers/index.ts';

const PATH = '/v1/tenants/agency-a/ip-allowlist';

const tenantToken = () =>
  signToken({ sub: 'user-1', tenant_id: 'agency-a', scope: 'ip-allowlist:read ip-allowlist:write' });

const adminToken = () => signToken({ sub: 'ops-1', tenant_id: 'platform', scope: 'platform:admin' });

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

test('rejects access to another tenant', async () => {
  const token = await signToken({ sub: 'user-2', tenant_id: 'agency-b', scope: 'ip-allowlist:read' });
  const res = await buildTestApp().inject({
    method: 'GET',
    url: PATH,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 403);
});

test('rejects a token missing the write scope', async () => {
  const token = await signToken({ sub: 'user-1', tenant_id: 'agency-a', scope: 'ip-allowlist:read' });
  const res = await buildTestApp().inject({
    method: 'PUT',
    url: PATH,
    headers: { authorization: `Bearer ${token}`, 'if-match': '0' },
    payload: { cidrs: ['203.0.113.9'] },
  });
  assert.equal(res.statusCode, 403);
});

test('allows a platform admin to read any tenant', async () => {
  const token = await adminToken();
  const res = await buildTestApp().inject({
    method: 'GET',
    url: PATH,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
});

test('returns an empty allowlist at version 0 for a new tenant', async () => {
  const token = await tenantToken();
  const res = await buildTestApp().inject({
    method: 'GET',
    url: PATH,
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    tenantId: 'agency-a',
    cidrs: [],
    version: 0,
    updatedAt: '',
    updatedBy: '',
    syncedVersion: 0,
    syncStatus: 'APPLIED',
  });
});

test('stores a normalised allowlist and records the caller', async () => {
  const app = buildTestApp();
  const token = await tenantToken();

  const res = await app.inject({
    method: 'PUT',
    url: PATH,
    headers: { authorization: `Bearer ${token}`, 'if-match': '0' },
    payload: { cidrs: ['203.0.113.9', '198.51.100.0/24', '203.0.113.9'] },
  });

  // 202, not 200: stored and durable, but not yet live in WAF.
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.json().cidrs, ['198.51.100.0/24', '203.0.113.9/32']);
  assert.equal(res.json().version, 1);
  assert.equal(res.json().updatedBy, 'user-1');
  assert.equal(res.json().syncStatus, 'PENDING');
  assert.equal(res.headers.etag, '1');
});

test('rejects invalid addresses with per-entry reasons', async () => {
  const token = await tenantToken();
  const res = await buildTestApp().inject({
    method: 'PUT',
    url: PATH,
    headers: { authorization: `Bearer ${token}`, 'if-match': '0' },
    payload: { cidrs: ['10.0.0.1'] },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().reasons.length, 1);
});

test('rejects a body that does not match the schema', async () => {
  const token = await tenantToken();
  const res = await buildTestApp().inject({
    method: 'PUT',
    url: PATH,
    headers: { authorization: `Bearer ${token}`, 'if-match': '0' },
    payload: { cidrs: 'not-an-array' },
  });
  assert.equal(res.statusCode, 400);
});

test('requires If-Match to prevent lost updates', async () => {
  const token = await tenantToken();
  const res = await buildTestApp().inject({
    method: 'PUT',
    url: PATH,
    headers: { authorization: `Bearer ${token}` },
    payload: { cidrs: ['203.0.113.9'] },
  });
  assert.equal(res.statusCode, 428);
});

test('returns 409 when If-Match is stale', async () => {
  const app = buildTestApp();
  const token = await tenantToken();
  const write = (version: string) =>
    app.inject({
      method: 'PUT',
      url: PATH,
      headers: { authorization: `Bearer ${token}`, 'if-match': version },
      payload: { cidrs: ['203.0.113.9'] },
    });

  assert.equal((await write('0')).statusCode, 202);
  assert.equal((await write('0')).statusCode, 409);
});

test('rejects a tenant id that does not match the expected format', async () => {
  const token = await adminToken();
  const res = await buildTestApp().inject({
    method: 'GET',
    url: '/v1/tenants/..%2Fadmin/ip-allowlist',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 400);
});

test('reports APPLIED once the worker has acknowledged that version', async () => {
  const app = buildTestApp(
    createMemoryRepository([
      {
        tenantId: 'agency-a',
        cidrs: ['198.51.100.0/24'],
        version: 3,
        updatedAt: '2026-08-11T09:12:00.000Z',
        updatedBy: 'user-1',
        syncedVersion: 3,
        syncedAt: '2026-08-11T09:12:04.000Z',
      },
    ]),
  );
  const token = await tenantToken();

  const res = await app.inject({ method: 'GET', url: PATH, headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.json().syncStatus, 'APPLIED');
});

test('reports PENDING when the stored version is ahead of the applied one', async () => {
  const app = buildTestApp(
    createMemoryRepository([
      {
        tenantId: 'agency-a',
        cidrs: ['198.51.100.0/24'],
        version: 4,
        updatedAt: '2026-08-11T09:12:00.000Z',
        updatedBy: 'user-1',
        syncedVersion: 3,
        syncedAt: '2026-08-11T09:12:04.000Z',
      },
    ]),
  );
  const token = await tenantToken();

  const res = await app.inject({ method: 'GET', url: PATH, headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.json().syncStatus, 'PENDING');
});

test('returns 404 for an unknown route', async () => {
  const token = await tenantToken();
  const res = await buildTestApp().inject({
    method: 'GET',
    url: '/v1/tenants/agency-a/unknown',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 404);
});
