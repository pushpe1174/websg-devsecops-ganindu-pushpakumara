import type { FastifyInstance } from 'fastify';
import type { Principal, TokenVerifier } from '../lib/jwt.ts';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

/**
 * Authenticates every request in the scope it is registered on. Register it
 * inside a route scope so public routes (health) stay outside it.
 *
 * There is no tenant in any path: a caller only ever addresses its own list, so
 * cross-tenant access is impossible rather than merely rejected.
 */
export function registerAuthentication(app: FastifyInstance, verify: TokenVerifier): void {
  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!token) return reply.code(401).send({ error: 'missing bearer token' });

    try {
      request.principal = await verify(token);
    } catch (err) {
      request.log.warn({ reason: (err as Error).message }, 'token rejected');
      return reply.code(401).send({ error: 'invalid token' });
    }
  });
}
