import { SignJWT } from 'jose';
import { buildApp } from '../../src/app.ts';
import { config } from '../../src/config/index.ts';
import { createVerifier } from '../../src/lib/jwt.ts';
import { VersionConflictError } from '../../src/lib/errors.ts';
import type { Allowlist, AllowlistRepository } from '../../src/modules/ip-allowlist/repository.ts';
import type { TenantIpSet, TenantIpSetRepository } from '../../src/modules/tenant-ipset/repository.ts';

export const testConfig = {
  ...config,
  jwt: { ...config.jwt, jwksUrl: undefined, secret: 'test-secret-value-for-hs256-signing' },
};

const secret = new TextEncoder().encode(testConfig.jwt.secret);

export function signToken(claims: { sub: string; tenant_id?: string; scope?: string }) {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(testConfig.jwt.issuer)
    .setAudience(testConfig.jwt.audience)
    .setExpirationTime('5m')
    .sign(secret);
}

/** In-memory repository with the same optimistic-locking contract as DynamoDB. */
export function createMemoryRepository(seed: Allowlist[] = []): AllowlistRepository {
  const items = new Map(seed.map((item) => [item.tenantId, item]));

  return {
    async get(tenantId) {
      return items.get(tenantId) ?? null;
    },
    async put(draft, expectedVersion) {
      if ((items.get(draft.tenantId)?.version ?? 0) !== expectedVersion) {
        throw new VersionConflictError();
      }
      const item: Allowlist = {
        ...draft,
        version: expectedVersion + 1,
        updatedAt: new Date().toISOString(),
      };
      items.set(draft.tenantId, item);
      return item;
    },
  };
}

/** In-memory tenant -> IPSet mapping, with the markPending side effect. */
export function createMemoryTenantIpSetRepository(seed: TenantIpSet[] = []) {
  const items = new Map(seed.map((item) => [item.tenantId, item]));
  const markedPending: string[] = [];

  const repository: TenantIpSetRepository & { markedPending: string[] } = {
    markedPending,
    async get(tenantId) {
      return items.get(tenantId) ?? null;
    },
    async list() {
      return [...items.values()].sort((a, b) => a.tenantId.localeCompare(b.tenantId));
    },
    async put(assignment) {
      items.set(assignment.tenantId, assignment);
      return assignment;
    },
    async remove(tenantId) {
      items.delete(tenantId);
    },
    async markPending(tenantId) {
      markedPending.push(tenantId);
    },
  };

  return repository;
}

export function buildTestApp(
  repository: AllowlistRepository = createMemoryRepository(),
  tenantIpSets: TenantIpSetRepository = createMemoryTenantIpSetRepository(),
) {
  return buildApp({
    repository,
    tenantIpSets,
    verify: createVerifier(testConfig),
    config: testConfig,
    logger: false,
  });
}
