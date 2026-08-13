/**
 * What the service needs from the outside world, stated without naming a
 * vendor. `infra/` supplies the real ones; the tests supply fakes.
 */
import type { Allowlist, AllowlistDraft, Principal, SyncSignal } from './allowlist.ts';

export interface AllowlistRepository {
  get(tenantId: string, ownerId: string): Promise<Allowlist | null>;
  put(tenantId: string, draft: AllowlistDraft, expectedVersion: number): Promise<Allowlist>;
}

export interface SyncNotifier {
  notify(signal: SyncSignal): Promise<void>;
}

export type TokenVerifier = (token: string) => Promise<Principal>;

export type ServiceLogger = { error(context: object, message: string): void };
