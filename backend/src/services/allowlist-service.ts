import type { Config } from '../config/index.ts';
import {
  emptyAllowlist,
  toView,
  type AllowlistView,
  type Principal,
} from '../domain/allowlist.ts';
import { normalizeAllowlist } from '../domain/cidr.ts';
import type { AllowlistRepository, ServiceLogger, SyncNotifier } from '../domain/ports.ts';

export interface AllowlistService {
  get(principal: Principal): Promise<AllowlistView>;
  replace(input: {
    principal: Principal;
    cidrs: string[];
    expectedVersion: number;
  }): Promise<AllowlistView>;
}

export type ServiceDeps = {
  repository: AllowlistRepository;
  notifier: SyncNotifier;
  config: Config;
  logger?: ServiceLogger;
};

/** The rules of a write, with no HTTP and no AWS anywhere in sight. */
export function createAllowlistService({
  repository,
  notifier,
  config,
  logger,
}: ServiceDeps): AllowlistService {
  async function read({ userId, tenantId }: Principal): Promise<AllowlistView> {
    const record = await repository.get(tenantId, userId);
    return toView(tenantId, record ?? emptyAllowlist(userId));
  }

  return {
    get: read,

    async replace({ principal, cidrs, expectedVersion }) {
      const normalized = normalizeAllowlist(cidrs, config.policy);
      const written = await repository.put(
        principal.tenantId,
        { ownerId: principal.userId, cidrs: normalized },
        expectedVersion,
      );

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

      // Wait for the acknowledgement so the caller gets a definitive answer
      // rather than polling. If the window elapses the answer is just PENDING.
      const deadline = Date.now() + config.syncWaitMs;
      let current = toView(principal.tenantId, written);

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
