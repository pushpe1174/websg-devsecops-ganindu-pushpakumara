import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTestApp,
  createMemoryRepository,
  createMemoryTenantIpSetRepository,
  signToken,
} from '../helpers/index.ts';

const PATH = '/v1/admin/tenants/agency-c/ip-set';
const IP_SET_ID = 'a1b2c3d4-1111-2222-3333-444455556666';

const adminToken = () => signToken({ sub: 'ops-1', tenant_id: 'platform', scope: 'platform:admin' });
const tenantToken = () =>
  signToken({ sub: 'user-1', tenant_id: 'agency-c', scope: 'ip-allowlist:read ip-allowlist:write' });

const assignment = (tenantId: string, ipSetId: string, ipSetName: string) => ({
  tenantId,
  ipSetId,
  ipSetName,
  ipSetScope: 'REGIONAL' as const,
});

test('a tenant cannot read the IPSet mapping', async () => {
  // Not even their own: which IPSet backs them is platform information.
  const token = await tenantToken();
  const res = await buildTestApp().inject({
    method: 'GET',
    url: PATH,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 403);
});

test('a tenant cannot assign an IPSet', async () => {
  const token = await tenantToken();
  const res = await buildTestApp().inject({
    method: 'PUT',
    url: PATH,
    headers: { authorization: `Bearer ${token}` },
    payload: { ipSetId: IP_SET_ID, ipSetName: 'websg-cms-allowlist-agency-c' },
  });
  assert.equal(res.statusCode, 403);
});

test('an admin assigns a tenant its own IPSet', async () => {
  const tenantIpSets = createMemoryTenantIpSetRepository();
  const app = buildTestApp(createMemoryRepository(), tenantIpSets);
  const token = await adminToken();

  const res = await app.inject({
    method: 'PUT',
    url: PATH,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      ipSetId: IP_SET_ID,
      ipSetName: 'websg-cms-allowlist-agency-c',
      description: 'Agency C CMS',
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ipSetName, 'websg-cms-allowlist-agency-c');
  assert.equal(res.json().ipSetScope, 'REGIONAL');
  // Reassignment means the stored list is not live yet, and this is what puts
  // a message on the queue.
  assert.deepEqual(tenantIpSets.markedPending, ['agency-c']);
});

test('two tenants pointed at one IPSet share it', async () => {
  const tenantIpSets = createMemoryTenantIpSetRepository();
  const app = buildTestApp(createMemoryRepository(), tenantIpSets);
  const token = await adminToken();

  for (const tenantId of ['agency-a', 'agency-b']) {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/admin/tenants/${tenantId}/ip-set`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ipSetId: IP_SET_ID, ipSetName: 'websg-cms-allowlist-shared' },
    });
    assert.equal(res.statusCode, 200);
  }

  const list = await app.inject({
    method: 'GET',
    url: '/v1/admin/ip-set-assignments',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.deepEqual(
    list.json().map((a: { tenantId: string; ipSetId: string }) => [a.tenantId, a.ipSetId]),
    [
      ['agency-a', IP_SET_ID],
      ['agency-b', IP_SET_ID],
    ],
  );
});

test('rejects a malformed IPSet id', async () => {
  const token = await adminToken();
  const res = await buildTestApp().inject({
    method: 'PUT',
    url: PATH,
    headers: { authorization: `Bearer ${token}` },
    payload: { ipSetId: 'not-a-uuid', ipSetName: 'websg-cms-allowlist-agency-c' },
  });
  assert.equal(res.statusCode, 400);
});

test('rejects an unknown IPSet scope', async () => {
  const token = await adminToken();
  const res = await buildTestApp().inject({
    method: 'PUT',
    url: PATH,
    headers: { authorization: `Bearer ${token}` },
    payload: { ipSetId: IP_SET_ID, ipSetName: 'x', ipSetScope: 'GLOBAL' },
  });
  assert.equal(res.statusCode, 400);
});

test('returns 404 for a tenant with no assignment', async () => {
  const token = await adminToken();
  const res = await buildTestApp().inject({
    method: 'GET',
    url: PATH,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 404);
});

test('an admin detaches a tenant from its IPSet', async () => {
  const tenantIpSets = createMemoryTenantIpSetRepository([
    assignment('agency-c', IP_SET_ID, 'websg-cms-allowlist-agency-c'),
  ]);
  const app = buildTestApp(createMemoryRepository(), tenantIpSets);
  const token = await adminToken();

  const res = await app.inject({
    method: 'DELETE',
    url: PATH,
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.statusCode, 204);
  assert.deepEqual(await tenantIpSets.list(), []);
  assert.deepEqual(tenantIpSets.markedPending, ['agency-c']);
});

test('admin routes still require a token', async () => {
  const res = await buildTestApp().inject({ method: 'GET', url: '/v1/admin/ip-set-assignments' });
  assert.equal(res.statusCode, 401);
});
