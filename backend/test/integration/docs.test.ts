import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.ts';
import { createVerifier } from '../../src/lib/jwt.ts';
import {
  createMemoryRepository,
  createMemoryTenantIpSetRepository,
  testConfig,
} from '../helpers/index.ts';

const buildDocsApp = (docsEnabled: boolean) =>
  buildApp({
    repository: createMemoryRepository(),
    tenantIpSets: createMemoryTenantIpSetRepository(),
    verify: createVerifier(testConfig),
    config: { ...testConfig, docsEnabled },
    logger: false,
  });

test('publishes an OpenAPI document covering both allowlist operations', async () => {
  const res = await buildDocsApp(true).inject({ method: 'GET', url: '/docs/json' });
  assert.equal(res.statusCode, 200);

  const spec = res.json();
  const path = spec.paths['/v1/tenants/{tenantId}/ip-allowlist'];
  assert.ok(path.get, 'GET should be documented');
  assert.ok(path.put, 'PUT should be documented');
  assert.deepEqual(path.put.security, [{ bearerAuth: [] }]);
  assert.ok(path.put.responses['409'], 'the conflict response should be documented');
  assert.ok(spec.components.securitySchemes.bearerAuth);
});

test('serves Swagger UI at /docs', async () => {
  const res = await buildDocsApp(true).inject({ method: 'GET', url: '/docs' });
  assert.ok([200, 302].includes(res.statusCode), `unexpected status ${res.statusCode}`);
});

test('does not expose docs when disabled', async () => {
  const res = await buildDocsApp(false).inject({ method: 'GET', url: '/docs/json' });
  assert.equal(res.statusCode, 404);
});
