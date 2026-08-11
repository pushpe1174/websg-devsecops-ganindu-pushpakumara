import type { Config } from '../../config/index.ts';
import { normalizeAllowlist } from '../../lib/cidr.ts';
import type { Allowlist, AllowlistRepository } from './repository.ts';

/**
 * PENDING: stored, not yet applied to AWS WAF (normally a few seconds).
 * APPLIED: the sync worker has confirmed this exact version is live in WAF.
 */
export type SyncStatus = 'PENDING' | 'APPLIED';

export type AllowlistView = Allowlist & { syncStatus: SyncStatus };

export interface AllowlistService {
  get(tenantId: string): Promise<AllowlistView>;
  replace(input: {
    tenantId: string;
    cidrs: string[];
    updatedBy: string;
    expectedVersion: number;
  }): Promise<AllowlistView>;
}

/** Business rules, free of HTTP concerns so they can be unit tested directly. */
export function createAllowlistService(
  repository: AllowlistRepository,
  config: Config,
): AllowlistService {
  return {
    async get(tenantId) {
      const record = await repository.get(tenantId);
      if (record) return withSyncStatus(record);

      // Never-configured tenant: nothing is outstanding, so nothing is pending.
      return withSyncStatus({
        tenantId,
        cidrs: [],
        version: 0,
        updatedAt: '',
        updatedBy: '',
        syncedVersion: 0,
      });
    },

    async replace({ tenantId, cidrs, updatedBy, expectedVersion }) {
      // Throws ValidationError with a reason per rejected entry.
      const normalized = normalizeAllowlist(cidrs, config.policy);
      const record = await repository.put({ tenantId, cidrs: normalized, updatedBy }, expectedVersion);
      return withSyncStatus(record);
    },
  };
}

/**
 * Derived, never stored: the worker only records which version it applied, so
 * the status cannot disagree with the data it is computed from.
 */
export function withSyncStatus(record: Allowlist): AllowlistView {
  return {
    ...record,
    syncStatus: record.syncedVersion === record.version ? 'APPLIED' : 'PENDING',
  };
}
