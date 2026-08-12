import type { Config } from '../../config/index.ts';
import { normalizeAllowlist } from '../../lib/cidr.ts';
import type { Principal } from '../../lib/jwt.ts';
import type { SyncNotifier } from './notifier.ts';
import type { Allowlist, AllowlistRepository } from './repository.ts';

/**
 * PENDING: stored, not yet confirmed live in AWS WAF.
 * APPLIED: the sync worker has confirmed this exact version is live in WAF.
 */
export type SyncStatus = 'PENDING' | 'APPLIED';

export type AllowlistView = Allowlist & { tenantId: string; syncStatus: SyncStatus };

export interface AllowlistService {
  get(principal: Principal): Promise<AllowlistView>;
  replace(input: {
    principal: Principal;
    cidrs: string[];
    expectedVersion: number;
  }): Promise<AllowlistView>;
}

/** Just enough of a logger to record a lost signal; satisfied by Fastify's. */
export type ServiceLogger = { error(context: object, message: string): void };

export type ServiceDeps = {
  repository: AllowlistRepository;
  notifier: SyncNotifier;
  config: Config;
  logger?: ServiceLogger;
};

/** Business rules, free of HTTP concerns so they can be unit tested directly. */
export function createAllowlistService({
  repository,
  notifier,
  config,
  logger,
}: ServiceDeps): AllowlistService {
  async function read({ userId, tenantId }: Principal): Promise<AllowlistView> {
    const record = await repository.get(tenantId, userId);

    // Never-configured user: nothing outstanding, so nothing is pending.
    return view(
      tenantId,
      record ?? { ownerId: userId, cidrs: [], version: 0, updatedAt: '', syncedVersion: 0 },
    );
  }

  return {
    get: read,

    async replace({ principal, cidrs, expectedVersion }) {
      // Throws ValidationError with a reason per rejected entry.
      const normalized = normalizeAllowlist(cidrs, config.policy);
      const written = await repository.put(
        principal.tenantId,
        { ownerId: principal.userId, cidrs: normalized },
        expectedVersion,
      );

      // The write and the signal are not atomic, and the write is the one that
      // matters: it is durable, and the 15-minute sweep reconciles a tenant
      // whose message never arrived. So a failed send is logged and answered
      // PENDING rather than raised - the caller's edit is not lost, it is slow.
      try {
        await notifier.notify({
          tenantId: principal.tenantId,
          ownerId: principal.userId,
          version: written.version,
        });
      } catch (err) {
        logger?.error(
          { err, tenant: principal.tenantId, owner: principal.userId, version: written.version },
          'stored the allowlist but could not signal the sync worker; the sweep will pick it up',
        );
      }

      // Wait for the worker's acknowledgement so the caller gets a definitive
      // answer instead of having to poll. The write is durable regardless; if
      // the window elapses the answer is honestly PENDING.
      const deadline = Date.now() + config.syncWaitMs;
      let current = view(principal.tenantId, written);

      while (current.syncStatus === 'PENDING' && Date.now() < deadline) {
        await sleep(config.syncPollMs);
        current = await read(principal);
        // A newer write by the same user supersedes this one; stop waiting.
        if (current.version !== written.version) break;
      }

      return current;
    },
  };
}

/**
 * Derived, never stored: the worker only records which version it applied, so
 * the status cannot disagree with the data it is computed from.
 */
function view(tenantId: string, record: Allowlist): AllowlistView {
  return {
    ...record,
    tenantId,
    syncStatus: record.syncedVersion === record.version ? 'APPLIED' : 'PENDING',
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
