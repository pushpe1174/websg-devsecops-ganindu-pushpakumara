const num = (value: string | undefined, fallback: number) => (value ? Number(value) : fallback);

export const config = {
  port: num(process.env.PORT, 3000),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  aws: {
    // One table for every tenant: PK = tenantId, SK = ownerId.
    tableName: process.env.TABLE_NAME ?? 'websg-cms-allowlist',
    // The API signals the sync worker itself; there is no change-capture hop.
    syncQueueUrl: process.env.SYNC_QUEUE_URL,
  },

  // How long a write waits for the worker to confirm the list is live in WAF
  // before answering PENDING. The write itself is already durable either way.
  syncWaitMs: num(process.env.SYNC_WAIT_MS, 15000),
  syncPollMs: num(process.env.SYNC_POLL_MS, 500),

  policy: {
    // Max CIDR entries per user. Keeps a tenant IPSet (10k hard limit) in bounds.
    maxEntries: num(process.env.MAX_ENTRIES, 50),
    // Reject ranges broader than this prefix length. IPv4 only - see lib/cidr.ts.
    minPrefixV4: num(process.env.MIN_PREFIX_V4, 24),
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    issuer: process.env.JWT_ISSUER ?? 'https://portal.websg.local',
    audience: process.env.JWT_AUDIENCE ?? 'websg-selfservice-api',
  },
};

export type Config = typeof config;

/** Fails fast at boot rather than on the first request. */
export function assertConfig(current: Config = config): void {
  if (!current.jwt.secret) throw new Error('Missing required configuration: JWT_SECRET');
  // Without it a write is still durable, but nothing tells the worker until the
  // 15-minute sweep - so treat a missing queue as misconfiguration, not a mode.
  if (!current.aws.syncQueueUrl) throw new Error('Missing required configuration: SYNC_QUEUE_URL');
}
