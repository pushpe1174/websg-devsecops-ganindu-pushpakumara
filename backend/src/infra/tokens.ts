import { SignJWT, jwtVerify } from 'jose';
import type { Config } from '../config/index.ts';
import { tenantOf } from '../config/users.ts';
import type { TokenVerifier } from '../domain/ports.ts';

const keyOf = (config: Config) => {
  if (!config.jwt.secret) throw new Error('JWT_SECRET is required');
  return new TextEncoder().encode(config.jwt.secret);
};

/**
 * Verifies a locally issued HS256 token (`npm run token`) and resolves the
 * tenant from the directory: the token proves who you are, the directory decides
 * what you own.
 */
export function createVerifier(config: Config): TokenVerifier {
  const secret = keyOf(config);

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

/** Issues a token for a user the directory already knows. */
export function signToken(config: Config, userId: string, ttl: string): Promise<string> {
  return new SignJWT()
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(config.jwt.issuer)
    .setAudience(config.jwt.audience)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(keyOf(config));
}
