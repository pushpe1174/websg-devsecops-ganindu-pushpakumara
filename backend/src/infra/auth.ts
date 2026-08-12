import type { FastifyRequest, FastifyReply } from 'fastify';
import { jwtVerify } from 'jose';
import type { Principal } from '../core/allowlist.ts';
import { tenantOf, type Config } from '../config.ts';

export type { Principal };
export type TokenVerifier = (token: string) => Promise<Principal>;

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

/**
 * Verifies a locally issued HS256 token (`npm run token`) and resolves the
 * tenant from the directory: the token proves who you are, the directory decides
 * what you own.
 */
export function createVerifier(config: Config): TokenVerifier {
  if (!config.jwt.secret) throw new Error('JWT_SECRET is required');
  const secret = new TextEncoder().encode(config.jwt.secret);

  return async function verify(token) {
    const { payload } = await jwtVerify(token, secret, {
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      algorithms: ['HS256'],
    });

    const userId = String(payload.sub ?? '');
    const tenantId = tenantOf(userId);
    if (!tenantId) throw new Error(`unknown user: ${userId}`);

    return { userId, tenantId };
  };
}

/** onRequest hook: every route it guards has a principal by the time it runs. */
export function requireAuth(verify: TokenVerifier) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!token) return reply.code(401).send({ error: 'missing bearer token' });

    try {
      request.principal = await verify(token);
    } catch (err) {
      request.log.warn({ reason: (err as Error).message }, 'token rejected');
      return reply.code(401).send({ error: 'invalid token' });
    }
  };
}
