import { jwtVerify } from 'jose';
import type { Config } from '../config/index.ts';
import { tenantOf } from '../config/users.ts';

export type Principal = { userId: string; tenantId: string };
export type TokenVerifier = (token: string) => Promise<Principal>;

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
      // Fixed algorithm - never trust the token header's `alg`.
      algorithms: ['HS256'],
    });

    const userId = String(payload.sub ?? '');
    const tenantId = tenantOf(userId);
    if (!tenantId) throw new Error(`unknown user: ${userId}`);

    return { userId, tenantId };
  };
}
