/** The vocabulary of the feature: who is asking, what is stored, what is shown. */

export type Principal = { userId: string; tenantId: string };

export type Allowlist = {
  ownerId: string;
  cidrs: string[];
  version: number;
  updatedAt: string;
  syncedVersion?: number;
  syncedAt?: string;
};

export type AllowlistDraft = { ownerId: string; cidrs: string[] };

/** PENDING: stored. APPLIED: the worker confirmed this version is live in WAF. */
export type SyncStatus = 'PENDING' | 'APPLIED';

export type AllowlistView = Allowlist & { tenantId: string; syncStatus: SyncStatus };

/** What the sync worker needs to bring one owner's list to the edge. */
export type SyncSignal = { tenantId: string; ownerId: string; version: number };

/** A user who has never written a list still has one; it is just empty. */
export const emptyAllowlist = (ownerId: string): Allowlist => ({
  ownerId,
  cidrs: [],
  version: 0,
  updatedAt: '',
  syncedVersion: 0,
});

/** Derived, never stored, so the status cannot drift from the data behind it. */
export const toView = (tenantId: string, record: Allowlist): AllowlistView => ({
  ...record,
  tenantId,
  syncStatus: record.syncedVersion === record.version ? 'APPLIED' : 'PENDING',
});
