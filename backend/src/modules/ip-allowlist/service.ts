import type { Config } from '../../config/index.ts';
import { normalizeAllowlist } from '../../lib/cidr.ts';
import type { Principal } from '../../lib/jwt.ts';
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

/** Business rules, free of HTTP concerns so they can be unit tested directly. */
export function createAllowlistService(
  repository: AllowlistRepository,
  config: Config,
): AllowlistService {
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
