import type { Config } from '../../config/index.ts';
import { normalizeAllowlist } from '../../lib/cidr.ts';
import type { Principal } from '../../lib/jwt.ts';
import type { SyncNotifier } from './notifier.ts';
import type { Allowlist, AllowlistRepository } from './repository.ts';

/** PENDING: stored. APPLIED: the worker confirmed this version is live in WAF. */
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

export type ServiceLogger = { error(context: object, message: string): void };

export type ServiceDeps = {
  repository: AllowlistRepository;
  notifier: SyncNotifier;
  config: Config;
  logger?: ServiceLogger;
};

export function createAllowlistService({
  repository,
  notifier,
  config,
  logger,
}: ServiceDeps): AllowlistService {
  async function read({ userId, tenantId }: Principal): Promise<AllowlistView> {
    const record = await repository.get(tenantId, userId);
    return view(
      tenantId,
      record ?? { ownerId: userId, cidrs: [], version: 0, updatedAt: '', syncedVersion: 0 },
    );
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

/** Derived, never stored, so the status cannot drift from the data behind it. */
function view(tenantId: string, record: Allowlist): AllowlistView {
  return {
    ...record,
    tenantId,
    syncStatus: record.syncedVersion === record.version ? 'APPLIED' : 'PENDING',
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
