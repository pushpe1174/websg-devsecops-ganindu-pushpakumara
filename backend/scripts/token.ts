/**
 * Prints an access token for calling the API by hand.
 *
 *   npm run token -- user-a
 *
 * The user must exist in src/config/users.ts; the tenant comes from there.
 */
import { SignJWT } from 'jose';
import { assertConfig, config } from '../src/config/index.ts';
import { tenantOf } from '../src/config/users.ts';

const [userId = 'user-a'] = process.argv.slice(2);

assertConfig(config);

const tenantId = tenantOf(userId);
if (!tenantId) throw new Error(`unknown user: ${userId}`);

const token = await new SignJWT()
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(userId)
  .setIssuer(config.jwt.issuer)
  .setAudience(config.jwt.audience)
  .setExpirationTime('12h')
  .sign(new TextEncoder().encode(config.jwt.secret));

console.error(`${userId} -> ${tenantId}`);
console.log(token);
