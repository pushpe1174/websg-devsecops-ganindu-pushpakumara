import { normalizeAllowlist } from './cidr.ts';
import type { Config } from '../config.ts';

/** Who is calling and which tenant they own, resolved once at the edge. */
export type Principal = { userId: string; tenantId: string };

export type Allowlist = {
  ownerId: string;
  cidrs: string[];
  version: number;
  updatedAt: string;
  syncedVersion?: number;
  syncedAt?: string;
};

/** PENDING: stored. APPLIED: the worker confirmed this version is live in WAF. */
export type SyncStatus = 'PENDING' | 'APPLIED';
export type AllowlistView = Allowlist & { tenantId: string; syncStatus: SyncStatus };

export type SyncSignal = { tenantId: string; ownerId: string; version: number };

/** The two ports the service needs; aws.ts holds the real implementations. */
export type AllowlistRepository = {
  get(tenantId: string, ownerId: string): Promise<Allowlist | null>;
  put(
    tenantId: string,
    draft: { ownerId: string; cidrs: string[] },
    expectedVersion: number,
  ): Promise<Allowlist>;
};

export type SyncNotifier = { notify(signal: SyncSignal): Promise<void> };

export type ServiceDeps = {
  repository: AllowlistRepository;
  notifier: SyncNotifier;
  config: Config;
  logger?: { error(context: object, message: string): void };
};

export type AllowlistService = ReturnType<typeof createAllowlistService>;

export function createAllowlistService({ repository, notifier, config, logger }: ServiceDeps) {
  async function get({ userId, tenantId }: Principal): Promise<AllowlistView> {
    const record = await repository.get(tenantId, userId);
    return view(
      tenantId,
      record ?? { ownerId: userId, cidrs: [], version: 0, updatedAt: '', syncedVersion: 0 },
    );
  }

  async function replace(input: {
    principal: Principal;
    cidrs: string[];
    expectedVersion: number;
  }): Promise<AllowlistView> {
    const { principal, expectedVersion } = input;
    const cidrs = normalizeAllowlist(input.cidrs, config.policy);
    const written = await repository.put(principal.tenantId, { ownerId: principal.userId, cidrs }, expectedVersion);

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
      current = await get(principal);
      // A newer write by the same user supersedes this one; stop waiting.
      if (current.version !== written.version) break;
    }

    return current;
  }

  return { get, replace };
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
