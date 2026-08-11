import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Config } from '../config/index.ts';

export type Principal = {
  subject: string;
  tenantId: string;
  scopes: string[];
  isPlatformAdmin: boolean;
};

export type TokenVerifier = (token: string) => Promise<Principal>;

export const ADMIN_SCOPE = 'platform:admin';

/**
 * Builds a verifier for the portal's OIDC access tokens.
 * Prefers a remote JWKS (Cognito user pool); falls back to an HS256 shared
 * secret so the service can run locally and under test without network access.
 */
export function createVerifier(config: Config): TokenVerifier {
  const jwks = config.jwt.jwksUrl ? createRemoteJWKSet(new URL(config.jwt.jwksUrl)) : null;
  const secret = jwks ? null : new TextEncoder().encode(requireSecret(config));

  return async function verify(token) {
    const options = {
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      // Fixed algorithm list - never trust the token header's `alg`.
      algorithms: jwks ? ['RS256'] : ['HS256'],
    };
    const { payload } = jwks
      ? await jwtVerify(token, jwks, options)
      : await jwtVerify(token, secret!, options);

    const tenantId = String(payload.tenant_id ?? payload['custom:tenant_id'] ?? '');
    const scopes = String(payload.scope ?? '').split(' ').filter(Boolean);

    return {
      subject: String(payload.sub ?? ''),
      tenantId,
      scopes,
      isPlatformAdmin: scopes.includes(ADMIN_SCOPE),
    };
  };
}

function requireSecret(config: Config): string {
  if (!config.jwt.secret) {
    throw new Error('Set JWT_JWKS_URL (production) or JWT_SECRET (local/test)');
  }
  return config.jwt.secret;
}
