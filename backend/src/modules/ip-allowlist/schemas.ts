export const replaceBodySchema = {
  type: 'object',
  required: ['cidrs'],
  additionalProperties: false,
  properties: {
    cidrs: {
      type: 'array',
      maxItems: 200,
      items: { type: 'string', minLength: 1, maxLength: 43 },
    },
  },
} as const;

export const allowlistResponseSchema = {
  type: 'object',
  properties: {
    ownerId: { type: 'string' },
    tenantId: { type: 'string' },
    cidrs: { type: 'array', items: { type: 'string' } },
    version: { type: 'integer' },
    updatedAt: { type: 'string' },
    syncStatus: { type: 'string', enum: ['PENDING', 'APPLIED'] },
    syncedVersion: { type: 'integer' },
    syncedAt: { type: 'string' },
  },
} as const;

export const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    reasons: { type: 'array', items: { type: 'string' } },
  },
} as const;

export type ReplaceBody = { cidrs: string[] };
