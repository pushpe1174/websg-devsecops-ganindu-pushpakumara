export const tenantParamsSchema = {
  type: 'object',
  required: ['tenantId'],
  properties: {
    tenantId: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9-]{1,62}$',
      description: 'Tenant identifier. Must match the tenant in the access token.',
      examples: ['agency-a'],
    },
  },
} as const;

export const replaceBodySchema = {
  type: 'object',
  required: ['cidrs'],
  additionalProperties: false,
  description: 'The complete allowlist. Any entry not included is removed.',
  properties: {
    cidrs: {
      type: 'array',
      // Structural cap only; the per-tenant policy cap lives in config.
      maxItems: 200,
      items: { type: 'string', minLength: 1, maxLength: 43 },
      description:
        'Public IPv4/IPv6 addresses or CIDRs. A bare address is widened to /32 or /128. ' +
        'Private, loopback, link-local and CGNAT ranges are rejected, as are ranges ' +
        'broader than /24 (IPv4) or /48 (IPv6).',
      examples: [['203.0.113.9', '198.51.100.0/24']],
    },
  },
} as const;

export const allowlistResponseSchema = {
  type: 'object',
  description: 'The stored allowlist. `version` is the value to send back as If-Match.',
  properties: {
    tenantId: { type: 'string', examples: ['agency-a'] },
    cidrs: { type: 'array', items: { type: 'string' }, examples: [['198.51.100.0/24']] },
    version: { type: 'integer', examples: [3] },
    updatedAt: { type: 'string', examples: ['2026-08-11T09:12:00.000Z'] },
    updatedBy: { type: 'string', examples: ['user-1'] },
    syncStatus: {
      type: 'string',
      enum: ['PENDING', 'APPLIED'],
      description:
        'PENDING - stored but not yet live in AWS WAF, normally for a few seconds. ' +
        'APPLIED - this exact version is confirmed live. Poll this endpoint after a ' +
        'write until it reads APPLIED.',
      examples: ['APPLIED'],
    },
    syncedVersion: {
      type: 'integer',
      description: 'The version currently live in WAF. Equals `version` once applied.',
      examples: [3],
    },
    syncedAt: {
      type: 'string',
      description: 'When that version reached WAF.',
      examples: ['2026-08-11T09:12:04.000Z'],
    },
  },
} as const;

export const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    reasons: {
      type: 'array',
      items: { type: 'string' },
      description: 'Present on validation failures: one entry per rejected value.',
    },
  },
} as const;

export type ReplaceBody = { cidrs: string[] };
export type TenantParams = { tenantId: string };
