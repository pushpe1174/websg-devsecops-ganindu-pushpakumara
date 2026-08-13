/** Every request and response shape the API validates against, in one place. */

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

export const userListSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        users: {
          type: 'array',
          items: {
            type: 'object',
            properties: { userId: { type: 'string' }, tenantId: { type: 'string' } },
          },
        },
      },
    },
  },
} as const;

export const loginSchema = {
  body: {
    type: 'object',
    required: ['userId'],
    additionalProperties: false,
    properties: { userId: { type: 'string', minLength: 1, maxLength: 64 } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        userId: { type: 'string' },
        tenantId: { type: 'string' },
      },
    },
    401: errorResponseSchema,
  },
} as const;

export const healthSchema = {
  response: { 200: { type: 'object', properties: { status: { type: 'string' } } } },
} as const;

export type ReplaceBody = { cidrs: string[] };
