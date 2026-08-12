import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import type { Config } from '../config/index.ts';
import { USERS, tenantOf } from '../config/users.ts';

const userListSchema = {
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

const loginSchema = {
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
    401: { type: 'object', properties: { error: { type: 'string' } } },
  },
} as const;

/** Password-less sign-in for the portal, standing in for the real IdP. */
export function authRoutes(config: Config) {
  return async function routes(app: FastifyInstance) {
    app.get('/auth/users', { schema: userListSchema }, async () => ({
      users: Object.entries(USERS).map(([userId, tenantId]) => ({ userId, tenantId })),
    }));

    app.post('/auth/login', { schema: loginSchema }, async (request, reply) => {
      const { userId } = request.body as { userId: string };
      const tenantId = tenantOf(userId);

      if (!tenantId) return reply.code(401).send({ error: 'unknown user' });

      const token = await new SignJWT()
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuer(config.jwt.issuer)
        .setAudience(config.jwt.audience)
        .setIssuedAt()
        .setExpirationTime(config.devLoginTtl)
        .sign(new TextEncoder().encode(config.jwt.secret!));

      request.log.info({ userId, tenantId }, 'issued a token');
      return { token, userId, tenantId };
    });
  };
}
