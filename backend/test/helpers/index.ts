import { SignJWT } from 'jose';
import { buildApp } from '../../src/app.ts';
import { config } from '../../src/config/index.ts';
import { createVerifier } from '../../src/lib/jwt.ts';
import { VersionConflictError } from '../../src/lib/errors.ts';
import type { Allowlist, AllowlistRepository } from '../../src/modules/ip-allowlist/repository.ts';
import type { SyncNotifier, SyncSignal } from '../../src/modules/ip-allowlist/notifier.ts';

export const testConfig = {
  ...config,
  aws: { ...config.aws, syncQueueUrl: 'https://sqs.test.local/queue.fifo' },
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
 * In-memory stand-in for the allowlist table, with the same optimistic-locking
 * contract as DynamoDB. Keyed by tenant then owner, mirroring PK/SK, so a write
 * to one tenant's partition cannot be read from another's.
 */
export function createMemoryRepository(seed: SeedItem[] = []): AllowlistRepository {
  const partitions = new Map<string, Map<string, Allowlist>>();

  const partitionOf = (tenantId: string) => {
    const partition = partitions.get(tenantId) ?? new Map<string, Allowlist>();
    partitions.set(tenantId, partition);
    return partition;
  };

  for (const { tenantId, ...item } of seed) partitionOf(tenantId).set(item.ownerId, item);

  return {
    async get(tenantId, ownerId) {
      return partitionOf(tenantId).get(ownerId) ?? null;
    },
    async put(tenantId, draft, expectedVersion) {
      const partition = partitionOf(tenantId);
      if ((partition.get(draft.ownerId)?.version ?? 0) !== expectedVersion) {
        throw new VersionConflictError();
      }
      const item: Allowlist = {
        ...draft,
        version: expectedVersion + 1,
        updatedAt: new Date().toISOString(),
      };
      partition.set(draft.ownerId, item);
      return item;
    },
  };
}

export type MemoryNotifier = SyncNotifier & { sent: SyncSignal[] };

/** Records what the API would have put on the queue. */
export function createMemoryNotifier(options: { fail?: boolean } = {}): MemoryNotifier {
  const sent: SyncSignal[] = [];

  return {
    sent,
    async notify(signal) {
      if (options.fail) throw new Error('SQS unavailable');
      sent.push(signal);
    },
  };
}

export function buildTestApp(
  repository: AllowlistRepository = createMemoryRepository(),
  notifier: SyncNotifier = createMemoryNotifier(),
) {
  return buildApp({
    repository,
    notifier,
    verify: createVerifier(testConfig),
    config: testConfig,
    logger: false,
  });
}
