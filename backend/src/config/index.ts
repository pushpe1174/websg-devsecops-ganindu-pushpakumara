const num = (value: string | undefined, fallback: number) => (value ? Number(value) : fallback);

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 3000),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  aws: {
    tableName: process.env.TABLE_NAME ?? 'websg-cms-ip-allowlist',
    // Tenant -> WAF IPSet mapping, also read by the sync worker.
    configTableName: process.env.CONFIG_TABLE_NAME ?? 'websg-cms-ip-allowlist-tenants',
  },

  // Swagger UI at /docs. Off in production unless explicitly enabled - an
  // internal API has no reason to ship an interactive console to the internet.
  docsEnabled: process.env.DOCS_ENABLED
    ? process.env.DOCS_ENABLED === 'true'
    : process.env.NODE_ENV !== 'production',

  policy: {
    // Max CIDR entries a single tenant may hold. Keeps the shared WAF IPSet
    // (10k address hard limit) well within bounds across all tenants.
    maxEntries: num(process.env.MAX_ENTRIES, 50),
    // Reject ranges broader than these prefix lengths - a tenant should not be
    // able to open the CMS to a /8.
    minPrefixV4: num(process.env.MIN_PREFIX_V4, 24),
    minPrefixV6: num(process.env.MIN_PREFIX_V6, 48),
  },

  jwt: {
    // Production: Cognito user pool JWKS. Local/tests: shared HS256 secret.
    jwksUrl: process.env.JWT_JWKS_URL,
    secret: process.env.JWT_SECRET,
    issuer: process.env.JWT_ISSUER ?? 'https://portal.websg.local',
    audience: process.env.JWT_AUDIENCE ?? 'websg-selfservice-api',
  },
};

export type Config = typeof config;

/** Fails fast at boot rather than on the first request. */
export function assertProductionConfig(current: Config = config): void {
  const missing: string[] = [];

  if (!current.jwt.jwksUrl && !current.jwt.secret) missing.push('JWT_JWKS_URL or JWT_SECRET');
  if (!current.aws.tableName) missing.push('TABLE_NAME');
  if (current.env === 'production' && !current.jwt.jwksUrl) {
    missing.push('JWT_JWKS_URL (the HS256 secret fallback is for local use only)');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
}
