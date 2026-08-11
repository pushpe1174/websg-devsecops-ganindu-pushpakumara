import { SignJWT } from 'jose';
import { buildApp } from '../../src/app.ts';
import { config } from '../../src/config/index.ts';
import { createVerifier } from '../../src/lib/jwt.ts';
import { VersionConflictError } from '../../src/lib/errors.ts';
import type { Allowlist, AllowlistRepository } from '../../src/modules/ip-allowlist/repository.ts';

export const testConfig = {
  ...config,
  jwt: { ...config.jwt, secret: 'test-secret-value-for-hs256-signing' },
  // Tests drive the acknowledgement themselves; no real worker to wait for.
  syncWaitMs: 0,
  syncPollMs: 1,
};

const secret = new TextEncoder().encode(testConfig.jwt.secret);

export function signToken(userId: string) {
  return new SignJWT()
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(testConfig.jwt.issuer)
    .setAudience(testConfig.jwt.audience)
    .setExpirationTime('5m')
    .sign(secret);
}

export type SeedItem = Allowlist & { tenantId: string };

/**
 * In-memory stand-in for the per-tenant tables, with the same optimistic-locking
 * contract as DynamoDB. Keyed by table, so a write to one tenant cannot be read
 * from another.
 */
export function createMemoryRepository(seed: SeedItem[] = []): AllowlistRepository {
  const tables = new Map<string, Map<string, Allowlist>>();

  const tableOf = (tenantId: string) => {
    const table = tables.get(tenantId) ?? new Map<string, Allowlist>();
    tables.set(tenantId, table);
    return table;
  };

  for (const { tenantId, ...item } of seed) tableOf(tenantId).set(item.ownerId, item);

  return {
    async get(tenantId, ownerId) {
      return tableOf(tenantId).get(ownerId) ?? null;
    },
    async put(tenantId, draft, expectedVersion) {
      const table = tableOf(tenantId);
      if ((table.get(draft.ownerId)?.version ?? 0) !== expectedVersion) {
        throw new VersionConflictError();
      }
      const item: Allowlist = {
        ...draft,
        version: expectedVersion + 1,
        updatedAt: new Date().toISOString(),
      };
      table.set(draft.ownerId, item);
      return item;
    },
  };
}

export function buildTestApp(repository: AllowlistRepository = createMemoryRepository()) {
  return buildApp({
    repository,
    verify: createVerifier(testConfig),
    config: testConfig,
    logger: false,
  });
}
