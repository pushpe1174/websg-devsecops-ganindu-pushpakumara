/**
 * Prints an access token for calling the API by hand.
 *
 *   npm run token -- user-a
 *
 * The user must exist in the directory in src/config.ts; the tenant comes from there.
 */
import { SignJWT } from 'jose';
import { assertConfig, config, tenantOf } from '../src/config.ts';

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
