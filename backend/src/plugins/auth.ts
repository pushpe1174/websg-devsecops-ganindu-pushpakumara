import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ForbiddenError } from '../lib/errors.ts';
import type { Principal, TokenVerifier } from '../lib/jwt.ts';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

/**
 * Authenticates every request in the scope it is registered on. Register it
 * inside a route scope - Fastify encapsulation keeps public routes (health)
 * outside it.
 */
export function registerAuthentication(app: FastifyInstance, verify: TokenVerifier): void {
  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!token) {
      return reply.code(401).send({ error: 'missing bearer token' });
    }

    try {
      request.principal = await verify(token);
    } catch (err) {
      request.log.warn({ reason: (err as Error).message }, 'token rejected');
      return reply.code(401).send({ error: 'invalid token' });
    }
  });
}

/**
 * Authorises the caller for the tenant in the path: the token must carry the
 * required scope and belong to that tenant. Platform admins (ops team) may act
 * on any tenant.
 */
export function authorizeTenant(
  request: FastifyRequest,
  requiredScope: string,
): string {
  const { tenantId } = request.params as { tenantId: string };
  const { principal } = request;

  if (principal.isPlatformAdmin) return tenantId;

  if (!principal.scopes.includes(requiredScope)) {
    request.log.warn({ subject: principal.subject, requiredScope }, 'missing scope');
    throw new ForbiddenError(`missing required scope: ${requiredScope}`);
  }

  if (principal.tenantId !== tenantId) {
    request.log.warn({ subject: principal.subject, tenantId }, 'cross-tenant access denied');
    throw new ForbiddenError('not authorised for this tenant');
  }

  return tenantId;
}
