/**
 * Prints a local access token for calling the API by hand.
 *
 *   npm run token                      # tenant agency-a, read + write
 *   npm run token -- agency-b          # a different tenant
 *   npm run token -- platform admin    # ops team, any tenant
 */
import { SignJWT } from 'jose';
import { config } from '../src/config/index.ts';

const [tenantId = 'agency-a', role = 'tenant'] = process.argv.slice(2);

const scope =
  role === 'admin' ? 'platform:admin' : 'ip-allowlist:read ip-allowlist:write';

if (!config.jwt.secret) {
  throw new Error('Set JWT_SECRET (see .env.example) - this script signs HS256 tokens only');
}

const token = await new SignJWT({ tenant_id: tenantId, scope })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(`${role}-local`)
  .setIssuer(config.jwt.issuer)
  .setAudience(config.jwt.audience)
  .setExpirationTime('12h')
  .sign(new TextEncoder().encode(config.jwt.secret));

console.log(token);
