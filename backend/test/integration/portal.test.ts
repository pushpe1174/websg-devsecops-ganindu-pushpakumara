import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTestApp, testConfig } from '../helpers/index.ts';

const PATH = '/v1/allowlist';
const ORIGIN = testConfig.corsOrigins[0];

test('answers a preflight from the portal origin', async () => {
  const res = await buildTestApp().inject({
    method: 'OPTIONS',
    url: PATH,
    headers: {
      origin: ORIGIN,
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'authorization,if-match,content-type',
    },
  });

  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
  assert.match(String(res.headers['access-control-allow-methods']), /PUT/);
  assert.match(String(res.headers['access-control-allow-headers']).toLowerCase(), /if-match/);
});

test('does not echo an origin that is not configured', async () => {
  const res = await buildTestApp().inject({
    method: 'GET',
    url: '/healthz',
    headers: { origin: 'https://evil.example' },
  });

  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('a rejected request still carries the CORS headers so the portal can read it', async () => {
  const res = await buildTestApp().inject({
    method: 'GET',
    url: PATH,
    headers: { origin: ORIGIN },
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
});

test('login issues a token the API accepts', async () => {
  const app = buildTestApp();
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { userId: 'user-a' },
  });

  assert.equal(login.statusCode, 200);
  assert.equal(login.json().tenantId, 'tenant-a');

  const res = await app.inject({
    method: 'GET',
    url: PATH,
    headers: { authorization: `Bearer ${login.json().token}` },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().tenantId, 'tenant-a');
});

test('login refuses a user who is not in the directory', async () => {
  const res = await buildTestApp().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { userId: 'user-zzz' },
  });

  assert.equal(res.statusCode, 401);
});
