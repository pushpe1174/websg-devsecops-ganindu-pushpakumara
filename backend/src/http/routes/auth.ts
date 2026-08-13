import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config/index.ts';
import { USERS, tenantOf } from '../../config/users.ts';
import { signToken } from '../../infra/tokens.ts';
import { loginSchema, userListSchema } from '../schemas.ts';

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

      const token = await signToken(config, userId, config.devLoginTtl);

      request.log.info({ userId, tenantId }, 'issued a token');
      return { token, userId, tenantId };
    });
  };
}
